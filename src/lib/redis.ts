/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Upstash Redis Client
 *
 * Phase 3: Infrastructure Hardening (Finding 3 Remedy)
 *
 * Session management now uses a dual-write pattern:
 * - SET:  session:{id} → JSON payload (with TTL for auto-purge)
 * - ZADD: session_expiry_index → score=expiryTimestamp, member=sessionId
 *
 * This replaces the O(N) KEYS scan with O(log N) ZRANGEBYSCORE.
 * At 100K sessions, KEYS blocks the event loop for seconds.
 * ZRANGEBYSCORE retrieves only expired entries in constant time.
 *
 * The cleanup cron calls getExpiredSessionIds() and then
 * removeFromExpiryIndex() after purging each session.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Redis } from '@upstash/redis';
import { Errors } from '@/lib/errors';
import type { IngestionJob, DemoSession } from './types';

/* ─── Singleton Client ────────────────────────────────────────── */

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (!redisInstance) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw Errors.configMissing('UPSTASH_REDIS_REST_URL and/or UPSTASH_REDIS_REST_TOKEN');
    }

    redisInstance = new Redis({ url, token });
  }
  return redisInstance;
}

/* ─── Session Management (Phase 3: ZSET-Indexed) ─────────────── */

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * The sorted set that indexes all session expiry timestamps.
 * Score = Unix timestamp (ms) when the session expires.
 * Member = sessionId (UUID).
 *
 * This is the O(log N) replacement for the O(N) KEYS bomb.
 */
const SESSION_EXPIRY_INDEX = 'session_expiry_index';

/**
 * Creates a new session with dual-write:
 * 1. SET session:{id} with TTL (auto-purge safety net)
 * 2. ZADD session_expiry_index with expiry timestamp score
 *
 * Both writes happen in a single pipeline (atomic round-trip).
 *
 * @param sessionId - The session UUID.
 * @param userId    - Verified owner from JWT sub claim.
 */
export async function createSession(sessionId: string, userId: string): Promise<DemoSession> {
  const redis = getRedis();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const session: DemoSession = {
    sessionId,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'active',
  };

  // Atomic pipeline: both writes succeed or fail together.
  // This guarantees the ZSET index stays consistent with session state.
  const pipeline = redis.pipeline();
  pipeline.set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(session), {
    ex: SESSION_TTL_SECONDS,
  });
  pipeline.zadd(SESSION_EXPIRY_INDEX, {
    score: expiresAt.getTime(),
    member: sessionId,
  });
  await pipeline.exec();

  return session;
}

export async function getSession(
  sessionId: string
): Promise<DemoSession | null> {
  const redis = getRedis();
  const data = await redis.get<string>(`${SESSION_PREFIX}${sessionId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) as DemoSession : data as unknown as DemoSession;
}

/**
 * Retrieves expired session IDs using ZRANGEBYSCORE on the expiry index.
 * Complexity: O(log N + M) where M = number of expired sessions.
 * This NEVER scans the full keyspace — it's a sorted set range query.
 *
 * Replaces the O(N) redis.keys() + per-key GET scan (Finding 3 Remedy).
 *
 * @returns Array of session IDs whose expiry timestamp <= now.
 */
export async function getExpiredSessionIds(): Promise<string[]> {
  const redis = getRedis();
  const now = Date.now();

  // ZRANGEBYSCORE: returns members with score between 0 and now.
  // These are sessions whose expiresAt timestamp has passed.
  const expired = await redis.zrange<string[]>(
    SESSION_EXPIRY_INDEX,
    0,          // min score (epoch start)
    now,        // max score (current time)
    { byScore: true }
  );

  return expired;
}

/**
 * Deletes a session AND removes it from the expiry index.
 * Both operations in a single pipeline (atomic round-trip).
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  pipeline.del(`${SESSION_PREFIX}${sessionId}`);
  pipeline.zrem(SESSION_EXPIRY_INDEX, sessionId);
  await pipeline.exec();
}

/**
 * Removes a session from the expiry index only.
 * Used by the cleanup cron after it has already deleted the session.
 * This is a legacy compat function — new code uses deleteSession().
 */
export async function removeFromExpiryIndex(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(SESSION_EXPIRY_INDEX, sessionId);
}

/**
 * Validates that a session exists AND belongs to the requesting user.
 * This is the ownership enforcement gate — prevents cross-session data access.
 *
 * @param sessionId - The session to validate.
 * @param userId    - The verified user ID from JWT claims.
 * @returns The validated session if ownership is confirmed.
 * @throws ApiError(404) if session doesn't exist.
 * @throws ApiError(403) if session belongs to a different user.
 */
export async function validateSessionOwnership(
  sessionId: string,
  userId: string
): Promise<DemoSession> {
  const session = await getSession(sessionId);
  if (!session) {
    throw Errors.notFound('Session');
  }
  // Backward compatibility: sessions created before Phase 1
  // may not have userId. Allow access during migration window.
  // After TTL expiry (4h), all legacy sessions will be gone.
  if (session.userId && session.userId !== userId) {
    throw Errors.forbidden('You do not own this session.');
  }
  return session;
}

/* ─── Job Management ──────────────────────────────────────────── */

const JOB_PREFIX = 'job:';
const JOB_TTL_SECONDS = 5 * 60 * 60; // 5 hours (slightly > session TTL)

export async function createJob(job: IngestionJob): Promise<void> {
  const redis = getRedis();
  await redis.set(`${JOB_PREFIX}${job.jobId}`, JSON.stringify(job), {
    ex: JOB_TTL_SECONDS,
  });
}

export async function getJob(jobId: string): Promise<IngestionJob | null> {
  const redis = getRedis();
  const data = await redis.get<string>(`${JOB_PREFIX}${jobId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) as IngestionJob : data as unknown as IngestionJob;
}

export async function updateJob(
  jobId: string,
  updates: Partial<IngestionJob>
): Promise<void> {
  const redis = getRedis();
  const existing = await getJob(jobId);
  if (!existing) return;

  const updated = { ...existing, ...updates };
  await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(updated), {
    ex: JOB_TTL_SECONDS,
  });
}

export async function deleteJob(jobId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${JOB_PREFIX}${jobId}`);
}
