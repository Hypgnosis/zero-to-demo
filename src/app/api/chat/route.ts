/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/chat
 *
 * Phase 5 — Dual-Mode Enterprise RAG Chat (Hierarchical Small-to-Big)
 *
 * Pipeline:
 * 1. AUTHENTICATES via JWT PEP.
 * 2. Rate-limits by User-ID.
 * 3. Validates request via Zod.
 * 4. Validates session ownership (returns session with mode).
 * 5. Embeds the user's latest message (query vector).
 * 6. QUERIES micro-chunks on the MODE-SPECIFIC physical index.
 * 7. DEDUPLICATES by parentMacroId — collect unique macro sections.
 * 8. RECONSTRUCTS coherent context from full macro-chunk text.
 * 9. Constructs citation-enforced system prompt with structural context.
 * 10. Streams Gemini response.
 *
 * The session's mode (ephemeral/governed) determines which physical
 * vector index is queried. The chat route NEVER needs to resolve
 * mode from a header — it reads it from the session object.
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
import { decryptChunks } from '@/lib/kms';

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
  // 1. AUTHENTICATE — Implicit Deny
  const claims = await authenticateRequest(req);

  // 2. Rate limit by User-ID
  await enforceRateLimit(req, 'chat', claims.userId);

  // 3. Validate request body
  const body = await req.json();
  const parseResult = ChatRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request body.');
  }

  const { sessionId, messages } = parseResult.data;

  // 4. Validate session ownership — returns session with mode
  const session = await validateSessionOwnership(sessionId, claims.userId);
  const { mode } = session;

  // 5. Verify namespace has vectors (on the correct physical index)
  const hasVectors = await namespaceHasVectors(sessionId, mode, claims.tenantId);
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

  // 8. Query micro-chunks on the MODE-SPECIFIC physical index
  const microResults = await queryVectors(sessionId, mode, claims.tenantId, queryVector, MICRO_TOP_K);

  // ═══════════════════════════════════════════════════════════════
  // 9. MULTI-VERSION DECRYPTION LAYER (Phase 3: 2 AM Risk Remedy)
  //
  // For governed sessions, chunks may be encrypted with DIFFERENT
  // key versions (e.g., v1 + v2 mixed during a key rotation).
  // decryptChunks() resolves the correct key PER CHUNK and decrypts
  // each one independently. Chunks with missing keys are gracefully
  // skipped — never passed to the LLM as garbage.
  //
  // For ephemeral sessions, decryption is a NO-OP passthrough.
  // ═══════════════════════════════════════════════════════════════
  let resolvedChunks: typeof microResults;

  if (mode === 'governed') {
    const decrypted = await decryptChunks(sessionId, microResults);
    // Re-map decrypted text back to the original chunk shape for downstream processing
    resolvedChunks = microResults
      .filter((c) => decrypted.some((d) => d.vectorId === c.id))
      .map((c) => {
        const d = decrypted.find((d) => d.vectorId === c.id)!;
        return {
          ...c,
          metadata: { ...c.metadata, text: d.text },
        };
      });
  } else {
    // Ephemeral mode: chunks are plaintext — no decryption overhead
    resolvedChunks = microResults;
  }

  // ═══════════════════════════════════════════════════════════════
  // 10. SMALL-TO-BIG RETRIEVAL (Phase 4: Finding 6 Remedy)
  // ═══════════════════════════════════════════════════════════════
  const macroSections = new Map<string, { text: string; source: string; bestScore: number }>();

  for (const result of resolvedChunks) {
    const { parentMacroId, macroText, source } = result.metadata;

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
  const sortedMacros = Array.from(macroSections.entries())
    .sort((a, b) => b[1].bestScore - a[1].bestScore);

  const contextBlock = sortedMacros
    .map(([macroId, { text, source }], i) => {
      return `[Section ${i + 1}: "${source}" — ${macroId}]\n${text}`;
    })
    .join('\n\n═══════════════════════════════════════\n\n');

  console.log(
    `[Chat] [${mode}] Small-to-Big: ${resolvedChunks.length} micro hits → ${macroSections.size} unique macro sections`
  );

  // 11. Construct system prompt with structural context
  const engineName = mode === 'governed' ? 'Axiom-G' : 'Axiom-0';
  const systemPrompt = `You are ${engineName}, an enterprise intelligence engine built by High Archytech.
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
