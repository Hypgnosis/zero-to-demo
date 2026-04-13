/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/chat
 *
 * Phase 4 — Enterprise RAG Chat (Hierarchical Small-to-Big Retrieval)
 *
 * Pipeline:
 * 1. AUTHENTICATES via JWT PEP (Finding 1 Remedy).
 * 2. Rate-limits by User-ID (Finding 4 Remedy).
 * 3. Validates request via Zod.
 * 4. Validates session ownership.
 * 5. Embeds the user's latest message (query vector).
 * 6. QUERIES micro-chunks (TOP_K=10) for precise matching.
 * 7. DEDUPLICATES by parentMacroId — collect unique macro sections.
 * 8. RECONSTRUCTS coherent context from full macro-chunk text.
 * 9. Constructs citation-enforced system prompt with structural context.
 * 10. Streams Gemini response.
 *
 * Finding 6 Remedy: Gemini receives complete structural sections,
 * not isolated 1000-char fragments. BOM tables, section headers,
 * and multi-column layouts arrive intact.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { GoogleGenAI, type Content } from '@google/genai';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { ChatRequestSchema } from '@/lib/validation';
import { validateSessionOwnership } from '@/lib/redis';
import { embedText } from '@/lib/embeddings';
import { queryVectors, namespaceHasVectors } from '@/lib/vectorClient';

/* ─── Constants ───────────────────────────────────────────────── */

const CHAT_MODEL = 'gemini-2.0-flash';

/**
 * TOP_K for micro-chunk search.
 * We search 10 micro-chunks (500 chars each) for precision,
 * then deduplicate to their parent macro-chunks (~15K chars)
 * for structural context injection.
 */
const MICRO_TOP_K = 10;

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE — Implicit Deny (Finding 1)
  const claims = await authenticateRequest(req);

  // 2. Rate limit by User-ID (Finding 4)
  await enforceRateLimit(req, 'chat', claims.userId);

  // 3. Validate request body
  const body = await req.json();
  const parseResult = ChatRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request body.');
  }

  const { sessionId, messages } = parseResult.data;

  // 4. Validate session ownership (prevents cross-user data access)
  await validateSessionOwnership(sessionId, claims.userId);

  // 5. Verify namespace has vectors
  const hasVectors = await namespaceHasVectors(sessionId);
  if (!hasVectors) {
    throw Errors.noVectorData();
  }

  // 6. Get the user's latest message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    throw Errors.validation('No user message found in history.');
  }

  // 7. Embed the query
  const queryVector = await embedText(lastUserMessage.content);

  // 8. Query micro-chunks (TOP_K=10 for precise matching)
  const microResults = await queryVectors(sessionId, queryVector, MICRO_TOP_K);

  // ═══════════════════════════════════════════════════════════════
  // 9. SMALL-TO-BIG RETRIEVAL (Phase 4: Finding 6 Remedy)
  //
  //    Searched micro-chunks for precision.
  //    Now DEDUPLICATE by parentMacroId and inject the full
  //    structural macro-chunk text into Gemini's context.
  //
  //    This ensures:
  //    - Table headers stay with table data.
  //    - Section context wraps individual data points.
  //    - BOM relationships are never decapitated.
  // ═══════════════════════════════════════════════════════════════
  const macroSections = new Map<string, { text: string; source: string; bestScore: number }>();

  for (const result of microResults) {
    const { parentMacroId, macroText, source } = result.metadata;

    // Deduplicate: keep the highest-scoring version of each macro
    const existing = macroSections.get(parentMacroId);
    if (!existing || result.score > existing.bestScore) {
      macroSections.set(parentMacroId, {
        text: macroText,
        source,
        bestScore: result.score,
      });
    }
  }

  // 10. Build context block from deduplicated macro sections
  //     Sorted by relevance score (highest first).
  const sortedMacros = Array.from(macroSections.entries())
    .sort((a, b) => b[1].bestScore - a[1].bestScore);

  const contextBlock = sortedMacros
    .map(([macroId, { text, source }], i) => {
      return `[Section ${i + 1}: "${source}" — ${macroId}]\n${text}`;
    })
    .join('\n\n═══════════════════════════════════════\n\n');

  console.log(
    `[Chat] Small-to-Big: ${microResults.length} micro hits → ${macroSections.size} unique macro sections`
  );

  // 11. Construct system prompt with structural context
  const systemPrompt = `You are Axiom-0, an enterprise intelligence engine built by High Archytech.
You answer questions ONLY using the provided catalog context. You are precise, authoritative, and concise.

RULES:
1. Base your answers EXCLUSIVELY on the CATALOG CONTEXT below.
2. If the context doesn't contain the answer, say: "This information is not available in the uploaded catalog."
3. ALWAYS cite your sources using [Section N] notation at the end of relevant statements.
4. Never fabricate information or reference external knowledge.
5. When referencing tables, preserve the tabular format in your response.
6. Maintain a professional, enterprise tone.

CATALOG CONTEXT (${macroSections.size} structural sections retrieved):
${contextBlock}`;

  // 12. Build Gemini conversation history
  const conversationHistory: Content[] = messages.slice(0, -1).map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // 13. Initialize Gemini client
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw Errors.configMissing('GOOGLE_API_KEY');
  }

  const ai = new GoogleGenAI({ apiKey });

  // 14. Stream response
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
            maxOutputTokens: 4096,
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
