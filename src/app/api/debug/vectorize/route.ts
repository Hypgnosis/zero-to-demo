/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/debug/vectorize
 *
 * Diagnostic: Manually triggers the vectorize step (Step 2)
 * for a given jobId.
 *
 * Usage: POST /api/debug/vectorize { "jobId": "...", "sessionId": "..." }
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { getJob, updateJob, getRedis } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import { encrypt, ensureKeyInitialized } from '@/lib/kms';
import type { VectorMetadata } from '@/lib/types';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_MACRO_TEXT_BYTES = 30_000;
const ENCRYPTION_VERSION = 'v1';
const EXTRACTED_TEXT_PREFIX = 'extracted:';

export async function POST(req: Request) {
  let jobId = '';
  const steps: any[] = [];
  
  try {
    const body = await req.json();
    jobId = body.jobId;
    
    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    const t0 = Date.now();
    const job = await getJob(jobId);
    steps.push({ step: 'getJob', ok: !!job, ms: Date.now() - t0 });
    
    if (!job) {
      return NextResponse.json({ error: 'Job not found', steps }, { status: 404 });
    }

    const { sessionId, fileName, mode, tenantId } = job as any;

    const t1 = Date.now();
    const redis = getRedis();
    const fullText = await redis.get<string>(`${EXTRACTED_TEXT_PREFIX}${jobId}`);
    steps.push({ step: 'getExtractedText', ok: !!fullText, length: fullText?.length, ms: Date.now() - t1 });
    
    if (!fullText) {
      return NextResponse.json({ error: 'Extracted text not found in Redis. Step 1 failed or expired.', steps }, { status: 500 });
    }

    const t2 = Date.now();
    const { microChunks } = splitHierarchical(fullText, fileName);
    steps.push({ step: 'split', ok: true, chunks: microChunks.length, ms: Date.now() - t2 });

    const t3 = Date.now();
    let sessionKeyMaterial = '';
    if (mode === 'governed' && tenantId) {
      sessionKeyMaterial = await ensureKeyInitialized(sessionId, ENCRYPTION_VERSION, tenantId);
    }
    steps.push({ step: 'kms', ok: true, ms: Date.now() - t3 });

    const t4 = Date.now();
    const microTexts = microChunks.map((mc: any) => mc.text);
    const embeddings = await embedTexts(microTexts);
    steps.push({ step: 'embedTexts', ok: true, embeddings: embeddings.length, ms: Date.now() - t4 });

    const t5 = Date.now();
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
        metadata.text = encrypt(mc.text, sessionKeyMaterial);
        metadata.macroText = encrypt(macroText, sessionKeyMaterial);
      }

      return {
        id: `${jobId}-${i}`,
        vector: embeddings[i],
        metadata,
      };
    }));
    steps.push({ step: 'buildVectors', ok: true, vectors: vectors.length, ms: Date.now() - t5 });

    const t6 = Date.now();
    await upsertVectors(sessionId, mode, tenantId, vectors);
    steps.push({ step: 'upsertVectors', ok: true, ms: Date.now() - t6 });

    const t7 = Date.now();
    await updateJob(jobId, {
      status: 'complete',
      totalChunks: microChunks.length,
      completedAt: new Date().toISOString(),
    });
    steps.push({ step: 'updateJob', ok: true, ms: Date.now() - t7 });

    return NextResponse.json({ status: 'ok', steps, totalMs: steps.reduce((a, b) => a + b.ms, 0) });

  } catch (err: any) {
    return NextResponse.json({ error: err.message, stack: err.stack, steps }, { status: 500 });
  }
}
