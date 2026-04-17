/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/upload
 *
 * Phase 5 — Dual-Mode Upload Pipeline
 *
 * ZERO-RETENTION ARCHITECTURE (Both Modes):
 * Data exists ONLY in volatile memory and Google's 48h temp storage.
 * No Vercel Blob. No public CDN. No persistent file staging.
 *
 * MODE ROUTING via X-Axiom-Mode header:
 * - 'governed': Axiom-G Digital Employee. Persistent knowledge base.
 * - 'ephemeral' / missing / invalid: Axiom-0 Ghost Pipeline. 4h TTL.
 *
 * Pipeline:
 * 1. AUTHENTICATES via JWT PEP.
 * 2. Rate-limits by User-ID.
 * 3. Resolves mode from X-Axiom-Mode header (FAIL-TO-EPHEMERAL).
 * 4. Validates sessionId (UUID).
 * 5. Creates session with NX atomicity (409 on mode conflict).
 * 6. Reads file into memory (volatile — never written to disk).
 * 7. Streams directly to Google GenAI File API.
 * 8. Creates IngestionJob in Redis with mode and genAiFileName.
 * 9. Publishes background job to QStash with mode in payload.
 * 10. Returns { jobId, status: 'accepted', mode }.
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
import { UploadQuerySchema, resolveMode } from '@/lib/validation';
import { auditDocumentUpload } from '@/lib/audit';
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
  // 1. AUTHENTICATE — Implicit Deny
  const claims = await authenticateRequest(req);

  // 2. Rate limit by User-ID
  await enforceRateLimit(req, 'upload', claims.userId);

  // 3. Resolve mode from X-Axiom-Mode header (FAIL-TO-EPHEMERAL)
  const mode = resolveMode(req.headers.get('x-axiom-mode'));

  // ═══════════════════════════════════════════════════════════════
  // 3b. DOUBLE-LOCK HANDSHAKE (Policy Check)
  //
  // We cross-reference the requested mode with user metadata.
  // Governed mode REQUIRES a valid tenantId and an 'enterprise' flag.
  // If the policy check fails, we degrade to 'ephemeral' mode
  // regardless of the header, enforcing 'Sovereign-by-Policy'.
  // ═══════════════════════════════════════════════════════════════
  if (mode === 'governed') {
    const isEligible = !!claims.tenantId && claims.roles.some(r => ['admin', 'org_admin', 'ciso'].includes(r));
    
    if (!isEligible) {
      console.warn(`[Policy] 🚨 Governed mode upgrade blocked for user=${claims.userId}. Missing tenant/role.`);
      throw Errors.forbidden('Your account does not have authorization for Governed Mode (Axiom-G).');
    }
  }

  // 4. Validate query params
  const url = new URL(req.url);
  const queryResult = UploadQuerySchema.safeParse({
    sessionId: url.searchParams.get('sessionId'),
    reset: url.searchParams.get('reset'),
  });

  if (!queryResult.success) {
    throw Errors.validation(queryResult.error.issues[0]?.message ?? 'Invalid query parameters.');
  }

  const { sessionId, reset: _reset } = queryResult.data;

  // ═══════════════════════════════════════════════════════════════
  // 5. SESSION CREATION WITH NX ATOMICITY (Architectural Condition #2)
  //
  // createSession uses SET NX — "Set if Not eXists".
  // If the session already exists, it returns null.
  // We then fetch the existing session and verify:
  //   a) Ownership (same userId)
  //   b) Mode immutability (same mode)
  //
  // If the mode differs, we return 409 Conflict.
  // A session's mode is IMMUTABLE for its entire lifecycle.
  // ═══════════════════════════════════════════════════════════════
  let session = await getSession(sessionId);

  if (!session) {
    // Attempt to create — NX will fail if a concurrent request beats us.
    const created = await createSession(sessionId, claims.userId, mode);
    if (!created) {
      // NX conflict: another request created the session between our GET and SET.
      // Fetch the winner's session to verify mode compatibility.
      session = await getSession(sessionId);
      if (!session) {
        // Extremely unlikely: session was created and immediately expired.
        throw Errors.serverError('Session creation race condition. Please retry.');
      }
    } else {
      session = created;
    }
  }

  // Ownership check
  if (session.userId && session.userId !== claims.userId) {
    throw Errors.forbidden('Session belongs to another user.');
  }

  // Mode immutability check
  if (session.mode !== mode) {
    throw Errors.sessionConflict(sessionId);
  }

  // 6. Parse multipart form data
  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    throw Errors.validation('No file provided. Send a file in the "file" field.');
  }

  // 7. Validate file type and size
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
  // 8. GHOST PIPELINE: Stream directly to Google GenAI File API
  //    Data lives in volatile memory until handoff to Google.
  //    Google retains files for 48h max, then auto-deletes.
  //    We also explicitly purge in the worker's `finally` block.
  //
  //    For governed mode: GenAI files are STILL transient.
  //    The permanent store is the vector index, not the file cache.
  // ═══════════════════════════════════════════════════════════════
  const arrayBuffer = await file.arrayBuffer();
  const fileBlob = new Blob([arrayBuffer], { type: file.type });

  const ai = getGenAIClient();

  // Tag governed files with gov_ prefix in displayName for orphan-safe cleanup
  const displayName = mode === 'governed' ? `gov_${file.name}` : file.name;

  const uploadedFile = await ai.files.upload({
    file: fileBlob,
    config: {
      displayName,
      mimeType: file.type,
    },
  });

  if (!uploadedFile.name) {
    throw Errors.serverError('GenAI File API upload returned no file reference.');
  }

  console.log(`[Upload] Pipeline [${mode}]: file=${file.name} → GenAI ref=${uploadedFile.name}`);

  // 9. Create job record in Redis (references GenAI file, NOT a blob URL)
  const jobId = uuidv4();
  const job: IngestionJob = {
    jobId,
    sessionId,
    genAiFileName: uploadedFile.name,
    fileName: file.name,
    mode,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await createJob(job);

  // 10. Publish background processing task to QStash
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
    mode,
    tenantId: claims.tenantId,
  };

  await qstash.publishJSON({
    url: `${vercelUrl}/api/webhooks/process`,
    body: payload,
    retries: 2,
  });

  // 11. GOVERNED AUDIT LOG — Tamper-Evident Event
  //
  // We append to the Redis Stream AFTER QStash to ensure we only
  // audit events that actually triggered a downstream job.
  // Ephemeral uploads are NOT audit-logged (transient by contract).
  if (mode === 'governed') {
    // Fire-and-forget: audit log failure must NOT block the upload response.
    // Server-side error is logged but the client gets their 202.
    auditDocumentUpload(
      claims.tenantId,
      claims.userId,
      sessionId,
      file.name,
      'v1' // Initial encryption version — updated by key rotation
    ).catch((err: unknown) => {
      console.error('[Audit] Failed to append upload audit log:', err);
    });
  }

  // 12. Return immediately — processing is async
  const response: UploadResponse = {
    jobId,
    sessionId,
    fileName: file.name,
    mode,
    status: 'accepted',
  };

  return NextResponse.json(response, { status: 202 });
});
