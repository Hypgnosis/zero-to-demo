/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/admin/namespace/delete
 *
 * Phase 3: Governance Suite — Admin Fortress
 *
 * THE DOUBLE-LOCK DELETION PROTOCOL:
 * Governed namespaces cannot be deleted instantly. This route
 * implements a 24-hour "Delayed Deletion Window":
 *
 * Step 1 — REQUEST (this route):
 *   Admin calls POST /api/admin/namespace/delete
 *   → Audit log: NAMESPACE_DELETE_REQUESTED
 *   → Redis: set deletion_pending:{sessionId} with 24h TTL
 *   → Returns 202 Accepted (not 200 OK — deletion is NOT done yet)
 *
 * Step 2 — CONFIRMATION (future route: POST /api/admin/namespace/confirm):
 *   Admin must confirm within the 24h window.
 *   → Audit log: NAMESPACE_DELETE_CONFIRMED
 *   → THEN calls deleteNamespace() on the governed physical index.
 *
 * Step 3 — ABORT (future route: POST /api/admin/namespace/abort):
 *   Admin cancels within the 24h window.
 *   → Audit log: NAMESPACE_DELETE_ABORTED
 *   → Removes deletion_pending key.
 *
 * RBAC Guard:
 *   Requires roles: ['admin'] claim in the JWT.
 *   A compromised service account token WITHOUT the admin role
 *   will receive 403 Forbidden, not 404 or 500.
 *
 * CANNOT BE ABUSED by:
 *   - Regular users (403 at RBAC gate)
 *   - Race conditions (NX on deletion_pending key)
 *   - Replay attacks (each deletion_pending is TTL-bound)
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { getSession } from '@/lib/redis';
import { auditDeleteRequest } from '@/lib/audit';
import { getRedis } from '@/lib/redis';

/* ─── Schema ──────────────────────────────────────────────────── */

const DeleteRequestSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID.'),
  reason: z.string().min(10, 'Reason must be at least 10 characters.').optional(),
});

/* ─── Constants ───────────────────────────────────────────────── */

const DELETION_PENDING_PREFIX = 'deletion_pending:';
const DELETION_WINDOW_SECONDS = 24 * 60 * 60; // 24 hours

/* ─── Route Handler ───────────────────────────────────────────── */

export const POST = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE + ADMIN FORTRESS GATE
  // Uses requireAdmin: true — 403 if the JWT lacks the 'admin' role.
  // This is structurally different from regular user auth — a compromised
  // non-admin token CANNOT reach this handler's business logic.
  const claims = await authenticateRequest(req, { requireAdmin: true });

  // 2. Validate request body
  const body = await req.json();
  const parseResult = DeleteRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request body.');
  }

  const { sessionId, reason } = parseResult.data;

  // 3. Verify the session exists AND is governed
  // Admins cannot delete ephemeral sessions via this route — they
  // self-destruct on TTL. This enforces route segregation.
  const session = await getSession(sessionId);
  if (!session) {
    throw Errors.notFound('Session');
  }

  // 3.b ENFORCE MULTI-TENANT ISOLATION
  // Cryptographic binding prevents Cross-Tenant Log Browsing by CISOs
  if (claims.tenantId && claims.tenantId !== session.tenantId) {
    throw Errors.forbidden('Cross-tenant admin access is strictly forbidden.');
  }

  if (session.mode !== 'governed') {
    throw Errors.validation(
      `Session ${sessionId} is ephemeral mode. Ephemeral sessions expire automatically ` +
      `and cannot be manually deleted via the admin route.`
    );
  }

  // 4. Check for existing pending deletion (idempotency guard)
  const redis = getRedis();
  const pendingKey = `${DELETION_PENDING_PREFIX}${sessionId}`;
  const existingPending = await redis.get(pendingKey);

  if (existingPending) {
    // A deletion window is already open. Return 409 — don't reset the clock.
    return NextResponse.json(
      {
        status: 'conflict',
        message: `A deletion is already pending for session ${sessionId}. ` +
          `Confirm or abort the existing request before submitting a new one.`,
        pendingKey,
      },
      { status: 409 }
    );
  }

  // 5. Set the deletion_pending key with NX to prevent race conditions
  const deletionRecord = {
    requestedBy: claims.userId,
    requestedAt: new Date().toISOString(),
    sessionId,
    reason: reason ?? 'Admin-requested deletion.',
    expiresAt: new Date(Date.now() + DELETION_WINDOW_SECONDS * 1000).toISOString(),
  };

  const set = await redis.set(pendingKey, JSON.stringify(deletionRecord), {
    nx: true,
    ex: DELETION_WINDOW_SECONDS,
  });

  if (!set) {
    // NX conflict — concurrent request won the race.
    return NextResponse.json(
      { status: 'conflict', message: 'Deletion request race condition. Please retry.' },
      { status: 409 }
    );
  }

  // 6. AUDIT LOG — Tamper-evident deletion request (append-only stream)
  await auditDeleteRequest(
    claims.tenantId,
    claims.userId,
    sessionId,
    reason
  );

  // 7. Log admin access event
  console.warn(
    `[AdminFortress] 🔑 DELETE REQUESTED: sessionId=${sessionId} ` +
    `by admin=${claims.userId} | Window: 24h | Reason: ${reason ?? 'unspecified'}`
  );

  // 8. Return 202 — deletion is NOT complete, just requested
  return NextResponse.json(
    {
      status: 'accepted',
      message: `Deletion of governed namespace gov_${sessionId} has been requested. ` +
        `Confirm via POST /api/admin/namespace/confirm within 24 hours to proceed. ` +
        `Abort via POST /api/admin/namespace/abort to cancel.`,
      sessionId,
      windowExpiresAt: deletionRecord.expiresAt,
    },
    { status: 202 }
  );
});
