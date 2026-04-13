/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/cron/cleanup
 *
 * Phase 3 — Cryptographic Erasure Cron (Infrastructure Hardened)
 *
 * Three-stage sweep:
 * 1. Purge expired Redis sessions + Upstash Vector namespaces.
 *    → Uses O(log N) ZRANGEBYSCORE (Phase 3 Finding 3 Remedy).
 *    → No longer calls redis.keys() — event loop never blocks.
 * 2. Purge orphaned Google GenAI files (Phase 2 crash-during-cleanup shield).
 * 3. Log all actions for audit trail.
 *
 * Safe under concurrent execution: even if two instances trigger
 * simultaneously, ZRANGEBYSCORE is non-blocking and deleteSession()
 * is idempotent (DEL + ZREM are both no-ops on missing keys).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { getExpiredSessionIds, deleteSession } from '@/lib/redis';
import { getGenAIClient } from '@/lib/embeddings';
import { Index } from '@upstash/vector';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 1 minute max for cron

/* ─── Constants ───────────────────────────────────────────────── */

/** GenAI files older than this are considered orphans. */
const ORPHAN_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours (matches session TTL)

/* ─── Route Handler ───────────────────────────────────────────── */

export async function GET(req: Request) {
  // ── Validate Cron Caller ─────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const audit = {
    sessionsDeleted: 0,
    namespacesDeleted: 0,
    genAiOrphansPurged: 0,
    errors: [] as string[],
  };

  try {
    // ═══════════════════════════════════════════════════════════════
    // STAGE 1: Purge expired Redis sessions + Vector namespaces
    // ═══════════════════════════════════════════════════════════════
    const expiredSessionIds = await getExpiredSessionIds();

    if (expiredSessionIds.length > 0) {
      const UPSTASH_VECTOR_REST_URL = process.env.UPSTASH_VECTOR_REST_URL;
      const UPSTASH_VECTOR_REST_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;

      if (!UPSTASH_VECTOR_REST_URL || !UPSTASH_VECTOR_REST_TOKEN) {
        throw new Error('Vector DB credentials missing.');
      }

      const vectorIndex = new Index({
        url: UPSTASH_VECTOR_REST_URL,
        token: UPSTASH_VECTOR_REST_TOKEN,
      });

      console.log(`[Cron Cleanup] Stage 1: ${expiredSessionIds.length} expired sessions found.`);

      for (const sessionId of expiredSessionIds) {
        try {
          // Delete namespace FIRST (ephemerality requirement)
          await vectorIndex.deleteNamespace(sessionId);
          audit.namespacesDeleted++;

          // Delete Redis key ONLY AFTER namespace deletion succeeds
          await deleteSession(sessionId);
          audit.sessionsDeleted++;

          console.log(`[Cron Cleanup] Purged session: ${sessionId}`);
        } catch (err) {
          const msg = `Session purge failed: ${sessionId} — ${err instanceof Error ? err.message : 'Unknown'}`;
          console.error(`[Cron Cleanup] ${msg}`);
          audit.errors.push(msg);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STAGE 2: Purge orphaned GenAI files (Crash-During-Cleanup Shield)
    //
    // This catches files that survived because:
    // - Worker crashed before `finally` block executed.
    // - Network partition during GenAI delete call.
    // - QStash retry created duplicate uploads.
    //
    // Logic:
    // - List all files in the GenAI account.
    // - For each file older than ORPHAN_AGE_MS: delete it.
    // - Files younger than ORPHAN_AGE_MS are presumed active jobs.
    // ═══════════════════════════════════════════════════════════════
    try {
      const ai = getGenAIClient();
      const now = Date.now();

      console.log('[Cron Cleanup] Stage 2: Scanning for orphaned GenAI files...');

      const fileList = await ai.files.list();
      let scannedCount = 0;

      // files.list() returns a PagedItem — iterate
      for await (const file of fileList) {
        scannedCount++;

        // Skip files without creation metadata
        if (!file.createTime || !file.name) continue;

        const fileAge = now - new Date(file.createTime).getTime();

        if (fileAge > ORPHAN_AGE_MS) {
          try {
            await ai.files.delete({ name: file.name });
            audit.genAiOrphansPurged++;
            console.log(
              `[Cron Cleanup] 🗑️ Orphan purged: ${file.name} ` +
              `(age: ${(fileAge / 3600000).toFixed(1)}h, display: ${file.displayName ?? 'unknown'})`
            );
          } catch (deleteErr) {
            const msg = `GenAI orphan delete failed: ${file.name} — ${
              deleteErr instanceof Error ? deleteErr.message : 'Unknown'
            }`;
            console.error(`[Cron Cleanup] ${msg}`);
            audit.errors.push(msg);
          }
        }
      }

      console.log(
        `[Cron Cleanup] Stage 2 complete: scanned=${scannedCount}, orphans_purged=${audit.genAiOrphansPurged}`
      );
    } catch (genAiErr) {
      const msg = `GenAI orphan scan failed: ${genAiErr instanceof Error ? genAiErr.message : 'Unknown'}`;
      console.error(`[Cron Cleanup] ${msg}`);
      audit.errors.push(msg);
      // Non-fatal: Stage 1 still completed. Don't fail the whole cron.
    }

    // ── Audit Log ────────────────────────────────────────────────
    console.log('[Cron Cleanup] Audit:', JSON.stringify(audit));

    return NextResponse.json({
      status: 'ok',
      message: `Cleanup complete. Sessions: ${audit.sessionsDeleted}, Namespaces: ${audit.namespacesDeleted}, GenAI orphans: ${audit.genAiOrphansPurged}`,
      ...audit,
    });
  } catch (error) {
    console.error('[Cron Cleanup] Critical failure:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
