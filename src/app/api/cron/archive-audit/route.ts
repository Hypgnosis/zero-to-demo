/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/cron/archive-audit
 *
 * Phase 5 — Audit Archive Pipeline (The Legal Archiver)
 *
 * GOAL:
 * Maintain SOC2 compliance by systematically archiving and clearing
 * high-velocity Redis audit streams.
 *
 * Pipeline:
 * 1. Verify QStash Signature (Strict Cron Auth).
 * 2. Invoke drainAuditStreams() from lib/audit.
 * 3. Log results for SIEM ingestion.
 *
 * Destination:
 * This worker "drains" entries and logs them. In a full GCP stack,
 * this would be the ETL bridge to BigQuery.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { drainAuditStreams } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export const POST = verifySignatureAppRouter(async (_req: Request) => {
  console.log('[Cron] Initiating Audit Drain & Archive...');

  try {
    const results = await drainAuditStreams();

    console.log(`[Cron] ✅ Audit Archive Complete. Processed ${results.processed} entries across ${results.streams.length} streams.`);

    return NextResponse.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      ...results
    });
  } catch (err: unknown) {
    console.error('[Cron] ❌ Audit Archive Pipeline Failed:', err);
    return NextResponse.json(
      { error: 'Internal pipeline error during audit drain' },
      { status: 500 }
    );
  }
});
