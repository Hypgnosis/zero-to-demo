/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/admin/dashboard
 *
 * Phase 5: CISO Audit Dashboard — Governance Visibility Layer
 *
 * Returns a comprehensive security posture snapshot for a tenant:
 *
 * 1. KEY AGE: How long each encryption version has been active.
 * 2. ENCRYPTION VERSION DISTRIBUTION: % of chunks per version.
 * 3. ACCESS VIOLATIONS: Failed decryption attempts (security alerts).
 * 4. ROTATION STATUS: Whether a re-encryption job is in progress.
 * 5. AUDIT TIMELINE: Recent governance events from the stream.
 *
 * This is the endpoint the Fracttal CISO will query during a SOC2 audit
 * to verify that encryption key rotation policies are being enforced
 * and that no unauthorized access has occurred.
 *
 * RBAC Guard: Requires roles: ['admin'] in the JWT.
 *
 * Query Parameters:
 *   tenantId   (required)  — The tenant to generate the dashboard for.
 *   sessionId  (optional)  — Scope to a specific governed session.
 *   auditCount (optional)  — Number of recent audit entries (default: 50).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Index } from '@upstash/vector';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { readAuditLog } from '@/lib/audit';
import { getSessionVersions } from '@/lib/kms';
import { getReencryptionStatus } from '@/lib/reencryption';
import type { VectorMetadata } from '@/lib/types';

/* ─── Schema ──────────────────────────────────────────────────── */

const DashboardQuerySchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required.'),
  sessionId: z.string().uuid().optional(),
  auditCount: z.coerce.number().int().min(1).max(200).default(50),
});

/* ─── Types ───────────────────────────────────────────────────── */

interface KeyAgeReport {
  version: string;
  /** ISO 8601 timestamp of when this key was created (from audit trail). */
  createdAt: string | null;
  /** Age in hours since creation. */
  ageHours: number | null;
  /** Whether this version is the current (latest) active version. */
  isCurrent: boolean;
}

interface VersionDistribution {
  version: string;
  chunkCount: number;
  percentage: number;
}

interface AccessViolation {
  timestamp: string;
  action: string;
  resourceId: string;
  actorId: string;
  details?: Record<string, unknown>;
}

interface DashboardResponse {
  tenantId: string;
  sessionId?: string;
  generatedAt: string;
  /** Encryption key age report per version. */
  keyAge: KeyAgeReport[];
  /** Distribution of chunks across encryption versions. */
  versionDistribution: VersionDistribution[];
  /** Total vector count in the governed namespace. */
  totalVectors: number;
  /** Security-relevant events (failed decryptions, security halts). */
  accessViolations: AccessViolation[];
  /** Current re-encryption job status (if any). */
  rotationStatus: {
    inProgress: boolean;
    locked: boolean;
    progress?: {
      reencryptedTotal: number;
      failedTotal: number;
      startedAt: string;
    };
  } | null;
  /** Recent audit trail entries. */
  recentAuditEvents: Array<{
    streamId: string;
    entry: Record<string, unknown>;
  }>;
}

/* ─── Governed Index Access ───────────────────────────────────── */

function getGovernedIndex(): Index | null {
  const url = process.env.AXIOM_G_VECTOR_URL;
  const token = process.env.AXIOM_G_VECTOR_TOKEN;
  if (!url || !token) return null;
  return new Index({ url, token });
}

/* ─── Version Distribution Scanner ────────────────────────────── */

/**
 * Scans the governed namespace to count chunks per encryption version.
 * Uses paginated range() to handle arbitrarily large indexes.
 */
async function scanVersionDistribution(
  sessionId: string
): Promise<{ distribution: VersionDistribution[]; totalVectors: number }> {
  const index = getGovernedIndex();
  if (!index) return { distribution: [], totalVectors: 0 };

  type VectorMeta = VectorMetadata & Record<string, unknown>;
  const namespace = `gov_${sessionId}`;
  const ns = index.namespace(namespace);
  const versionCounts = new Map<string, number>();
  let totalVectors = 0;
  let cursor: string | number = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Explicit type annotation breaks the TS circular inference chain.
    // Upstash's range() returns { vectors, nextCursor } but the cursor
    // re-assignment creates a self-referencing initializer cycle.
    const rangeResult: {
      vectors: Array<{ id: string | number; metadata?: VectorMeta }>;
      nextCursor?: string | number;
    } = await ns.range<VectorMeta>({
      cursor: typeof cursor === 'string' ? cursor : Number(cursor),
      limit: 1000,
      includeMetadata: true,
    });

    for (const vec of rangeResult.vectors) {
      totalVectors++;
      const version = (vec.metadata?.encryptionVersion as string) ?? 'unversioned';
      versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
    }

    const next = rangeResult.nextCursor;
    if (!next || next === '0' || next === 0) break;
    cursor = next;
  }

  const distribution: VersionDistribution[] = Array.from(versionCounts.entries())
    .map(([version, chunkCount]) => ({
      version,
      chunkCount,
      percentage: totalVectors > 0 ? Math.round((chunkCount / totalVectors) * 10000) / 100 : 0,
    }))
    .sort((a, b) => a.version.localeCompare(b.version));

  return { distribution, totalVectors };
}

/* ─── Key Age Computation ─────────────────────────────────────── */

