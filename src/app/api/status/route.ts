/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/status?jobId=<uuid>
 *
 * Polling endpoint for ingestion job status (Phase 1 Hardened).
 * 1. AUTHENTICATES via JWT PEP (Finding 1 Remedy).
 * 2. Rate-limits by User-ID (Finding 4 Remedy).
 * Returns { jobId, sessionId, status, totalChunks?, error? }
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getJob } from '@/lib/redis';
import { StatusQuerySchema } from '@/lib/validation';
import type { StatusResponse } from '@/lib/types';

export const GET = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE — Implicit Deny (Finding 1)
  const claims = await authenticateRequest(req);

  // 2. Rate limit by User-ID (Finding 4)
  await enforceRateLimit(req, 'status', claims.userId);

  // 2. Validate query params
  const url = new URL(req.url);
  const parseResult = StatusQuerySchema.safeParse({
    jobId: url.searchParams.get('jobId'),
  });

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid jobId.');
  }

  const { jobId } = parseResult.data;

  // 3. Fetch job from Redis
  const job = await getJob(jobId);
  if (!job) {
    throw Errors.jobNotFound(jobId);
  }

  // 4. Return sanitized status
  const response: StatusResponse = {
    jobId: job.jobId,
    sessionId: job.sessionId,
    status: job.status,
    ...(job.totalChunks !== undefined && { totalChunks: job.totalChunks }),
    ...(job.error && { error: job.error }),
  };

  return NextResponse.json(response);
});
