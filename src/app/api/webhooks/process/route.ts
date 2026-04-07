/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Phase 3 — Background Ingestion Worker (QStash Target)
 *
 * Pipeline:
 * 1. Download PDF from Vercel Blob.
 * 2. Upload to Google GenAI File API (NOT inlineData — avoids 50MB crash).
 * 3. Wait for File API processing to complete.
 * 4. Extract text using Gemini 1.5 Flash multimodal.
 * 5. Chunk extracted text using recursive splitter.
 * 6. Generate embeddings via text-embedding-004.
 * 7. Upsert vectors to Upstash Vector (session namespace).
 * 8. Clean up: delete Vercel Blob + GenAI file.
 * 9. Update job status in Redis.
 *
 * This runs as a serverless function with maxDuration=300 (5 min).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { del as deleteBlob } from '@vercel/blob';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';

import { ProcessDocumentPayloadSchema } from '@/lib/validation';
import { updateJob } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getGenAIClient } from '@/lib/embeddings';
import { splitText } from '@/lib/textSplitter';
import type { VectorMetadata } from '@/lib/types';

/* ─── Vercel Config ───────────────────────────────────────────── */

export const maxDuration = 300; // 5 minutes
export const dynamic = 'force-dynamic';

/* ─── Constants ───────────────────────────────────────────────── */

const EXTRACTION_MODEL = 'gemini-2.0-flash';
const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 90; // 3 minutes max wait
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = verifySignatureAppRouter(async (req: Request): Promise<Response> => {
  let jobId = 'unknown';
  let blobUrlToCleanup: string | null = null;
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

    const { jobId: jid, sessionId, blobUrl, fileName } = parseResult.data;
    jobId = jid;
    blobUrlToCleanup = blobUrl;

    console.log(`[Process] Starting: job=${jobId}, file=${fileName}`);

    // 2. Update status to 'processing'
    await updateJob(jobId, { status: 'processing' });

    // 3. Download file from Vercel Blob
    const fileResponse = await fetch(blobUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download blob: ${fileResponse.status}`);
    }

    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    const fileBlob = new Blob([fileBuffer], { type: 'application/pdf' });

    console.log(`[Process] Downloaded: ${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    // 4. Upload to Google GenAI File API (THE CRITICAL REMEDY)
    const uploadedFile = await ai.files.upload({
      file: fileBlob,
      config: {
        displayName: fileName,
        mimeType: 'application/pdf',
      },
    });

    if (!uploadedFile.name) {
      throw new Error('GenAI File API upload returned no file name.');
    }
    
    genAiFileToCleanup = uploadedFile.name;

    console.log(`[Process] GenAI file uploaded: ${uploadedFile.name}`);

    // 5. Poll until file is ACTIVE
    let fileState = uploadedFile.state;
    let attempts = 0;

    while (fileState === 'PROCESSING' && attempts < FILE_POLL_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
      const polled = await ai.files.get({ name: uploadedFile.name });
      fileState = polled.state;
      attempts++;
    }

    if (fileState !== 'ACTIVE') {
      throw new Error(`GenAI file not ready after polling. State: ${String(fileState)}`);
    }

    console.log(`[Process] GenAI file ACTIVE after ${attempts} polls.`);

    // 6. Extract text using Gemini multimodal
    const extractionResult = await ai.models.generateContent({
      model: EXTRACTION_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: uploadedFile.uri!,
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

    if (!extractedText || extractedText.length < 50) {
      throw new Error('Extraction returned insufficient text. File may be image-only or corrupt.');
    }

    console.log(`[Process] Extracted ${extractedText.length} chars.`);

    // 7. Chunk the extracted text
    const textChunks = splitText(extractedText, fileName, {
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });
    const chunkTexts = textChunks.map((c) => c.text);

    console.log(`[Process] Split into ${textChunks.length} chunks.`);

    // 8. Generate embeddings
    const embeddings = await embedTexts(chunkTexts);

    console.log(`[Process] Generated ${embeddings.length} embeddings.`);

    // 9. Prepare vector records with metadata
    const vectors = chunkTexts.map((text: string, i: number) => ({
      id: `${jobId}-chunk-${i}`,
      vector: embeddings[i]!,
      metadata: {
        source: fileName,
        chunkIndex: i,
        totalChunks: chunkTexts.length,
        text,
      } satisfies VectorMetadata,
    }));

    // 10. Upsert to Upstash Vector (session-scoped namespace)
    await upsertVectors(sessionId, vectors);

    console.log(`[Process] Upserted ${vectors.length} vectors to namespace: ${sessionId}`);

    // 11. Update job as complete
    await updateJob(jobId, {
      status: 'complete',
      totalChunks: chunkTexts.length,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Process] ✅ Job ${jobId} complete.`);
    return NextResponse.json({ status: 'complete', chunks: chunkTexts.length });

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
    // 12. Dead-Letter Queue (DLQ) / Cleanup
    if (blobUrlToCleanup) {
      try {
        await deleteBlob(blobUrlToCleanup);
        console.log(`[Process] Blob deleted: ${blobUrlToCleanup}`);
      } catch (cleanupErr) {
        console.warn('[Process] Blob cleanup failed (non-fatal):', cleanupErr);
      }
    }

    if (genAiFileToCleanup) {
      try {
        await ai.files.delete({ name: genAiFileToCleanup });
        console.log(`[Process] GenAI file deleted: ${genAiFileToCleanup}`);
      } catch (cleanupErr) {
        console.warn('[Process] GenAI file cleanup failed (non-fatal):', cleanupErr);
      }
    }
  }
});
