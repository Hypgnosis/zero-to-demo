/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Phase 6 — Two-Step Background Processor (Netlify-Compatible)
 *
 * Netlify serverless functions have a hard 10-26s timeout.
 * Processing a PDF (extract + embed + upsert) exceeds this.
 *
 * SOLUTION: Split into two QStash-chained steps:
 *
 *   Step 1 (this handler, step=extract):
 *     - Poll GenAI file → ACTIVE
 *     - Extract text via Gemini REST
 *     - Store extracted text in Redis
 *     - Publish Step 2 to QStash
 *     - Target time: <15s
 *
 *   Step 2 (this handler, step=vectorize):
 *     - Read extracted text from Redis
 *     - Hierarchical split
 *     - Embed chunks via REST
 *     - Upsert to vector DB
 *     - Update job status → complete
 *     - Target time: <15s
 *
 * Uses direct REST for ALL GenAI operations (AQ key compat).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { Client as QStashClient } from '@upstash/qstash';

import { updateJob, getRedis } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getApiKey, getGenAIFile, deleteGenAIFile } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import { encrypt, ensureKeyInitialized } from '@/lib/kms';
import { CONFIG } from '@/lib/config';
import type { VectorMetadata, AxiomMode } from '@/lib/types';

/* ─── Config (Overrides via CONFIG) ────────────────────────── */

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 5; // Max 10s polling — tight for Netlify
const ENCRYPTION_VERSION = 'v1';

/**
 * Redis key for storing extracted text between Step 1 and Step 2.
 * TTL: 10 minutes (more than enough for QStash to deliver Step 2).
 */
const EXTRACTED_TEXT_PREFIX = 'extracted:';
const EXTRACTED_TEXT_TTL = 600; // 10 minutes

/* ─── Redis helpers for intermediate text storage ─────────────── */



async function storeExtractedText(jobId: string, text: string): Promise<void> {
  const redis = getRedis();
  await redis.set(`${EXTRACTED_TEXT_PREFIX}${jobId}`, text, { ex: EXTRACTED_TEXT_TTL });
}

async function getExtractedText(jobId: string): Promise<string | null> {
  const redis = getRedis();
  const data = await redis.get<string>(`${EXTRACTED_TEXT_PREFIX}${jobId}`);
  return data;
}

