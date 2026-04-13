/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/upload
 *
 * Phase 2 — Ghost Pipeline Uploader
 *
 * ZERO-RETENTION ARCHITECTURE:
 * Data exists ONLY in volatile memory and Google's 48h temp storage.
 * No Vercel Blob. No public CDN. No persistent file staging.
 *
 * Pipeline:
 * 1. AUTHENTICATES via JWT PEP (Finding 1 Remedy).
 * 2. Rate-limits by User-ID (Finding 4 Remedy).
 * 3. Validates sessionId (UUID).
 * 4. Enforces session ownership.
 * 5. Reads file into memory (volatile — never written to disk).
 * 6. Streams directly to Google GenAI File API.
 * 7. Creates IngestionJob in Redis with genAiFileName (not blobUrl).
 * 8. Publishes background job to QStash with GenAI reference.
 * 9. Returns { jobId, status: 'accepted' }.
 *
 * Finding 2 Remedy: Vercel Blob dependency ELIMINATED.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { Client as QStashClient } from '@upstash/qstash';
import { v4 as uuidv4 } from 'uuid';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSession, getSession, createJob } from '@/lib/redis';
import { getGenAIClient } from '@/lib/embeddings';
import { UploadQuerySchema } from '@/lib/validation';
import type { UploadResponse, IngestionJob } from '@/lib/types';
import type { ProcessDocumentPayload } from '@/lib/validation';

/* ─── Constants ───────────────────────────────────────────────── */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE — Implicit Deny (Finding 1)
  const claims = await authenticateRequest(req);

  // 2. Rate limit by User-ID (Finding 4)
  await enforceRateLimit(req, 'upload', claims.userId);

  // 3. Validate query params
  const url = new URL(req.url);
  const queryResult = UploadQuerySchema.safeParse({
    sessionId: url.searchParams.get('sessionId'),
    reset: url.searchParams.get('reset'),
  });

  if (!queryResult.success) {
    throw Errors.validation(queryResult.error.issues[0]?.message ?? 'Invalid query parameters.');
  }

  const { sessionId, reset: _reset } = queryResult.data;

  // 4. Enforce session ownership
  let session = await getSession(sessionId);
  if (!session) {
    session = await createSession(sessionId, claims.userId);
  } else if (session.userId && session.userId !== claims.userId) {
    throw Errors.forbidden('Session belongs to another user.');
  }

  // 5. Parse multipart form data
  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    throw Errors.validation('No file provided. Send a file in the "file" field.');
  }

  // 6. Validate file type and size
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw Errors.validation(
      `Unsupported file type: ${file.type}. Allowed: PDF, DOCX, TXT.`
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    throw Errors.validation(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum: 50MB.`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. GHOST PIPELINE: Stream directly to Google GenAI File API
  //    Finding 2 Remedy — ZERO persistent storage.
  //    Data lives in volatile memory until handoff to Google.
  //    Google retains files for 48 hours max, then auto-deletes.
  //    We also explicitly purge in the worker's `finally` block.
  // ═══════════════════════════════════════════════════════════════
  const arrayBuffer = await file.arrayBuffer();
  const fileBlob = new Blob([arrayBuffer], { type: file.type });

  const ai = getGenAIClient();
  const uploadedFile = await ai.files.upload({
    file: fileBlob,
    config: {
      displayName: file.name,
      mimeType: file.type,
    },
  });

  if (!uploadedFile.name) {
    throw Errors.serverError('GenAI File API upload returned no file reference.');
  }

  console.log(`[Upload] Ghost Pipeline: file=${file.name} → GenAI ref=${uploadedFile.name}`);

  // 8. Create job record in Redis (references GenAI file, NOT a blob URL)
  const jobId = uuidv4();
  const job: IngestionJob = {
    jobId,
    sessionId,
    genAiFileName: uploadedFile.name,
    fileName: file.name,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await createJob(job);

  // 9. Publish background processing task to QStash
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken) {
    throw Errors.configMissing('QSTASH_TOKEN');
  }

  const vercelUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';

  const qstash = new QStashClient({ token: qstashToken });

  const payload: ProcessDocumentPayload = {
    jobId,
    sessionId,
    genAiFileName: uploadedFile.name,
    fileName: file.name,
  };

  await qstash.publishJSON({
    url: `${vercelUrl}/api/webhooks/process`,
    body: payload,
    retries: 2,
  });

  // 10. Return immediately — processing is async
  const response: UploadResponse = {
    jobId,
    sessionId,
    fileName: file.name,
    status: 'accepted',
  };

  return NextResponse.json(response, { status: 202 });
});
