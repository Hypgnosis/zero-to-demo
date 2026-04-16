/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-G — Re-Encryption Worker Engine
 *
 * Phase 5: Key Sovereignty — Lifecycle Management
 *
 * Purpose:
 * Executes the "Batch Scan" re-encryption pattern to migrate all
 * vector chunks from one encryption version to another WITHOUT
 * downtime. The chat route continues to serve requests seamlessly
 * during re-encryption using the multi-version key resolution
 * already implemented in Phase 4.
 *
 * Architecture:
 * 1. SCAN: Paginate the governed namespace via range() cursor.
 * 2. FILTER: Select only chunks tagged with `fromVersion`.
 * 3. DECRYPT: Resolve the old key, decrypt in-memory.
 * 4. RE-ENCRYPT: Encrypt with the new version's key.
 * 5. UPSERT: Write the re-encrypted metadata back to the index.
 * 6. COMPLETION GATE: Final full-index scan confirms zero old chunks.
 * 7. KEY PURGE: Only delete old version key AFTER gate passes.
 *
 * Guardrails:
 * - The worker NEVER deletes the old key until the completion scan
 *   confirms zero remaining old-version chunks.
 * - Each batch is atomic: if one chunk fails, it's skipped and
 *   logged, not aborted. The next run picks up stragglers.
 * - A Redis lock prevents concurrent re-encryption on the same session.
 * - The audit trail records every phase of the rotation lifecycle.
 *
 * Invocation:
 * Called by QStash via POST /api/webhooks/reencrypt after an admin
 * initiates key rotation through /api/admin/rotate.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Index } from '@upstash/vector';
import { getRedis } from './redis';
import { encrypt, decrypt, fetchVersionKeyPublic } from './kms';
import { appendAuditLog } from './audit';
import type { VectorMetadata } from './types';

/* ─── Constants ───────────────────────────────────────────────── */

/** Max vectors per range() page. Upstash caps at 1000. */
const SCAN_BATCH_SIZE = 200;

/** Max vectors to re-encrypt per QStash invocation (5 min budget). */
const MAX_VECTORS_PER_INVOCATION = 2000;

/** Redis lock key prefix for re-encryption jobs. */
const REENCRYPT_LOCK_PREFIX = 'reencrypt_lock:';

/** Lock TTL: 10 minutes (longer than the 5-min max QStash budget). */
const LOCK_TTL_SECONDS = 600;

/** Progress tracking key prefix. */
const REENCRYPT_PROGRESS_PREFIX = 'reencrypt_progress:';

/* ─── Types ───────────────────────────────────────────────────── */

export interface ReencryptionJob {
  sessionId: string;
  fromVersion: string;
  toVersion: string;
  tenantId?: string;
  actorId: string;
}

export interface ReencryptionResult {
  /** Total vectors scanned in this invocation. */
  scanned: number;
  /** Vectors successfully re-encrypted. */
  reencrypted: number;
  /** Vectors that failed re-encryption (logged, not fatal). */
  failed: number;
  /** Vectors already at the target version (skipped). */
  skipped: number;
  /** True if the full index scan found zero remaining old-version chunks. */
  completionGatePassed: boolean;
  /** True if the old key was purged (only when gate passes). */
  oldKeyPurged: boolean;
}

/* ─── Governed Index Access ───────────────────────────────────── */

/**
 * Returns the governed Upstash Vector index.
 * Separate from vectorClient.ts to avoid module-scope collision checks
 * in the worker context (which only ever touches governed data).
 */
function getGovernedIndex(): Index {
  const url = process.env.AXIOM_G_VECTOR_URL;
  const token = process.env.AXIOM_G_VECTOR_TOKEN;
  if (!url || !token) {
    throw new Error('AXIOM_G_VECTOR_URL and/or AXIOM_G_VECTOR_TOKEN not set.');
  }
  return new Index({ url, token });
}

/* ─── Lock Management ─────────────────────────────────────────── */

/**
 * Acquires a distributed lock for re-encryption on a session.
 * Uses SET NX EX to prevent concurrent workers.
 */
async function acquireLock(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  const lockKey = `${REENCRYPT_LOCK_PREFIX}${sessionId}`;
  const result = await redis.set(lockKey, Date.now().toString(), {
    nx: true,
    ex: LOCK_TTL_SECONDS,
  });
  return result === 'OK';
}

/**
 * Releases the re-encryption lock for a session.
 */