async function deleteExtractedText(jobId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${EXTRACTED_TEXT_PREFIX}${jobId}`);
}

/* ─── Step 1: Extract ─────────────────────────────────────────── */

async function handleExtract(payload: {
  jobId: string;
  sessionId: string;
  genAiFileName: string;
  fileName: string;
  mode: AxiomMode;
  tenantId?: string;
}) {
  const { jobId, sessionId, genAiFileName, fileName, mode, tenantId } = payload;
  console.log(`[Processor:Extract] Start: job=${jobId} file=${fileName}`);

  try {
    // 1. Update status to processing
    await updateJob(jobId, { status: 'processing' });

    // 2. Poll for ACTIVE state (tight loop — max 10s)
    let attempts = 0;
    let fileInfo = await getGenAIFile(genAiFileName);

    while (fileInfo.state !== 'ACTIVE' && attempts < FILE_POLL_MAX_ATTEMPTS) {
      if (fileInfo.state === 'FAILED') {
        throw new Error('GenAI File processing failed on Google side.');
      }
      attempts++;
      await new Promise(r => setTimeout(r, FILE_POLL_INTERVAL_MS));
      fileInfo = await getGenAIFile(genAiFileName);
    }

    if (fileInfo.state !== 'ACTIVE') {
      throw new Error(`File poll timeout after ${attempts} attempts (state: ${fileInfo.state}).`);
    }

    console.log(`[Processor:Extract] File ACTIVE after ${attempts} polls.`);

    // 3. Extract content via Gemini REST
    const apiKey = getApiKey();
    const generateRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODELS.EXTRACTOR}:generateContent?key=${apiKey}`,
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
      throw new Error(`GenAI extraction failed (${generateRes.status}): ${errText}`);
    }

    const extractionData = await generateRes.json();
    const fullText = extractionData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!fullText) throw new Error('No text extracted from document.');

    console.log(`[Processor:Extract] Extracted ${fullText.length} chars.`);

    // 4. Store extracted text in Redis (intermediate state)
    await storeExtractedText(jobId, fullText);

    // 5. Publish Step 2 (vectorize) to QStash
    const qstashToken = process.env.QSTASH_TOKEN;
    if (!qstashToken) throw new Error('QSTASH_TOKEN not set');

    const qstash = new QStashClient({ token: qstashToken });

    await qstash.publishJSON({
      url: `${CONFIG.baseUrl}/api/webhooks/process`,
      body: {
        step: 'vectorize',
        jobId,
        sessionId,
        genAiFileName,
        fileName,
        mode,
        tenantId,
      },
      retries: 2,
    });

    console.log(`[Processor:Extract] ✅ Step 1 complete. Published Step 2.`);
    return NextResponse.json({ status: 'step1_complete' });

  } catch (err: any) {
    console.error(`[Processor:Extract] 🚨 Fatal: job=${jobId}:`, err);
    await updateJob(jobId, { status: 'failed', error: err.message }).catch(() => {});
    // Still try to clean up the file
    try { await deleteGenAIFile(genAiFileName); } catch {}
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/* ─── Step 2: Vectorize ───────────────────────────────────────── */

async function handleVectorize(payload: {
  jobId: string;
  sessionId: string;
  genAiFileName: string;
  fileName: string;
  mode: AxiomMode;
  tenantId?: string;
}) {
  const { jobId, sessionId, genAiFileName, fileName, mode, tenantId } = payload;
  console.log(`[Processor:Vectorize] Start: job=${jobId} file=${fileName}`);

  try {
    // 1. Read extracted text from Redis
    const fullText = await getExtractedText(jobId);
    if (!fullText) {
      throw new Error('Extracted text not found in Redis. Step 1 may have failed.');
    }

    // 2. Hierarchical Split
    const { microChunks } = splitHierarchical(fullText, fileName);
    console.log(`[Processor:Vectorize] Split into ${microChunks.length} micro-chunks.`);

    // 3. Encrypt (governed mode)
    let sessionKeyMaterial = '';
    if (mode === 'governed' && tenantId) {
      sessionKeyMaterial = await ensureKeyInitialized(sessionId, ENCRYPTION_VERSION, tenantId);
    }

    // 4. Embed
    const microTexts = microChunks.map(mc => mc.text);
    const embeddings = await embedTexts(microTexts);

    // 5. Build vectors
    const vectors = await Promise.all(microChunks.map(async (mc, i) => {
      let macroText = mc.parentMacroText;
      if (macroText.length > CONFIG.MAX_MACRO_TEXT_BYTES) {
        macroText = macroText.substring(0, CONFIG.MAX_MACRO_TEXT_BYTES) + '… [Truncated]';
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

    // 6. Upsert
    await upsertVectors(sessionId, mode, tenantId, vectors);

    // 7. Complete Job
    await updateJob(jobId, {
      status: 'complete',
      totalChunks: microChunks.length,
      completedAt: new Date().toISOString(),
    });

    console.log(`[Processor:Vectorize] ✅ Completed: job=${jobId}, chunks=${microChunks.length}`);
    return NextResponse.json({ status: 'ok' });

  } catch (err: any) {
    console.error(`[Processor:Vectorize] 🚨 Fatal: job=${jobId}:`, err);
    await updateJob(jobId, { status: 'failed', error: err.message }).catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    // MANDATORY PURGE — Ghost Pipeline cleanup
    try {
      await deleteGenAIFile(genAiFileName);
      console.log(`[Processor] Ghost Pipeline: Purged ${genAiFileName}`);
    } catch (e) {
      console.warn(`[Processor] Failed to purge ${genAiFileName}:`, e);
    }
    // Clean up intermediate Redis key
    try {
      await deleteExtractedText(jobId);
    } catch {}
  }
}

/* ─── Main Handler (Routes by step) ──────────────────────────── */

async function handler(req: Request) {
  const body = await req.json();

  // Route to the correct step
  const step = body.step || 'extract'; // Default: Step 1 (legacy compat)

  if (step === 'vectorize') {
    return handleVectorize(body);
  }

  // Step 1: extract (default for new uploads from /api/upload)
  return handleExtract(body);
}

/* ─── QStash Signature Verification ──────────────────────────── */

export const POST = async (req: Request) => {
  const qCurrent = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const qNext = process.env.QSTASH_NEXT_SIGNING_KEY;

  // Skip verification in dev / if keys not configured
  if (!qCurrent || !qNext || qCurrent === 'dummy' || qNext === 'dummy') {
    console.warn('[Processor] ⚠️ Skipping QStash verification (keys not configured)');
    return handler(req);
  }

  return verifySignatureAppRouter(handler)(req);
};
