/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Phase 4 — Ghost Pipeline Worker + Hierarchical RAG
 *
 * ZERO-RETENTION + INDUSTRIAL PRECISION:
 * No Vercel Blob. No file download from our infrastructure.
 * Uses Small-to-Big hierarchical chunking for enterprise RAG.
 *
 * Pipeline:
 * 1. Validate QStash payload (genAiFileName reference).
 * 2. Check if GenAI file exists (2 AM resilience guard).
 * 3. Poll for ACTIVE state.
 * 4. Extract text using Gemini multimodal.
 * 5. HIERARCHICAL SPLIT: macro chunks (structural) + micro chunks (search).
 * 6. Embed MICRO chunks only (500 chars for precise matching).
 * 7. Upsert vectors with macro parent text in metadata (one-shot retrieval).
 * 8. Update job status.
 * 9. MANDATORY PURGE: Delete GenAI file in `finally` block.
 *
 * Finding 2 Remedy: Ghost Pipeline (Phase 2).
 * Finding 6 Remedy: Hierarchical RAG — tables never decapitated (Phase 4).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';

import { ProcessDocumentPayloadSchema } from '@/lib/validation';
import { updateJob } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getGenAIClient } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import type { VectorMetadata } from '@/lib/types';

/* ─── Vercel Config ───────────────────────────────────────────── */

export const maxDuration = 300; // 5 minutes
export const dynamic = 'force-dynamic';

/* ─── Constants ───────────────────────────────────────────────── */

const EXTRACTION_MODEL = 'gemini-2.0-flash';
const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 90; // 3 minutes max wait

/**
 * Upstash Vector metadata size limit is ~48KB.
 * A 15K-char macro block is ~15-30KB depending on encoding.
 * We cap at 40KB to leave headroom for other metadata fields.
 */
