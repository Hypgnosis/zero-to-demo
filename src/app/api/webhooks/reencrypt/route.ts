/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/webhooks/reencrypt
 *
 * Phase 5: Key Sovereignty — Re-Encryption Worker Endpoint
 *
 * Called by QStash after an admin initiates key rotation.
 * Executes one batch of the re-encryption scan.
 *
 * If the completion gate does NOT pass (old chunks remain),
 * the handler re-enqueues itself via QStash for the next batch.
 * This creates a self-healing loop that continues until all
 * chunks are migrated to the new version.
 *
 * Security:
 * - QStash signature verification (tamper-proof invocation).
 * - No direct HTTP access — only QStash can trigger this.
 * - Audit trail records every re-encryption lifecycle event.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { Client } from '@upstash/qstash';
import { z } from 'zod';

import { executeReencryption } from '@/lib/reencryption';

/* ─── Vercel Config ───────────────────────────────────────────── */

export const maxDuration = 300; // 5 minutes
export const dynamic = 'force-dynamic';

/* ─── Payload Schema ──────────────────────────────────────────── */

const ReencryptPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  tenantId: z.string().optional(),
  actorId: z.string().min(1),
});

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = verifySignatureAppRouter(async (req: Request): Promise<Response> => {
  try {
    const body = await req.json();
    const parseResult = ReencryptPayloadSchema.safeParse(body);

    if (!parseResult.success) {
      console.error('[ReEncrypt Webhook] Invalid payload:', parseResult.error.flatten());
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const job = parseResult.data;

    console.log(
      `[ReEncrypt Webhook] Starting batch: session=${job.sessionId} ` +
      `${job.fromVersion} → ${job.toVersion}`
    );

    // Execute one batch of re-encryption
    const result = await executeReencryption(job);

    // If the completion gate did NOT pass, re-enqueue for next batch
    if (!result.completionGatePassed && result.scanned > 0) {
      const qstashToken = process.env.QSTASH_TOKEN;
      const appUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

      if (qstashToken) {
        const qstash = new Client({ token: qstashToken });
        await qstash.publishJSON({
          url: `${appUrl}/api/webhooks/reencrypt`,
          body: job,
          retries: 3,
          delay: 5, // 5 second delay between batches
        });

        console.log(
          `[ReEncrypt Webhook] Re-queued next batch for session=${job.sessionId}`
        );
      } else {
        console.warn('[ReEncrypt Webhook] No QSTASH_TOKEN — cannot re-queue. Manual re-trigger required.');
      }
    }

    return NextResponse.json({
      status: result.completionGatePassed ? 'completed' : 'in_progress',
      ...result,
    });

  } catch (error: unknown) {
    console.error('[ReEncrypt Webhook] ❌ Fatal error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Re-encryption failed' },
      { status: 500 }
    );
  }
});
