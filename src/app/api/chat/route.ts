/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/chat
 *
 * Phase 4 — Enterprise RAG Chat
 * 1. Validates request via Zod.
 * 2. Rate-limits by client IP.
 * 3. Embeds the user's latest message.
 * 4. Queries Upstash Vector (session namespace, TOP_K=5).
 * 5. Constructs a citation-enforced system prompt.
 * 6. Streams Gemini response using ReadableStream.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { GoogleGenAI, type Content } from '@google/genai';

import { withErrorHandler, Errors } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rateLimit';
import { ChatRequestSchema } from '@/lib/validation';
import { embedText } from '@/lib/embeddings';
import { queryVectors, namespaceHasVectors } from '@/lib/vectorClient';

/* ─── Constants ───────────────────────────────────────────────── */

const CHAT_MODEL = 'gemini-2.0-flash';
const TOP_K = 5;

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = withErrorHandler(async (req: Request) => {
  // 1. Rate limit
  await enforceRateLimit(req, 'chat');

  // 2. Validate request body
  const body = await req.json();
  const parseResult = ChatRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request body.');
  }

  const { sessionId, messages } = parseResult.data;

  // 3. Verify namespace has vectors
  const hasVectors = await namespaceHasVectors(sessionId);
  if (!hasVectors) {
    throw Errors.noVectorData();
  }

  // 4. Get the user's latest message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    throw Errors.validation('No user message found in history.');
  }

  // 5. Embed the query
  const queryVector = await embedText(lastUserMessage.content);

  // 6. Query Upstash Vector (session-isolated namespace)
  const results = await queryVectors(sessionId, queryVector, TOP_K);

  // 7. Build context block from retrieved chunks
  const contextBlock = results
    .map((r, i) => {
      const meta = r.metadata;
      return `[Source ${i + 1}: "${meta.source}", Chunk ${meta.chunkIndex + 1}/${meta.totalChunks}]\n${meta.text}`;
    })
    .join('\n\n');

  // 8. Construct system prompt with citation enforcement
  const systemPrompt = `You are Axiom-0, an enterprise intelligence engine built by High Archytech.
You answer questions ONLY using the provided catalog context. You are precise, authoritative, and concise.

RULES:
1. Base your answers EXCLUSIVELY on the CATALOG CONTEXT below.
2. If the context doesn't contain the answer, say: "This information is not available in the uploaded catalog."
3. ALWAYS cite your sources using [Source N] notation at the end of relevant statements.
4. Never fabricate information or reference external knowledge.
5. Maintain a professional, enterprise tone.

CATALOG CONTEXT:
${contextBlock}`;

  // 9. Build Gemini conversation history
  const conversationHistory: Content[] = messages.slice(0, -1).map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // 10. Initialize Gemini client
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw Errors.configMissing('GOOGLE_API_KEY');
  }

  const ai = new GoogleGenAI({ apiKey });

  // 11. Stream response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        const response = await ai.models.generateContentStream({
          model: CHAT_MODEL,
          contents: [
            ...conversationHistory,
            {
              role: 'user',
              parts: [{ text: lastUserMessage.content }],
            },
          ],
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.3,
            maxOutputTokens: 2048,
          },
        });

        for await (const chunk of response) {
          const text = chunk.text;
          if (text) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`)
            );
          }
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        );
      } catch (error: unknown) {
        console.error('[Chat] Stream error:', error);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', error: 'Generation failed.' })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