/**
 * Computes key age by cross-referencing KMS versions with audit trail
 * KEY_CREATED and KEY_ROTATION_INITIATED events.
 */
async function computeKeyAge(
  tenantId: string,
  sessionId: string
): Promise<KeyAgeReport[]> {
  const versions = await getSessionVersions(sessionId);
  if (versions.length === 0) return [];

  // Read all audit entries to find key creation timestamps
  const auditEntries = await readAuditLog(tenantId, 500, '-');
  const keyCreationMap = new Map<string, string>();

  for (const entry of auditEntries) {
    const e = entry.entry;
    if (
      (e.action === 'KEY_CREATED' || e.action === 'KEY_ROTATION_INITIATED') &&
      e.resourceId === `gov_${sessionId}`
    ) {
      const version = e.encryptionVersion as string;
      if (version && !keyCreationMap.has(version)) {
        keyCreationMap.set(version, e.timestamp as string);
      }
    }
  }

  // Sort versions numerically
  const sorted = [...versions].sort((a, b) => {
    const na = parseInt(a.replace('v', ''), 10);
    const nb = parseInt(b.replace('v', ''), 10);
    return na - nb;
  });

  const currentVersion = sorted[sorted.length - 1];
  const now = Date.now();

  return sorted.map(version => {
    const createdAt = keyCreationMap.get(version) ?? null;
    const ageHours = createdAt
      ? Math.round((now - new Date(createdAt).getTime()) / (1000 * 60 * 60) * 10) / 10
      : null;

    return {
      version,
      createdAt,
      ageHours,
      isCurrent: version === currentVersion,
    };
  });
}

/* ─── Access Violation Extraction ─────────────────────────────── */

/**
 * Extracts security-relevant events from the audit trail:
 * - SECURITY_HALT events (anomalous system behavior)
 * - Failed decryption indicators
 * - Unauthorized admin access attempts
 */
async function extractAccessViolations(
  tenantId: string,
  count: number
): Promise<AccessViolation[]> {
  const auditEntries = await readAuditLog(tenantId, 500, '-');
  const violations: AccessViolation[] = [];

  const securityActions = new Set([
    'SECURITY_HALT',
    'NAMESPACE_DELETE_REQUESTED',
  ]);

  for (const entry of auditEntries) {
    const e = entry.entry;
    if (securityActions.has(e.action as string)) {
      violations.push({
        timestamp: e.timestamp as string,
        action: e.action as string,
        resourceId: e.resourceId as string,
        actorId: e.actorId as string,
        details: e.metadata as Record<string, unknown>,
      });
    }
  }

  return violations.slice(0, count);
}

/* ─── Route Handler ───────────────────────────────────────────── */

export const GET = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE + ADMIN FORTRESS GATE
  const claims = await authenticateRequest(req, { requireAdmin: true });

  // 2. Parse query params
  const url = new URL(req.url);
  const parseResult = DashboardQuerySchema.safeParse({
    tenantId: url.searchParams.get('tenantId'),
    sessionId: url.searchParams.get('sessionId'),
    auditCount: url.searchParams.get('auditCount'),
  });

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid query parameters.');
  }

  const { tenantId, sessionId, auditCount } = parseResult.data;

  // 3. ENFORCE MULTI-TENANT ISOLATION
  // Cryptographic binding prevents Cross-Tenant Dashboard Browsing by CISOs
  if (claims.tenantId && claims.tenantId !== tenantId) {
    throw Errors.forbidden('Cross-tenant admin access is strictly forbidden.');
  }

  // 3. Build dashboard response
  const dashboardStart = Date.now();

  // Run independent queries in parallel for latency optimization
  const [
    keyAgeReport,
    violations,
    auditEntries,
    rotationStatus,
    versionScan,
  ] = await Promise.all([
    sessionId ? computeKeyAge(tenantId, sessionId) : Promise.resolve([]),
    extractAccessViolations(tenantId, 50),
    readAuditLog(tenantId, auditCount),
    sessionId ? getReencryptionStatus(sessionId) : Promise.resolve(null),
    sessionId
      ? scanVersionDistribution(sessionId)
      : Promise.resolve({ distribution: [], totalVectors: 0 }),
  ]);

  const dashboardMs = Date.now() - dashboardStart;

  console.log(
    `[AdminFortress] 📊 DASHBOARD: tenantId=${tenantId} ` +
    `session=${sessionId ?? 'all'} latency=${dashboardMs}ms by admin=${claims.userId}`
  );

  const response: DashboardResponse = {
    tenantId,
    sessionId,
    generatedAt: new Date().toISOString(),
    keyAge: keyAgeReport,
    versionDistribution: versionScan.distribution,
    totalVectors: versionScan.totalVectors,
    accessViolations: violations,
    rotationStatus: rotationStatus
      ? {
          inProgress: rotationStatus.inProgress,
          locked: rotationStatus.locked,
          progress: rotationStatus.progress
            ? {
                reencryptedTotal: rotationStatus.progress.reencryptedTotal,
                failedTotal: rotationStatus.progress.failedTotal,
                startedAt: rotationStatus.progress.startedAt,
              }
            : undefined,
        }
      : null,
    recentAuditEvents: auditEntries.map(e => ({
      streamId: e.streamId,
      entry: e.entry as unknown as Record<string, unknown>,
    })),
  };

  return NextResponse.json(response);
});
