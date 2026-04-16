/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/admin/audit?tenantId={id}&count={n}&fromId={streamId}
 *
 * Phase 3: Governance Suite — Audit Trail Reader
 *
 * Returns paginated entries from the tenant's Redis Stream audit trail.
 * Intended for compliance dashboards, CISO review, and SIEM export.
 *
 * RBAC Guard: Requires roles: ['admin'] in the JWT.
 *
 * Query Parameters:
 *   tenantId  (required)  — The tenant whose stream to read.
 *   count     (optional)  — Max entries to return. Default: 100, Max: 500.
 *   fromId    (optional)  — Redis Stream ID to paginate from (exclusive).
 *                           Use the last returned streamId for next page.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { readAuditLog } from '@/lib/audit';

/* ─── Schema ──────────────────────────────────────────────────── */

const AuditQuerySchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required.'),
  count: z.coerce.number().int().min(1).max(500).default(100),
  fromId: z.string().default('-'),
});

/* ─── Route Handler ───────────────────────────────────────────── */

export const GET = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE + ADMIN FORTRESS GATE
  const claims = await authenticateRequest(req, { requireAdmin: true });

  // 2. Parse query params
  const url = new URL(req.url);
  const parseResult = AuditQuerySchema.safeParse({
    tenantId: url.searchParams.get('tenantId'),
    count: url.searchParams.get('count'),
    fromId: url.searchParams.get('fromId'),
  });

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid query parameters.');
  }

  const { tenantId, count, fromId } = parseResult.data;

  // 3. Read the audit stream
  const entries = await readAuditLog(tenantId, count, fromId);

  console.log(
    `[AdminFortress] 📋 AUDIT READ: tenantId=${tenantId} count=${entries.length} by admin=${claims.userId}`
  );

  return NextResponse.json({
    tenantId,
    count: entries.length,
    nextFromId: entries.length > 0 ? entries[entries.length - 1]?.streamId : null,
    entries,
  });
});
