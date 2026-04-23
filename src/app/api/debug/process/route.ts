/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/debug/process
 *
 * Diagnostic: Manually triggers the webhook processing logic
 * for a given jobId, bypassing QStash entirely.
 * This isolates whether the issue is QStash delivery vs processing.
 *
 * Usage: POST /api/debug/process { "jobId": "..." }
 *
 * DELETE THIS FILE after debugging is complete.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { getJob, updateJob } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getApiKey, getGenAIFile, deleteGenAIFile } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import { encrypt, ensureKeyInitialized } from '@/lib/kms';
import type { VectorMetadata } from '@/lib/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const EXTRACTION_MODEL = 'gemini-2.5-flash';
const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 90;
const MAX_MACRO_TEXT_BYTES = 30_000;
const ENCRYPTION_VERSION = 'v1';

export async function POST(req: Request) {
  const steps: { step: string; ok: boolean; detail?: string; ms?: number }[] = [];
  let jobId = '';

  try {
    const body = await req.json();
    jobId = body.jobId;

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    // Step 1: Read job from Redis
    const t0 = Date.now();
    const job = await getJob(jobId);
    steps.push({ step: 'redis_get_job', ok: !!job, detail: job ? `file=${job.fileName}, mode=${job.mode}, status=${job.status}` : 'Job not found', ms: Date.now() - t0 });

    if (!job) {
      return NextResponse.json({ error: 'Job not found in Redis', steps }, { status: 404 });
    }

    const { sessionId, genAiFileName, fileName, mode, tenantId } = job as any;

    // Step 2: Poll GenAI file for ACTIVE state
    const t1 = Date.now();
    let attempts = 0;
    let fileInfo;
    try {
      fileInfo = await getGenAIFile(genAiFileName);
      while (fileInfo.state !== 'ACTIVE' && attempts < FILE_POLL_MAX_ATTEMPTS) {
        if (fileInfo.state === 'FAILED') throw new Error('File processing FAILED on Google side.');
        attempts++;
        await new Promise(r => setTimeout(r, FILE_POLL_INTERVAL_MS));
        fileInfo = await getGenAIFile(genAiFileName);
      }
      steps.push({ step: 'file_poll', ok: fileInfo.state === 'ACTIVE', detail: `state=${fileInfo.state}, attempts=${attempts}, uri=${fileInfo.uri}`, ms: Date.now() - t1 });
    } catch (err: any) {
      steps.push({ step: 'file_poll', ok: false, detail: err.message, ms: Date.now() - t1 });
      return NextResponse.json({ error: 'File poll failed', steps }, { status: 500 });
    }

    if (fileInfo.state !== 'ACTIVE') {
      return NextResponse.json({ error: `File not ACTIVE after ${attempts} attempts`, steps }, { status: 500 });
    }

    // Step 3: Extract content via direct REST
    const t2 = Date.now();
    let fullText: string;
    try {
      const apiKey = getApiKey();
      const generateRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTION_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { fileData: { mimeType: fileInfo.mimeType, fileUri: fileInfo.uri } },
                { text: 'Extract the full text of this document. Preserve structure including headers, tables, and lists. No commentary.' },
              ],
            }],
          }),
        }
      );

      if (!generateRes.ok) {
        const errText = await generateRes.text();
        steps.push({ step: 'extract_content', ok: false, detail: `HTTP ${generateRes.status}: ${errText.substring(0, 500)}`, ms: Date.now() - t2 });
        return NextResponse.json({ error: 'Extraction failed', steps }, { status: 500 });
      }

      const extractionData = await generateRes.json();
      fullText = extractionData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!fullText) {
        steps.push({ step: 'extract_content', ok: false, detail: 'No text in response. Full response: ' + JSON.stringify(extractionData).substring(0, 500), ms: Date.now() - t2 });
        return NextResponse.json({ error: 'No text extracted', steps }, { status: 500 });
      }
      steps.push({ step: 'extract_content', ok: true, detail: `${fullText.length} chars extracted`, ms: Date.now() - t2 });
    } catch (err: any) {
      steps.push({ step: 'extract_content', ok: false, detail: err.message, ms: Date.now() - t2 });
      return NextResponse.json({ error: 'Extraction crashed', steps }, { status: 500 });
    }

    // Step 4: Hierarchical split
    const t3 = Date.now();
    let microChunks: any[];
    try {
      const result = splitHierarchical(fullText, fileName);
      microChunks = result.microChunks;
      steps.push({ step: 'split', ok: true, detail: `${microChunks.length} micro-chunks`, ms: Date.now() - t3 });
    } catch (err: any) {
      steps.push({ step: 'split', ok: false, detail: err.message, ms: Date.now() - t3 });
      return NextResponse.json({ error: 'Split failed', steps }, { status: 500 });
    }

    // Step 5: Encrypt (if governed)
    if (mode === 'governed' && tenantId) {
      const t4 = Date.now();
      try {
        await ensureKeyInitialized(tenantId);
        steps.push({ step: 'kms_init', ok: true, ms: Date.now() - t4 });
      } catch (err: any) {
        steps.push({ step: 'kms_init', ok: false, detail: err.message, ms: Date.now() - t4 });
        return NextResponse.json({ error: 'KMS init failed', steps }, { status: 500 });
      }
    }

    // Step 6: Embed
    const t5 = Date.now();
    let embeddings: number[][];
    try {
      const microTexts = microChunks.map((mc: any) => mc.text);
      embeddings = await embedTexts(microTexts);
      steps.push({ step: 'embed', ok: true, detail: `${embeddings.length} embeddings, dim=${embeddings[0]?.length}`, ms: Date.now() - t5 });
    } catch (err: any) {
      steps.push({ step: 'embed', ok: false, detail: err.message, ms: Date.now() - t5 });
      return NextResponse.json({ error: 'Embedding failed', steps }, { status: 500 });
    }

    // Step 7: Build vectors and upsert
    const t6 = Date.now();
    try {
      const vectors = await Promise.all(microChunks.map(async (mc: any, i: number) => {
        let macroText = mc.parentMacroText;
        if (macroText.length > MAX_MACRO_TEXT_BYTES) {
          macroText = macroText.substring(0, MAX_MACRO_TEXT_BYTES) + '… [Truncated]';
        }

        const metadata: VectorMetadata = {
          source: mc.metadata.source,
          chunkIndex: mc.metadata.chunkIndex,
          totalChunks: mc.metadata.totalChunks,
          text: mc.text,
          parentMacroId: mc.parentMacroId,
          macroText,
        };

        if (mode === 'governed' && tenantId) {
          metadata.encryptionVersion = ENCRYPTION_VERSION;
          metadata.text = await encrypt(tenantId, mc.text);
          metadata.macroText = await encrypt(tenantId, macroText);
        }

        return {
          id: `${jobId}-${i}`,
          vector: embeddings[i],
          metadata,
        };
      }));

      await upsertVectors(sessionId, mode, tenantId, vectors);
      steps.push({ step: 'upsert_vectors', ok: true, detail: `${vectors.length} vectors upserted`, ms: Date.now() - t6 });
    } catch (err: any) {
      steps.push({ step: 'upsert_vectors', ok: false, detail: err.message, ms: Date.now() - t6 });
      return NextResponse.json({ error: 'Vector upsert failed', steps }, { status: 500 });
    }

    // Step 8: Update job status
    const t7 = Date.now();
    try {
      await updateJob(jobId, { status: 'complete', completedAt: new Date().toISOString() });
      steps.push({ step: 'update_job', ok: true, ms: Date.now() - t7 });
    } catch (err: any) {
      steps.push({ step: 'update_job', ok: false, detail: err.message, ms: Date.now() - t7 });
    }

    // Step 9: Cleanup file
    try {
      await deleteGenAIFile(genAiFileName);
      steps.push({ step: 'cleanup_file', ok: true });
    } catch (err: any) {
      steps.push({ step: 'cleanup_file', ok: false, detail: err.message });
    }

    return NextResponse.json({
      status: 'complete',
      jobId,
      steps,
      totalTimeMs: steps.reduce((sum, s) => sum + (s.ms || 0), 0),
    });

  } catch (err: any) {
    return NextResponse.json({
      error: err.message,
      jobId,
      steps,
    }, { status: 500 });
  }
}
