/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/upload
 *
 * Phase 5 — Dual-Mode Upload Pipeline
 *
 * ZERO-RETENTION ARCHITECTURE (Both Modes):
 * Data exists ONLY in volatile memory and Google's 48h temp storage.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { Client as QStashClient } from '@upstash/qstash';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { v4 as uuidv4 } from 'uuid';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createSession, getSession, createJob } from '@/lib/redis';
import { UploadQuerySchema, resolveMode } from '@/lib/validation';
import { auditDocumentUpload } from '@/lib/audit';
import type { UploadResponse, IngestionJob } from '@/lib/types';
import type { ProcessDocumentPayload } from '@/lib/validation';

/* ─── Constants ───────────────────────────────────────────────── */

// Size limit removed to allow larger RAG ingestion documents
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

  const { sessionId } = queryResult.data;

  // ═══════════════════════════════════════════════════════════════
  // 5. SESSION CREATION WITH NX ATOMICITY
  // ═══════════════════════════════════════════════════════════════
  let session = await getSession(sessionId);

  if (!session) {
    const created = await createSession(sessionId, claims.userId, mode);
    if (!created) {
      session = await getSession(sessionId);
      if (!session) {
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
    throw Errors.conflict(`Session ${sessionId} is locked to ${session.mode} mode.`);
  }

  // 6. Parse multipart form data
  console.log('[Upload] Attempting to parse FormData... (Netlify Limit check)');
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err: any) {
    console.error('[Upload] 🚨 FormData parsing failed. Request might be too large for Netlify (6MB limit):', err.message);
    throw Errors.validation('File is too large for the serverless environment. Please try a smaller PDF (under 6MB) for this demo.');
  }

  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    console.error('[Upload] 🚨 No file found in FormData payload');
    throw Errors.validation('No file provided or invalid file format.');
  }

  console.log(`[Upload] ✅ Parsed: name=${file.name}, size=${file.size}, mode=${mode}, session=${sessionId}`);

  // 7. Validate file type
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw Errors.validation(
      `Unsupported file type: ${file.type}. Allowed: PDF, DOCX, TXT.`
    );
  }

  // 8. GHOST PIPELINE: Stream directly to Google GenAI File API
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Initializing the Stable File Manager
  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw Errors.configMissing('GOOGLE_GENAI_API_KEY');

  const fileManager = new GoogleAIFileManager(apiKey);
  
  // Tag governed files with gov_ prefix
  const displayName = mode === 'governed' ? `gov_${file.name}` : file.name;

  // Create temporary local file for upload (SDK requirement in stable version)
  const tempPath = `/tmp/${uuidv4()}_${file.name}`;
  const fs = require('fs');
  fs.writeFileSync(tempPath, buffer);

  try {
    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType: file.type,
      displayName: displayName,
    });

    if (!uploadResult.file.name) {
      throw Errors.serverError('GenAI File API upload returned no file reference.');
    }

    console.log(`[Upload] Pipeline [${mode}]: file=${file.name} → GenAI ref=${uploadResult.file.name}`);

    // 9. Create job record in Redis
    const jobId = uuidv4();
    const job: IngestionJob = {
      jobId,
      sessionId,
      genAiFileName: uploadResult.file.name,
      fileName: file.name,
      mode,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await createJob(job);

    // 10. Publish background processing task to QStash
    const qstashToken = process.env.QSTASH_TOKEN;
    if (!qstashToken) throw Errors.configMissing('QSTASH_TOKEN');

    const vUrl = process.env.NEXT_PUBLIC_BASE_URL || `https://${process.env.VERCEL_URL}` || 'http://localhost:3000';
    const qstash = new QStashClient({ token: qstashToken });

    const payload: ProcessDocumentPayload = {
      jobId,
      sessionId,
      genAiFileName: uploadResult.file.name,
      fileName: file.name,
      mode,
      tenantId: claims.tenantId,
    };

    await qstash.publishJSON({
      url: `${vUrl}/api/webhooks/process`,
      body: payload,
    });

    // 11. GOVERNED AUDIT LOG
    if (mode === 'governed') {
      auditDocumentUpload(
        claims.tenantId!,
        claims.userId,
        sessionId,
        file.name,
        'v1'
      ).catch(err => console.error('[Audit] Failed:', err));
    }

    return NextResponse.json({
      jobId,
      sessionId,
      fileName: file.name,
      mode,
      status: 'accepted',
    }, { status: 202 });

  } finally {
    // Cleanup temporary file
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});