async function releaseLock(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${REENCRYPT_LOCK_PREFIX}${sessionId}`);
}

/* ─── Progress Tracking ───────────────────────────────────────── */

interface ReencryptProgress {
  lastCursor: string;
  reencryptedTotal: number;
  failedTotal: number;
  skippedTotal: number;
  startedAt: string;
}

async function getProgress(sessionId: string): Promise<ReencryptProgress | null> {
  const redis = getRedis();
  const raw = await redis.get<string>(`${REENCRYPT_PROGRESS_PREFIX}${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as ReencryptProgress;
}

async function setProgress(sessionId: string, progress: ReencryptProgress): Promise<void> {
  const redis = getRedis();
  await redis.set(
    `${REENCRYPT_PROGRESS_PREFIX}${sessionId}`,
    JSON.stringify(progress),
    { ex: 3600 } // 1 hour TTL — cleanup after completion
  );
}

async function clearProgress(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${REENCRYPT_PROGRESS_PREFIX}${sessionId}`);
}

/* ─── Core Re-Encryption Engine ───────────────────────────────── */

/**
 * Executes one invocation of the re-encryption scan.
 *
 * This function is designed to be called repeatedly by QStash
 * until the completion gate passes. Each invocation processes
 * up to MAX_VECTORS_PER_INVOCATION vectors.
 *
 * The function is IDEMPOTENT: re-encrypting an already-migrated
 * chunk is a no-op (version check skips it).
 */
export async function executeReencryption(job: ReencryptionJob): Promise<ReencryptionResult> {
  const { sessionId, fromVersion, toVersion, tenantId, actorId } = job;

  // ── 1. Acquire distributed lock ─────────────────────────────
  const lockAcquired = await acquireLock(sessionId);
  if (!lockAcquired) {
    console.warn(`[ReEncrypt] Lock contention: session=${sessionId} already has an active worker.`);
    return {
      scanned: 0, reencrypted: 0, failed: 0, skipped: 0,
      completionGatePassed: false, oldKeyPurged: false,
    };
  }

  const result: ReencryptionResult = {
    scanned: 0, reencrypted: 0, failed: 0, skipped: 0,
    completionGatePassed: false, oldKeyPurged: false,
  };

  try {
    // ── 2. Resolve keys ─────────────────────────────────────────
    const oldKey = await fetchVersionKeyPublic(sessionId, fromVersion);
    const newKey = await fetchVersionKeyPublic(sessionId, toVersion);

    if (!oldKey) {
      console.error(`[ReEncrypt] Old key ${fromVersion} not found for session=${sessionId}. Aborting.`);
      return result;
    }
    if (!newKey) {
      console.error(`[ReEncrypt] New key ${toVersion} not found for session=${sessionId}. Aborting.`);
      return result;
    }

    // ── 3. Resume from last progress checkpoint ─────────────────
    const progress = await getProgress(sessionId);
    let cursor: string = String(progress?.lastCursor ?? '0');

    const index = getGovernedIndex();
    const namespace = `gov_${sessionId}`;
    const ns = index.namespace(namespace);

    let totalProcessed = 0;
    type VectorMeta = VectorMetadata & Record<string, unknown>;

    // ── 4. Paginated scan + re-encrypt loop ─────────────────────
    while (totalProcessed < MAX_VECTORS_PER_INVOCATION) {
      const page: {
        vectors: Array<{ id: string | number; vector?: number[]; metadata?: VectorMeta }>;
        nextCursor?: string | number;
      } = await ns.range<VectorMeta>({
        cursor,
        limit: SCAN_BATCH_SIZE,
        includeMetadata: true,
        includeVectors: true,
      });

      if (page.vectors.length === 0) break;

      // Collect re-encrypted vectors for batch upsert
      const upsertBatch: Array<{
        id: string | number;
        vector: number[];
        metadata: VectorMeta;
      }> = [];

      for (const vec of page.vectors) {
        result.scanned++;
        totalProcessed++;

        const meta = vec.metadata;
        if (!meta) {
          result.skipped++;
          continue;
        }

        // Already at target version — skip
        if (meta.encryptionVersion !== fromVersion) {
          result.skipped++;
          continue;
        }

        try {
          // Decrypt text and macroText with old key
          const decryptedText = decrypt(meta.text, oldKey);
          const decryptedMacroText = meta.macroText
            ? decrypt(meta.macroText as string, oldKey)
            : '';

          // Re-encrypt with new key
          const reencryptedText = encrypt(decryptedText, newKey);
          const reencryptedMacroText = encrypt(decryptedMacroText, newKey);

          // Build updated metadata
          const updatedMeta: VectorMeta = {
            ...meta,
            text: reencryptedText,
            macroText: reencryptedMacroText,
            encryptionVersion: toVersion,
          };

          upsertBatch.push({
            id: vec.id,
            vector: vec.vector!, // Preserve the original embedding
            metadata: updatedMeta,
          });
        } catch (err) {
          result.failed++;
          console.error(
            `[ReEncrypt] Failed to re-encrypt chunk id=${String(vec.id)} ` +
            `version=${fromVersion}:`,
            err instanceof Error ? err.message : err
          );
          // Continue — don't abort the entire batch for one bad chunk
        }
      }

      // Batch upsert re-encrypted vectors
      if (upsertBatch.length > 0) {
        await ns.upsert(upsertBatch);
        result.reencrypted += upsertBatch.length;
      }

      // Update cursor for next page
      const nextCursor = String(page.nextCursor ?? '');
      if (!nextCursor || nextCursor === '0') break;
      cursor = nextCursor;
    }

    // ── 5. Save progress checkpoint ─────────────────────────────
    await setProgress(sessionId, {
      lastCursor: String(cursor),
      reencryptedTotal: (progress?.reencryptedTotal ?? 0) + result.reencrypted,
      failedTotal: (progress?.failedTotal ?? 0) + result.failed,
      skippedTotal: (progress?.skippedTotal ?? 0) + result.skipped,
      startedAt: progress?.startedAt ?? new Date().toISOString(),
    });

    // ── 6. COMPLETION GATE: Full index scan ─────────────────────
    // Only run the gate if we didn't hit the max vectors limit
    // (meaning we scanned the entire index in this invocation)
    const reachedEnd = !cursor || cursor === '0';

    if (reachedEnd) {
      const oldVersionRemaining = await countVersionChunks(ns, fromVersion);

      if (oldVersionRemaining === 0) {
        result.completionGatePassed = true;

        console.log(
          `[ReEncrypt] ✅ COMPLETION GATE PASSED: Zero ${fromVersion} chunks ` +
          `remaining in gov_${sessionId}. Safe to purge old key.`
        );

        // ── 7. KEY PURGE (only after gate passes) ─────────────────
        const redis = getRedis();
        await redis.hdel(`kms:${sessionId}`, fromVersion);
        result.oldKeyPurged = true;

        console.log(`[ReEncrypt] 🗑️ Old key ${fromVersion} PURGED for session=${sessionId}.`);

        // Audit: KEY_ROTATION_COMPLETED
        await appendAuditLog(tenantId, actorId, 'KEY_ROTATION_COMPLETED', `gov_${sessionId}`, {
          encryptionVersion: toVersion,
          metadata: {
            fromVersion,
            toVersion,
            totalReencrypted: (progress?.reencryptedTotal ?? 0) + result.reencrypted,
            totalFailed: (progress?.failedTotal ?? 0) + result.failed,
          },
        });

        // Clear progress tracker
        await clearProgress(sessionId);
      } else {
        console.warn(
          `[ReEncrypt] ⚠️ COMPLETION GATE FAILED: ${oldVersionRemaining} ${fromVersion} chunks ` +
          `still remain in gov_${sessionId}. Re-queue the worker.`
        );
      }
    }

    console.log(
      `[ReEncrypt] Batch complete: session=${sessionId} ` +
      `scanned=${result.scanned} reencrypted=${result.reencrypted} ` +
      `failed=${result.failed} skipped=${result.skipped} ` +
      `gate=${result.completionGatePassed ? 'PASSED' : 'PENDING'}`
    );

    return result;

  } finally {
    await releaseLock(sessionId);
  }
}

/* ─── Completion Gate Scanner ─────────────────────────────────── */

/**
 * Counts how many vectors in a namespace still have a specific
 * encryption version. Used by the completion gate to verify
 * zero old-version chunks remain before purging the old key.
 *
 * IMPORTANT: This is a FULL INDEX SCAN. It should only run
 * after the re-encryption scan believes it has processed everything.
 */
async function countVersionChunks(
  ns: ReturnType<Index['namespace']>,
  version: string
): Promise<number> {
  type VectorMeta = VectorMetadata & Record<string, unknown>;
  let count = 0;
  let cursor = '0';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rangeResult: {
      vectors: Array<{ id: string | number; metadata?: VectorMeta }>;
      nextCursor?: string | number;
    } = await ns.range<VectorMeta>({
      cursor,
      limit: 1000, // Max page size for counting
      includeMetadata: true,
    });

    for (const vec of rangeResult.vectors) {
      if (vec.metadata?.encryptionVersion === version) {
        count++;
      }
    }

    const next = String(rangeResult.nextCursor ?? '');
    if (!next || next === '0') break;
    cursor = next;
  }

  return count;
}

/* ─── Re-Encryption Status Query ──────────────────────────────── */

/**
 * Returns the current re-encryption progress for a session.
 * Used by the admin dashboard to show rotation status.
 */
export async function getReencryptionStatus(sessionId: string): Promise<{
  inProgress: boolean;
  progress: ReencryptProgress | null;
  locked: boolean;
}> {
  const redis = getRedis();
  const lockKey = `${REENCRYPT_LOCK_PREFIX}${sessionId}`;
  const locked = (await redis.exists(lockKey)) === 1;
  const progress = await getProgress(sessionId);

  return {
    inProgress: !!progress,
    progress,
    locked,
  };
}
