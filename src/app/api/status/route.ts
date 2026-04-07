/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/status?jobId=<uuid>
 *
 * Polling endpoint for ingestion job status.
 * Returns { jobId, sessionId, status, totalChunks?, error? }
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';

import { withErrorHandler, Errors } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getJob } from '@/lib/redis';
import { StatusQuerySchema } from '@/lib/validation';
import type { StatusResponse } from '@/lib/types';

export const GET = withErrorHandler(async (req: Request) => {
  // 1. Rate limit
  await enforceRateLimit(req, 'status');

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
