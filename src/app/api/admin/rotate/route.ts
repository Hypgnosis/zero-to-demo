/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/admin/rotate
 *
 * Phase 5: Key Sovereignty — Admin Key Rotation Endpoint
 *
 * Initiates a key rotation for a governed session:
 * 1. Validates the admin has RBAC privileges.
 * 2. Generates a new versioned DEK using the KMS.
 * 3. Enqueues a QStash re-encryption job.
 * 4. Records KEY_ROTATION_INITIATED in the audit trail.
 *
 * The actual re-encryption is ASYNCHRONOUS — the admin receives
 * an immediate acknowledgment while the worker processes chunks
 * in the background.
 *
 * RBAC Guard: Requires roles: ['admin'] in the JWT.
 *
 * Request Body:
 *   { sessionId: string, fromVersion?: string }
 *
 * fromVersion defaults to "v1" if not provided.
 * toVersion is auto-computed as "v{N+1}".
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { initiateKeyRotation, getSessionVersions } from '@/lib/kms';
import { auditKeyRotation } from '@/lib/audit';

/* ─── Schema ──────────────────────────────────────────────────── */

const RotateRequestSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  fromVersion: z.string().min(1).optional(),
});

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE + ADMIN FORTRESS GATE
  const claims = await authenticateRequest(req, { requireAdmin: true });

  // 2. Parse request body
  const body = await req.json();
  const parseResult = RotateRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request body.');
  }

  const { sessionId } = parseResult.data;

  // 3. Determine version identifiers
  const existingVersions = await getSessionVersions(sessionId);
  if (existingVersions.length === 0) {
    throw Errors.validation(
      `Session ${sessionId} has no encryption keys. ` +
      `Cannot rotate a session that has never been encrypted.`
    );
  }

  // Auto-compute: find the highest existing version number
  const versionNumbers = existingVersions
    .map(v => parseInt(v.replace('v', ''), 10))
    .filter(n => !isNaN(n));
  
  const currentMaxVersion = Math.max(...versionNumbers);
  const fromVersion = parseResult.data.fromVersion ?? `v${currentMaxVersion}`;
  const toVersion = `v${currentMaxVersion + 1}`;

  // Verify fromVersion actually exists
  if (!existingVersions.includes(fromVersion)) {
    throw Errors.validation(
      `Version ${fromVersion} does not exist for session ${sessionId}. ` +
      `Available versions: [${existingVersions.join(', ')}]`
    );
  }

  // 4. Generate new version key and register rotation in KMS
  const newKeyMaterial = (await import('node:crypto')).randomBytes(32).toString('hex');
  await initiateKeyRotation(sessionId, fromVersion, toVersion, newKeyMaterial);

  // 5. Audit the rotation
  await auditKeyRotation(
    claims.tenantId,
    claims.userId,
    sessionId,
    fromVersion,
    toVersion
  );

  // 6. Enqueue QStash re-encryption job
  let jobEnqueued = false;
  const qstashToken = process.env.QSTASH_TOKEN;
  const appUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (qstashToken) {
    try {
      const { Client } = await import('@upstash/qstash');
      const qstash = new Client({ token: qstashToken });
      await qstash.publishJSON({
        url: `${appUrl}/api/webhooks/reencrypt`,
        body: {
          sessionId,
          fromVersion,
          toVersion,
          tenantId: claims.tenantId,
          actorId: claims.userId,
        },
        retries: 3,
      });
      jobEnqueued = true;
    } catch (qErr) {
      console.error('[Admin/Rotate] Failed to enqueue QStash job:', qErr);
    }
  }

  console.log(
    `[AdminFortress] 🔄 KEY ROTATION: session=${sessionId} ` +
    `${fromVersion} → ${toVersion} by admin=${claims.userId} ` +
    `jobEnqueued=${jobEnqueued}`
  );

  return NextResponse.json({
    status: 'rotation_initiated',
    sessionId,
    fromVersion,
    toVersion,
    reencryptionJobEnqueued: jobEnqueued,
    message: jobEnqueued
      ? 'Key rotation initiated. Re-encryption worker is processing in the background. ' +
        'The old key will be purged automatically after all chunks are migrated.'
      : 'Key rotation initiated, but the re-encryption job could not be enqueued. ' +
        'Trigger POST /api/webhooks/reencrypt manually.',
  });
});