const MAX_MACRO_TEXT_BYTES = 40_000;

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = verifySignatureAppRouter(async (req: Request): Promise<Response> => {
  let jobId = 'unknown';
  let genAiFileToCleanup: string | null = null;
  const ai = getGenAIClient();

  try {
    // 1. Validate QStash payload
    const body = await req.json();
    const parseResult = ProcessDocumentPayloadSchema.safeParse(body);

    if (!parseResult.success) {
      console.error('[Process] Invalid payload:', parseResult.error.flatten());
      return NextResponse.json(
        { error: 'Invalid payload' },
        { status: 400 }
      );
    }

    const { jobId: jid, sessionId, genAiFileName, fileName } = parseResult.data;
    jobId = jid;
    genAiFileToCleanup = genAiFileName;

    console.log(`[Process] Starting: job=${jobId}, file=${fileName}, genAiRef=${genAiFileName}`);

    // 2. Update status to 'processing'
    await updateJob(jobId, { status: 'processing' });

    // ─────────────────────────────────────────────────────────────
    // 3. 2 AM RESILIENCE: Verify GenAI file still exists.
    //    On QStash retry, the file might have been purged by the
    //    previous attempt's `finally` block or by Google's 48h TTL.
    //    If the file is gone, fail fast with a clear error.
    // ─────────────────────────────────────────────────────────────
    let polledFile;
    try {
      polledFile = await ai.files.get({ name: genAiFileName });
    } catch (fileCheckErr) {
      throw new Error(
        `GenAI file "${genAiFileName}" no longer exists. ` +
        `It may have been purged by a previous run or expired (48h TTL). ` +
        `The client must re-upload.`
      );
    }

    // 4. Poll until file is ACTIVE (if still processing)
    let fileState = polledFile.state;
    let attempts = 0;

    while (fileState === 'PROCESSING' && attempts < FILE_POLL_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
      const refreshed = await ai.files.get({ name: genAiFileName });
      fileState = refreshed.state;
      attempts++;
    }

    if (fileState !== 'ACTIVE') {
      throw new Error(`GenAI file not ready after polling. State: ${String(fileState)}`);
    }

    console.log(`[Process] GenAI file ACTIVE after ${attempts} polls.`);

    // 5. Extract text using Gemini multimodal
    //    Uses fileData reference — NO data downloaded to our servers.
    const polledForUri = await ai.files.get({ name: genAiFileName });
    const extractionStart = Date.now();
    const extractionResult = await ai.models.generateContent({
      model: EXTRACTION_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: polledForUri.uri!,
                mimeType: 'application/pdf',
              },
            },
            {
              text: `You are a precise document extraction engine. Extract ALL text content from this PDF document.

RULES:
- Preserve the original structure: headings, lists, tables, paragraphs.
- DO NOT summarize. Extract verbatim text.
- If the document contains tables, format them as markdown tables.
- If text is in multiple columns, extract left column first, then right.
- Include all headers, footers, captions, and footnotes.
- Output ONLY the extracted text — no commentary.`,
            },
          ],
        },
      ],
    });

    const extractedText = extractionResult.text ?? '';

    const extractionTimeMs = Date.now() - extractionStart;

    // ─── CAD/Graphics PDF Guard ───────────────────────────────────
    // If Gemini returns empty or near-empty text, the PDF is likely
    // vector graphics (CAD drawings, scanned blueprints without OCR).
    // Fail with a specific, actionable error — not a generic 500.
    if (!extractedText || extractedText.length < 50) {
      const isCompletelyEmpty = !extractedText || extractedText.trim().length === 0;
      throw new Error(
        isCompletelyEmpty
          ? 'Unsupported PDF content: This file appears to contain only graphics or images (e.g., CAD drawings). ' +
            'Axiom-0 requires text-based documents. Please upload a text-searchable PDF.'
          : `Extraction returned insufficient text (${extractedText.length} chars). ` +
            'The file may be primarily images, scanned without OCR, or corrupt.'
      );
    }

    console.info(
      `[Process] ⏱️ TELEMETRY: extraction_time_ms=${extractionTimeMs}, ` +
      `extracted_chars=${extractedText.length}`
    );

    // ═══════════════════════════════════════════════════════════════
    // 6. HIERARCHICAL SPLIT (Phase 4: Small-to-Big)
    //    - Macro chunks: ~15K chars, structural sections/tables
    //    - Micro chunks: ~500 chars, high-density search targets
    //    - Each micro carries its parent macro's full text
    // ═══════════════════════════════════════════════════════════════
    const { macroChunks, microChunks } = splitHierarchical(extractedText, fileName);

    console.log(
      `[Process] Hierarchical split: ${macroChunks.length} macro chunks, ${microChunks.length} micro chunks.`
    );

    // 7. Embed MICRO chunks only (search precision)
    const microTexts = microChunks.map((m) => m.text);
    const embeddingStart = Date.now();
    const embeddings = await embedTexts(microTexts);
    const embeddingTimeMs = Date.now() - embeddingStart;

    console.info(
      `[Process] ⏱️ TELEMETRY: embedding_time_ms=${embeddingTimeMs}, ` +
      `embedding_tokens_count=${microTexts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)}, ` +
      `micro_chunks=${microChunks.length}`
    );

    // 8. Prepare vector records with hierarchical metadata
    //    parentMacroId + macroText travel WITH each vector.
    //    At query time, the chat route deduplicates by parentMacroId
    //    and injects the full macroText into Gemini's context.
    //
    //    METADATA BLOAT GUARD: Truncate macroText to MAX_MACRO_TEXT_BYTES
    //    to prevent Upstash 413 Payload Too Large on upsert.
    const vectors = microChunks.map((micro, i) => {
      let macroText = micro.parentMacroText;
      const macroBytes = new TextEncoder().encode(macroText).length;
      if (macroBytes > MAX_MACRO_TEXT_BYTES) {
        // Truncate with a marker so the chat route knows context was clipped
        const truncated = macroText.slice(0, MAX_MACRO_TEXT_BYTES - 100);
        macroText = truncated + '\n\n[... section truncated for storage limits ...]';
        console.warn(
          `[Process] ⚠️ Macro ${micro.parentMacroId} truncated: ${macroBytes} bytes → ${MAX_MACRO_TEXT_BYTES} bytes`
        );
      }

      return {
        id: `${jobId}-micro-${i}`,
        vector: embeddings[i]!,
        metadata: {
          source: fileName,
          chunkIndex: micro.metadata.chunkIndex,
          totalChunks: micro.metadata.totalChunks,
          text: micro.text,
          parentMacroId: micro.parentMacroId,
          macroText,
        } satisfies VectorMetadata,
      };
    });

    // 9. Upsert to Upstash Vector (session-scoped namespace)
    await upsertVectors(sessionId, vectors);

    console.log(`[Process] Upserted ${vectors.length} vectors to namespace: ${sessionId}`);

    // 10. Update job as complete
    await updateJob(jobId, {
      status: 'complete',
      totalChunks: microChunks.length,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Process] ✅ Job ${jobId} complete (${macroChunks.length} macros, ${microChunks.length} micros).`);
    return NextResponse.json({
      status: 'complete',
      macroChunks: macroChunks.length,
      microChunks: microChunks.length,
    });

  } catch (error: unknown) {
    console.error(`[Process] ❌ Job ${jobId} failed:`, error);

    // Update job as failed
    try {
      if (jobId !== 'unknown') {
        await updateJob(jobId, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } catch (updateErr) {
      console.error('[Process] Failed to update job status:', updateErr);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Processing failed' },
      { status: 500 }
    );
  } finally {
    // ═══════════════════════════════════════════════════════════════
    // MANDATORY PURGE — The Legal Shield (Cryptographic Erasure)
    //
    // This block runs regardless of success or failure.
    // It eliminates the GenAI file from Google's temporary storage.
    // Without this, proprietary data lingers for up to 48 hours.
    //
    // If this block fails (network partition, quota error),
    // the cleanup cron provides a secondary sweep (Phase 2 defense).
    // ═══════════════════════════════════════════════════════════════
    if (genAiFileToCleanup) {
      try {
        await ai.files.delete({ name: genAiFileToCleanup });
        console.log(`[Process] 🗑️ GenAI file purged: ${genAiFileToCleanup}`);
      } catch (cleanupErr) {
        // NON-FATAL: The cleanup cron will catch orphans.
        // Log as ERROR (not warn) because this is a data sovereignty concern.
        console.error(
          `[Process] ⚠️ GenAI file cleanup FAILED for ${genAiFileToCleanup}. ` +
          `Cleanup cron will handle orphan purge.`,
          cleanupErr
        );
      }
    }
  }
});
