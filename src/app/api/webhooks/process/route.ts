/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Phase 5 — Background Document Processor (Hierarchical RAG)
 *
 * Uses direct REST for GenAI File API operations (AQ key compat).
 * Uses @google/genai SDK for text extraction and embeddings.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';

import { ProcessDocumentPayloadSchema } from '@/lib/validation';
import { updateJob } from '@/lib/redis';
import { upsertVectors } from '@/lib/vectorClient';
import { embedTexts, getApiKey, getGenAIFile, deleteGenAIFile } from '@/lib/embeddings';
import { splitHierarchical } from '@/lib/textSplitter';
import { encrypt, ensureKeyInitialized } from '@/lib/kms';
import type { VectorMetadata } from '@/lib/types';

/* ─── Config ──────────────────────────────────────────────────── */

export const maxDuration = 300; // 5 minutes
export const dynamic = 'force-dynamic';

const EXTRACTION_MODEL = 'gemini-2.0-flash';
const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 90; // 3 minutes max wait
const MAX_MACRO_TEXT_BYTES = 30_000;
const ENCRYPTION_VERSION = 'v1';

/* ─── Handler ─────────────────────────────────────────────────── */

async function handler(req: Request) {
  const body = await req.json();
  const result = ProcessDocumentPayloadSchema.safeParse(body);

  if (!result.success) {
    console.error('[Processor] 🚨 Invalid payload:', result.error.format());
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const { jobId, sessionId, genAiFileName, fileName, mode, tenantId } = result.data;
  console.log(`[Processor] Start: job=${jobId} file=${fileName} mode=${mode}`);

  try {
    // 1. Poll for ACTIVE state using direct REST
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
      throw new Error(`File poll timeout after ${attempts} attempts.`);
    }

    // 2. Extract content using Gemini SDK
    const apiKey = getApiKey();
    const generateRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { mimeType: fileInfo.mimeType, fileUri: fileInfo.uri } },
                { text: 'Extract the full text of this document. Preserve structure including headers, tables, and lists. No commentary.' },
              ],
            },
          ],
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

    console.log(`[Processor] Extracted ${fullText.length} chars from ${fileName}`);

    // 3. Hierarchical Split (requires source parameter)
    const { microChunks } = splitHierarchical(fullText, fileName);
    console.log(`[Processor] Split into ${microChunks.length} micro-chunks.`);

    // 4. Encrypt (governed) and Embed
    if (mode === 'governed' && tenantId) {
      await ensureKeyInitialized(tenantId);
    }

    const microTexts = microChunks.map(mc => mc.text);
    const embeddings = await embedTexts(microTexts);

    const vectors = await Promise.all(microChunks.map(async (mc, i) => {
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

    // 5. Upsert to mode-specific index (sessionId, mode, tenantId, vectors)
    await upsertVectors(sessionId, mode, tenantId, vectors);

    // 6. Complete Job (status is 'complete' not 'completed')
    await updateJob(jobId, { status: 'complete', completedAt: new Date().toISOString() });
    console.log(`[Processor] ✅ Completed: job=${jobId}`);

    return NextResponse.json({ status: 'ok' });

  } catch (err: any) {
    console.error(`[Processor] 🚨 Fatal: job=${jobId}:`, err);
    await updateJob(jobId, { status: 'failed', error: err.message }).catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    // 7. MANDATORY PURGE — Ghost Pipeline cleanup
    try {
      await deleteGenAIFile(genAiFileName);
      console.log(`[Processor] Ghost Pipeline: Purged ${genAiFileName}`);
    } catch (e) {
      console.warn(`[Processor] Failed to purge ${genAiFileName}:`, e);
    }
  }
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
