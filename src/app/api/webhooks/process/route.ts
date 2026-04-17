/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/process
 *
 * Background Document Processor (Stable SDK version)
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { GoogleAIFileManager } from '@google/generative-ai/server';

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
const FILE_POLL_MAX_ATTEMPTS = 90;

const MAX_MACRO_TEXT_BYTES = 30_000;
const ENCRYPTION_VERSION = 'v1';

/* ─── Webhook Logic ───────────────────────────────────────────── */

async function handler(req: Request) {
  const body = await req.json();
  const result = ProcessDocumentPayloadSchema.safeParse(body);

  if (!result.success) {
    console.error('[Processor] 🚨 Invalid payload:', result.error.format());
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const { jobId, sessionId, genAiFileName, fileName, mode, tenantId } = result.data;
  console.log(`[Processor] Start: job=${jobId} file=${fileName} mode=${mode}`);

  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY missing');

  const fileManager = new GoogleAIFileManager(apiKey);
  const genai = getGenAIClient();

  try {
    // 1. Wait for file to be ACTIVE (Stable SDK pattern)
    let attempts = 0;
    let fileStatus = '';

    while (attempts < FILE_POLL_MAX_ATTEMPTS) {
      const file = await fileManager.getFile(genAiFileName);
      fileStatus = file.state;

      if (fileStatus === 'ACTIVE') break;
      if (fileStatus === 'FAILED') throw new Error('GenAI File processing failed.');

      attempts++;
      await new Promise(r => setTimeout(r, FILE_POLL_INTERVAL_MS));
    }

    if (fileStatus !== 'ACTIVE') throw new Error('File poll timeout.');

    // 2. Extract content using Gemini
    const model = genai.getGenerativeModel({ model: EXTRACTION_MODEL });
    const extractionResult = await model.generateContent([
      {
        fileData: {
          mimeType: 'application/pdf',
          fileUri: (await fileManager.getFile(genAiFileName)).uri,
        },
      },
      { text: "Extract the full text of this document. Preserve structure. No commentary." },
    ]);

    const fullText = extractionResult.response.text();
    if (!fullText) throw new Error('No text extracted from document.');

    // 3. Hierarchical Split
    const structures = splitHierarchical(fullText);
    console.log(`[Processor] Split into ${structures.length} hierarchical units.`);

    // 4. Encrypt and Embed
    if (mode === 'governed') {
      await ensureKeyInitialized(tenantId!);
    }

    const microTexts = structures.map(s => s.micro);
    const embeddings = await embedTexts(microTexts);

    const vectors = await Promise.all(structures.map(async (s, i) => {
      let content = s.macro;
      if (content.length > MAX_MACRO_TEXT_BYTES) {
        content = content.substring(0, MAX_MACRO_TEXT_BYTES) + '... [Truncated]';
      }

      const metadata: VectorMetadata = {
        sessionId,
        fileName,
        content, // The "Big" context
        type: 'chunk',
      };

      if (mode === 'governed' && tenantId) {
        metadata.tenantId = tenantId;
        metadata.encryptionVersion = ENCRYPTION_VERSION;
        metadata.content = await encrypt(tenantId, content);
      }

      return {
        id: `${jobId}-${i}`,
        vector: embeddings[i],
        metadata,
      };
    }));

    // 5. Upsert to mode-specific index
    await upsertVectors(vectors, mode, tenantId);

    // 6. Complete Job
    await updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString() });
    console.log(`[Processor] ✅ Completed: job=${jobId}`);

    return NextResponse.json({ status: 'ok' });

  } catch (err: any) {
    console.error(`[Processor] 🚨 Fatal error for job=${jobId}:`, err);
    await updateJob(jobId, { status: 'failed', error: err.message });
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    // 7. MANDATORY PURGE (Stable SDK pattern)
    try {
      await fileManager.deleteFile(genAiFileName);
      console.log(`[Processor] Ghost Pipeline: Purged ${genAiFileName}`);
    } catch (e) {
      console.warn(`[Processor] Failed to purge ${genAiFileName}:`, e);
    }
  }
}

// Fixed signature verification to be robust
export const POST = async (req: Request) => {
  const qToken = process.env.QSTASH_TOKEN;
  const qCurrent = process.env.QSTASH_CURRENT_SIGNING_KEY || 'dummy';
  const qNext = process.env.QSTASH_NEXT_SIGNING_KEY || 'dummy';

  if (!qToken || qCurrent === 'dummy') {
    console.warn('[Processor] ⚠️ Skipping QStash verification (Local/Dev mode)');
    return handler(req);
  }

  return verifySignatureAppRouter(handler)(req);
};
