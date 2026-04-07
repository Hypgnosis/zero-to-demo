/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/upload
 *
 * Phase 3 — Async Upload Endpoint
 * 1. Validates sessionId (UUID).
 * 2. Rate-limits by client IP.
 * 3. Stages PDF to Vercel Blob.
 * 4. Creates an IngestionJob record in Redis.
 * 5. Publishes a background job to QStash.
 * 6. Returns immediately with { jobId, status: 'accepted' }.
 *
 * The actual extraction runs asynchronously in /api/webhooks/process.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { Client as QStashClient } from '@upstash/qstash';
import { v4 as uuidv4 } from 'uuid';

import { withErrorHandler, Errors } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSession, getSession, createJob } from '@/lib/redis';
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
  // 1. Rate limit
  await enforceRateLimit(req, 'upload');

  // 2. Validate query params
  const url = new URL(req.url);
  const queryResult = UploadQuerySchema.safeParse({
    sessionId: url.searchParams.get('sessionId'),
    reset: url.searchParams.get('reset'),
  });

  if (!queryResult.success) {
    throw Errors.validation(queryResult.error.issues[0]?.message ?? 'Invalid query parameters.');
  }

  const { sessionId, reset: _reset } = queryResult.data;

  // 3. Ensure session exists (create if first upload)
  let session = await getSession(sessionId);
  if (!session) {
    session = await createSession(sessionId);
  }

  // 4. Parse multipart form data
  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    throw Errors.validation('No file provided. Send a file in the "file" field.');
  }

  // 5. Validate file type and size
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

  // 6. Stage to Vercel Blob
  const blobPath = `uploads/${sessionId}/${uuidv4()}-${file.name}`;
  const blob = await put(blobPath, file, {
    access: 'public',
    addRandomSuffix: false,
  });

  // 7. Create job record in Redis
  const jobId = uuidv4();
  const job: IngestionJob = {
    jobId,
    sessionId,
    blobUrl: blob.url,
    fileName: file.name,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await createJob(job);

  // 8. Publish background processing task to QStash
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
    blobUrl: blob.url,
    fileName: file.name,
  };

  await qstash.publishJSON({
    url: `${vercelUrl}/api/webhooks/process`,
    body: payload,
    retries: 2,
  });

  // 9. Return immediately — processing is async
  const response: UploadResponse = {
    jobId,
    sessionId,
    fileName: file.name,
    status: 'accepted',
  };

  return NextResponse.json(response, { status: 202 });
});
