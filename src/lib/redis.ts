/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Upstash Redis Client
 * Single Redis instance for rate limiting, job state, and session TTL.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Redis } from '@upstash/redis';
import type { IngestionJob, DemoSession } from './types';

/* ─── Singleton Client ────────────────────────────────────────── */

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (!redisInstance) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.'
      );
    }

    redisInstance = new Redis({ url, token });
  }
  return redisInstance;
}

/* ─── Session Management ──────────────────────────────────────── */

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

export async function createSession(sessionId: string): Promise<DemoSession> {
  const redis = getRedis();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const session: DemoSession = {
    sessionId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'active',
  };

  await redis.set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(session), {
    ex: SESSION_TTL_SECONDS,
  });

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

export async function getExpiredSessionIds(): Promise<string[]> {
  const redis = getRedis();
  const keys = await redis.keys(`${SESSION_PREFIX}*`);
  const expired: string[] = [];
  const now = Date.now();

  for (const key of keys) {
    const data = await redis.get<string>(key);
    if (!data) continue;
    const session = (typeof data === 'string' ? JSON.parse(data) : data) as DemoSession;
    if (new Date(session.expiresAt).getTime() <= now) {
      expired.push(session.sessionId);
    }
  }

  return expired;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
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
