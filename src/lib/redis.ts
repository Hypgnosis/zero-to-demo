/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 / AXIOM-G — Upstash Redis Client
 *
 * Phase 5: Dual-Mode Architecture (Zero-Trust Architect V2)
 *
 * Session management uses dual-write pattern with NX atomicity:
 * - SET session:{id} → JSON payload (NX: if not exists, else fail)
 * - ZADD session_expiry_index → score=expiryTimestamp (ephemeral only)
 *
 * IMMUTABLE SESSION RULE (Architectural Condition #2):
 * Once a session is created, its mode CANNOT change. The NX flag
 * ensures that a second createSession call for the same ID returns
 * null instead of overwriting. The caller must return 409 Conflict.
 *
 * ZSET indexing: O(log N) via ZRANGEBYSCORE. No KEYS bomb.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Redis } from '@upstash/redis';
import { Errors } from '@/lib/errors';
import type { IngestionJob, AxiomSession, AxiomMode } from './types';

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

/* ─── Session Management (Phase 5: NX-Atomic, Mode-Aware) ───── */

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours (ephemeral only)

/**
 * The sorted set that indexes ephemeral session expiry timestamps.
 * Score = Unix timestamp (ms) when the session expires.
 * Member = sessionId (UUID).
 *
 * GOVERNED SESSIONS ARE NEVER ADDED TO THIS INDEX.
 * This is the O(log N) replacement for the O(N) KEYS bomb.
 */
const SESSION_EXPIRY_INDEX = 'session_expiry_index';

/**
 * Creates a new session with NX atomicity.
 *
 * IMMUTABLE SESSION RULE (Architectural Condition #2):
 * Uses Redis SET with NX flag — "Set if Not eXists".
 * If the key already exists, SET NX returns null and we return null.
 * The caller (upload route) must interpret null as 409 Conflict.
 *
 * A session's mode is immutable for its entire lifecycle.
 * This prevents the race condition where two concurrent requests
 * create the same session with different modes.
 *
 * @param sessionId - The session UUID.
 * @param userId    - Verified owner from JWT sub claim.
 * @param mode      - 'ephemeral' or 'governed'. Immutable once set.
 * @returns The created session, or null if the session already exists (NX conflict).
 */
export async function createSession(
  sessionId: string,
  userId: string,
  mode: AxiomMode = 'ephemeral'
): Promise<AxiomSession | null> {
  const redis = getRedis();
  const now = new Date();
  const expiresAt = mode === 'ephemeral'
    ? new Date(now.getTime() + SESSION_TTL_SECONDS * 1000)
    : undefined;

  const session: AxiomSession = {
    sessionId,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt?.toISOString(),
    mode,
    status: 'active',
  };

  const key = `${SESSION_PREFIX}${sessionId}`;
  const payload = JSON.stringify(session);

  if (mode === 'governed') {
    // Governed: No TTL, no ZSET entry. NX prevents overwrite.
    const result = await redis.set(key, payload, { nx: true });
    if (!result) return null; // Key already exists — immutable mode conflict.
  } else {
    // Ephemeral: 4h TTL + ZSET expiry index. NX prevents overwrite.
    const result = await redis.set(key, payload, { nx: true, ex: SESSION_TTL_SECONDS });
    if (!result) return null; // Key already exists — immutable mode conflict.

    // ZADD only if SET succeeded. If SET returned null, we don't reach here.
    if (expiresAt) {
      await redis.zadd(SESSION_EXPIRY_INDEX, {
        score: expiresAt.getTime(),
        member: sessionId,
      });
    }
  }

  return session;
}

export async function getSession(
  sessionId: string
): Promise<AxiomSession | null> {
  const redis = getRedis();
  const data = await redis.get<string>(`${SESSION_PREFIX}${sessionId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) as AxiomSession : data as unknown as AxiomSession;
}

/**
 * Retrieves expired session IDs using ZRANGEBYSCORE on the expiry index.
 * Complexity: O(log N + M) where M = number of expired sessions.
 * This NEVER scans the full keyspace — it's a sorted set range query.
 *
 * GOVERNED SESSIONS ARE NEVER IN THIS INDEX.
 * The cleanup cron will additionally verify session.mode before deleting.
 *
 * @returns Array of session IDs whose expiry timestamp <= now.
 */
export async function getExpiredSessionIds(): Promise<string[]> {
  const redis = getRedis();
  const now = Date.now();

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
 * Legacy compat function — new code uses deleteSession().
 */
export async function removeFromExpiryIndex(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(SESSION_EXPIRY_INDEX, sessionId);
}

/**
 * Validates that a session exists AND belongs to the requesting user.
 * Returns the full session including its mode for downstream routing.
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
): Promise<AxiomSession> {
  const session = await getSession(sessionId);
  if (!session) {
    throw Errors.notFound('Session');
  }
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
