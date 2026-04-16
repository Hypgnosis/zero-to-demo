/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Phase 5 — Dual-Mode Document Processor (Hierarchical RAG)
 *
 * ZERO-RETENTION + INDUSTRIAL PRECISION:
 * No Vercel Blob. No file download from our infrastructure.
 * Uses Small-to-Big hierarchical chunking for enterprise RAG.
 *
 * MODE ROUTING:
 * The `mode` field in the QStash payload determines which physical
 * vector index receives the embedded chunks. Governed chunks also
 * receive an `encryptionVersion` tag for BYOK compliance.
 *
 * Pipeline:
 * 1. Validate QStash payload (includes mode).
 * 2. Check if GenAI file exists (2 AM resilience guard).
 * 3. Poll for ACTIVE state.
 * 4. Extract text using Gemini multimodal.
 * 5. HIERARCHICAL SPLIT: macro chunks (structural) + micro chunks (search).
 * 6. Embed MICRO chunks only (500 chars for precise matching).
 * 7. Tag governed metadata with encryptionVersion.
 * 8. Upsert vectors to mode-specific physical index.
 * 9. Update job status.
 * 10. MANDATORY PURGE: Delete GenAI file in `finally` block (BOTH modes).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';

import { ProcessDocumentPayloadSchema } from '@/lib/validation';
import { updateJob } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getGenAIClient } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import { encrypt, ensureKeyInitialized } from '@/lib/kms';
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
 * Cap at 30KB for plaintext to allow for ~33% Base64 encryption overhead
 * and additional metadata fields.
 */
const MAX_MACRO_TEXT_BYTES = 30_000;

/**
 * Phase 5: Default encryption version for governed chunks.
 * In production, this would be derived from the tenant's key vault.
 * For now, v1 signals "first-generation encryption applied".
 */
const DEFAULT_ENCRYPTION_VERSION = 'v1';

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

    const { jobId: jid, sessionId, genAiFileName, fileName, mode } = parseResult.data;
    jobId = jid;
    genAiFileToCleanup = genAiFileName;

    console.log(`[Process] Starting [${mode}]: job=${jobId}, file=${fileName}, genAiRef=${genAiFileName}`);

    // 2. Update status to 'processing'
    await updateJob(jobId, { status: 'processing' });

    // ─────────────────────────────────────────────────────────────
    // 3. 2 AM RESILIENCE: Verify GenAI file still exists.
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

    // 4. Poll until file is ACTIVE
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
    if (!extractedText || extractedText.length < 50) {
      const isCompletelyEmpty = !extractedText || extractedText.trim().length === 0;
      throw new Error(
        isCompletelyEmpty
          ? 'Unsupported PDF content: This file appears to contain only graphics or images (e.g., CAD drawings). ' +
            'Axiom requires text-based documents. Please upload a text-searchable PDF.'
          : `Extraction returned insufficient text (${extractedText.length} chars). ` +
            'The file may be primarily images, scanned without OCR, or corrupt.'
      );
    }

    console.info(
      `[Process] ⏱️ TELEMETRY [${mode}]: extraction_time_ms=${extractionTimeMs}, ` +
      `extracted_chars=${extractedText.length}`
    );

    // ═══════════════════════════════════════════════════════════════
    // 6. HIERARCHICAL SPLIT (Phase 4: Small-to-Big)
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
      `[Process] ⏱️ TELEMETRY [${mode}]: embedding_time_ms=${embeddingTimeMs}, ` +
      `embedding_tokens_count=${microTexts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)}, ` +
      `micro_chunks=${microChunks.length}`
    );

    // ═══════════════════════════════════════════════════════════════
    // 8. DATA SOVEREIGNTY: Initialize Encryption Key
    //
    // For governed mode, we ensure a v1 DEK (Data Encryption Key)
    // exists for this session. The key is stored in Redis under
    // envelope encryption (multi-tenant protection).
    // ═══════════════════════════════════════════════════════════════
    let encryptionKey: string | null = null;
    if (mode === 'governed') {
      encryptionKey = await ensureKeyInitialized(sessionId, DEFAULT_ENCRYPTION_VERSION);
    }

    // ═══════════════════════════════════════════════════════════════
    // 9. PREPARE VECTOR RECORDS WITH MODE-AWARE METADATA
    //
    //    Governed chunks are ENCRYPTED (AES-256-GCM) before upload.
    //    Ephemeral chunks remain PLAINTEXT for demo performance.
    // ═══════════════════════════════════════════════════════════════
    const vectors = microChunks.map((micro, i) => {
      let macroText = micro.parentMacroText;
      let microText = micro.text;

      const macroBytes = new TextEncoder().encode(macroText).length;
      if (macroBytes > MAX_MACRO_TEXT_BYTES) {
        const truncated = macroText.slice(0, MAX_MACRO_TEXT_BYTES - 100);
        macroText = truncated + '\n\n[... section truncated for storage limits ...]';
        console.warn(
          `[Process] ⚠️ Macro ${micro.parentMacroId} truncated: ${macroBytes} bytes → ${MAX_MACRO_TEXT_BYTES} bytes`
        );
      }

      // Apply Phase 4 Encryption for Governed Mode
      if (mode === 'governed' && encryptionKey) {
        try {
          microText = encrypt(microText, encryptionKey);
          macroText = encrypt(macroText, encryptionKey);
        } catch (encErr) {
          console.error(`[Process] 🚨 Encryption failed for chunk ${i}:`, encErr);
          throw new Error('Critical failure: Could not encrypt governed data.');
        }
      }

      const metadata: VectorMetadata = {
        source: fileName,
        chunkIndex: micro.metadata.chunkIndex,
        totalChunks: micro.metadata.totalChunks,
        text: microText,
        parentMacroId: micro.parentMacroId,
        macroText,
        // Phase 5: BYOK tagging. Governed = versioned. Ephemeral = undefined.
        encryptionVersion: mode === 'governed' ? DEFAULT_ENCRYPTION_VERSION : undefined,
      };

      return {
        id: `${jobId}-micro-${i}`,
        vector: embeddings[i]!,
        metadata,
      };
    });

    // 9. Upsert to mode-specific physical vector index
    await upsertVectors(sessionId, mode, vectors);

    console.log(`[Process] Upserted ${vectors.length} vectors [${mode}] for session: ${sessionId}`);

    // 10. Update job as complete
    await updateJob(jobId, {
      status: 'complete',
      totalChunks: microChunks.length,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Process] ✅ Job ${jobId} [${mode}] complete (${macroChunks.length} macros, ${microChunks.length} micros).`);
    return NextResponse.json({
      status: 'complete',
      mode,
      macroChunks: macroChunks.length,
      microChunks: microChunks.length,
    });

  } catch (error: unknown) {
    console.error(`[Process] ❌ Job ${jobId} failed:`, error);

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
    // This block runs regardless of success or failure, for BOTH modes.
    // GenAI files are TRANSIENT in both ephemeral and governed pipelines.
    // The permanent store is the vector index, not the file cache.
    // ═══════════════════════════════════════════════════════════════
    if (genAiFileToCleanup) {
      try {
        await ai.files.delete({ name: genAiFileToCleanup });
        console.log(`[Process] 🗑️ GenAI file purged: ${genAiFileToCleanup}`);
      } catch (cleanupErr) {
        console.error(
          `[Process] ⚠️ GenAI file cleanup FAILED for ${genAiFileToCleanup}. ` +
          `Cleanup cron will handle orphan purge.`,
          cleanupErr
        );
      }
    }
  }
});
