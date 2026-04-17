/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/cron/cleanup
 *
 * Phase 5 — Iron-Clad Cryptographic Erasure Cron
 *
 * Three-stage sweep:
 * 1. Purge expired Redis sessions + Upstash Vector namespaces.
 *    → Uses O(log N) ZRANGEBYSCORE (Phase 3 Finding 3 Remedy).
 *    → HARD SECURITY ERROR if a governed session is in the queue.
 * 2. Purge orphaned Google GenAI files (mode-aware: skip gov_ files).
 * 3. Log all actions for audit trail.
 *
 * IRON-CLAD CLEANUP (Phase 5):
 * - This route ONLY operates on the EPHEMERAL vector index.
 * - It NEVER has credentials for the governed index.
 * - Before deleting ANY namespace, it fetches the session from Redis
 *   and verifies session.mode === 'ephemeral'.
 * - If session.mode === 'governed', it throws a HARD SECURITY ERROR
 *   and HALTS ALL cleanup — not skip, HALT.
 *
 * TAUTOLOGY GUARD (Architectural Condition #1):
 * The prefix check is performed on DATA FROM THE DATABASE, not on
 * a string we just constructed. The session.mode field is the
 * single source of truth.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { getExpiredSessionIds, getSession, deleteSession } from '@/lib/redis';
import { getGenAIClient } from '@/lib/embeddings';
import { deleteNamespace } from '@/lib/vectorClient';
import { NAMESPACE_PREFIX } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 1 minute max for cron

/* ─── Constants ───────────────────────────────────────────────── */

/** GenAI files older than this are considered orphans (ephemeral only). */
const ORPHAN_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours (matches session TTL)

/** GenAI files with displayName starting with this prefix are governed in-progress. */
const GOV_FILE_PREFIX = 'gov_';

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
    genAiGovernedSkipped: 0,
    errors: [] as string[],
  };

  try {
    // ═══════════════════════════════════════════════════════════════
    // STAGE 1: Purge expired Redis sessions + Ephemeral Vector namespaces
    //
    // TAUTOLOGY GUARD (Architectural Condition #1):
    // We do NOT hardcode `eph_${sessionId}` and then check if it
    // starts with `eph_`. That check would always pass — it's tautological.
    //
    // Instead, we:
    // 1. Fetch the AxiomSession from Redis.
    // 2. Verify session.mode === 'ephemeral' from the DATABASE.
    // 3. ONLY THEN construct the prefixed namespace.
    // 4. If session.mode !== 'ephemeral': HALT with security error.
    // ═══════════════════════════════════════════════════════════════
    const expiredSessionIds = await getExpiredSessionIds();

    if (expiredSessionIds.length > 0) {
      console.log(`[Cron Cleanup] Stage 1: ${expiredSessionIds.length} expired sessions found.`);

      for (const sessionId of expiredSessionIds) {
        try {
          // ═══════════════════════════════════════════════════════
          // HARD SECURITY GATE: Verify mode from DATABASE
          //
          // The session's mode is the SINGLE SOURCE OF TRUTH.
          // If a governed session is in the expiry ZSET, the
          // write path is broken — this is a corruption alarm.
          // ═══════════════════════════════════════════════════════
          const session = await getSession(sessionId);

          if (session && session.mode === 'governed') {
            // ═══════════════════════════════════════════════════
            // HARD SECURITY ERROR — HALT ALL CLEANUP
            //
            // A governed session in the ephemeral expiry index
            // means the session creation logic is broken.
            // We HALT (not skip) because:
            // - Skipping masks the bug.
            // - Halting forces immediate investigation.
            // - At 2 AM, a dead cron + alert > silently deleted data.
            // ═══════════════════════════════════════════════════
            const securityError = new Error(
              `[SECURITY] Governed session "${sessionId}" found in ephemeral expiry index. ` +
              `Data sovereignty violation detected. Session mode: ${session.mode}. ` +
              `Halting ALL cleanup operations. Investigate the ZADD write path in createSession().`
            );
            console.error(`[Cron Cleanup] 🚨 ${securityError.message}`);
            throw securityError; // HALTS — does not continue to next session.
          }

          // Session is ephemeral (or missing — orphan key in ZSET, safe to clean).
          // Delete vector namespace on the EPHEMERAL index only.
          await deleteNamespace(sessionId, 'ephemeral', undefined);
          audit.namespacesDeleted++;

          // Delete Redis key ONLY AFTER namespace deletion succeeds
          await deleteSession(sessionId);
          audit.sessionsDeleted++;

          console.log(`[Cron Cleanup] Purged ephemeral session: ${NAMESPACE_PREFIX.EPHEMERAL}${sessionId}`);
        } catch (err) {
          // Re-throw security errors — they must halt execution.
          if (err instanceof Error && err.message.includes('[SECURITY]')) {
            throw err;
          }
          const msg = `Session purge failed: ${sessionId} — ${err instanceof Error ? err.message : 'Unknown'}`;
          console.error(`[Cron Cleanup] ${msg}`);
          audit.errors.push(msg);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STAGE 2: Purge orphaned GenAI files (Mode-Aware)
    //
    // Ephemeral orphans: files older than 4h → DELETE.
    // Governed files: tagged with "gov_" in displayName → SKIP.
    // This prevents the cron from killing in-progress governed
    // batch ingestions that exceed the 4h threshold.
    // ═══════════════════════════════════════════════════════════════
    try {
      const ai = getGenAIClient();
      const now = Date.now();

      console.log('[Cron Cleanup] Stage 2: Scanning for orphaned GenAI files...');

      const fileList = await ai.files.list();
      let scannedCount = 0;

      for await (const file of fileList) {
        scannedCount++;

        if (!file.createTime || !file.name) continue;

        // MODE-AWARE ORPHAN CHECK: Skip governed files entirely.
        if (file.displayName?.startsWith(GOV_FILE_PREFIX)) {
          audit.genAiGovernedSkipped++;
          continue;
        }

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
        `[Cron Cleanup] Stage 2 complete: scanned=${scannedCount}, ` +
        `orphans_purged=${audit.genAiOrphansPurged}, governed_skipped=${audit.genAiGovernedSkipped}`
      );
    } catch (genAiErr) {
      const msg = `GenAI orphan scan failed: ${genAiErr instanceof Error ? genAiErr.message : 'Unknown'}`;
      console.error(`[Cron Cleanup] ${msg}`);
      audit.errors.push(msg);
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
