/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Rate Limiter
 * Redis-backed rate limiting via @upstash/ratelimit.
 * Prevents Denial-of-Wallet attacks on all endpoints.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Ratelimit } from '@upstash/ratelimit';
import { getRedis } from './redis';
import { Errors } from './errors';

/* ─── Rate Limiter Instances ──────────────────────────────────── */

let uploadLimiter: Ratelimit | null = null;
let chatLimiter: Ratelimit | null = null;
let statusLimiter: Ratelimit | null = null;

function getUploadLimiter(): Ratelimit {
  if (!uploadLimiter) {
    uploadLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(5, '1 m'), // 5 requests per minute
      prefix: 'rl:upload',
    });
  }
  return uploadLimiter;
}

function getChatLimiter(): Ratelimit {
  if (!chatLimiter) {
    chatLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(30, '1 m'), // 30 requests per minute
      prefix: 'rl:chat',
    });
  }
  return chatLimiter;
}

function getStatusLimiter(): Ratelimit {
  if (!statusLimiter) {
    statusLimiter = new Ratelimit({
      redis: getRedis(),
      limiter: Ratelimit.slidingWindow(60, '1 m'), // 60 requests per minute
      prefix: 'rl:status',
    });
  }
  return statusLimiter;
}

/* ─── Endpoint Map ────────────────────────────────────────────── */

type EndpointKey = 'upload' | 'chat' | 'status';

const limiterMap: Record<EndpointKey, () => Ratelimit> = {
  upload: getUploadLimiter,
  chat: getChatLimiter,
  status: getStatusLimiter,
};

/* ─── IP Extraction ───────────────────────────────────────────── */

function getClientIp(request: Request): string {
  // Vercel sets x-forwarded-for; fallback to x-real-ip
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/* ─── Enforcement ─────────────────────────────────────────────── */

/**
 * Checks rate limit for the given endpoint and client IP.
 * Throws ApiError(429) if exceeded.
 *
 * @param request - The incoming HTTP request.
 * @param endpoint - The rate limit bucket to check against.
 */
export async function enforceRateLimit(
  request: Request,
  endpoint: EndpointKey
): Promise<void> {
  const limiter = limiterMap[endpoint]();
  const ip = getClientIp(request);
  const { success } = await limiter.limit(ip);

  if (!success) {
    throw Errors.rateLimited();
  }
}
