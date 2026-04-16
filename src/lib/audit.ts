/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-G — Immutable Audit Log Service
 *
 * Phase 3: Governance Suite — Tamper-Evident Audit Trail
 *
 * Architecture:
 * - Uses Redis Streams (XADD) — append-only by design.
 * - Streams cannot be retroactively edited, providing tamper-evidence.
 * - Each tenant gets a dedicted stream: `audit_trail:{tenantId}`
 * - Falls back to `audit_trail:system` for system-level events.
 *
 * Scope: ONLY governed mode state-changes are audit-logged.
 * Ephemeral sessions are transient by contract — not subject to SOC2
 * audit trail requirements.
 *
 * SOC2 / ISO27001 Coverage:
 * CC6.1: Logical and physical access controls
 * CC6.8: Prevent unauthorized access (tracks deletions with delay)
 * CC7.2: Monitor for and respond to security events
 * A.12.4.1 (ISO): Event logging
 *
 * IMPORTANT: This module uses its own Redis export reference,
 * NOT the session store. Keep audit logs isolated from session state
 * to prevent any single code path from clearing both simultaneously.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getRedis } from './redis';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * All supported audit actions that create an immutable log entry.
 * Naming convention: NOUN_VERB (resource first, action second).
 */
export type AuditAction =
  | 'SESSION_CREATED'           // A new governed session was initialized
  | 'DOCUMENT_UPLOADED'         // A file was ingested into a gov_ namespace
  | 'NAMESPACE_DELETE_REQUESTED'// An admin requested deletion (starts delay window)
  | 'NAMESPACE_DELETE_CONFIRMED'// The deletion was confirmed after the delay window
  | 'NAMESPACE_DELETE_ABORTED'  // Admin cancelled the deletion within the window
  | 'KEY_CREATED'             // A new decryption key was generated for a version
  | 'KEY_ROTATION_INITIATED'    // Client rotated their encryption key
  | 'KEY_ROTATION_COMPLETED'    // All chunks have been re-encrypted with the new key
  | 'ADMIN_ACCESS'              // An admin accessed a governed namespace
  | 'SECURITY_HALT';            // The cleanup cron halted due to a security violation

/**
 * Tamper-evident audit entry stored in the Redis Stream.
 * Once written, this payload CANNOT be modified — only appended.
 */
export interface AuditEntry {
  /** Auto-generated ID for this specific audit event. */
  auditId: string;
  /** ISO8601 UTC timestamp of the event. */
  timestamp: string;
  /** The user ID of the actor, or 'SYSTEM' for automated processes. */
  actorId: string;
  /** The action that occurred. */
  action: AuditAction;
  /** The primary resource affected (e.g., namespace 'gov_session-123'). */
  resourceId: string;
  /** Session mode context — always 'governed' for audit-logged events. */
  mode: 'governed';
  /** The active encryption key version at time of event. */
  encryptionVersion?: string;
  /**
   * IP address of the requesting actor.
   * Must be pseudonymized or hashed if GDPR applies to this tenant.
   */
  ipAddress?: string;
  /** Freeform metadata for context (e.g., file name, deletion reason). */
  metadata?: Record<string, string | number | boolean>;
}

/* ─── Stream Key ──────────────────────────────────────────────── */

/**
 * Resolves the Redis Stream key for a given tenant.
 * Uses 'system' as the fallback for non-tenant-scoped events.
 */
function resolveStreamKey(tenantId?: string): string {
  return `audit_trail:${tenantId ?? 'system'}`;
}

/* ─── Core Append ─────────────────────────────────────────────── */

/**
 * Appends a tamper-evident entry to the tenant's dedicated Redis Stream.
 *
 * Redis Streams (XADD) are strictly append-only. Entries can only be
 * trimmed by TTL or XTRIM — they cannot be modified in place.
 *
 * Uses '*' as the stream ID to let Redis auto-generate a monotonically
 * increasing ID, ensuring ordering guarantees across distributed writers.
 *
 * @param tenantId   - The tenant whose audit stream to write to.
 * @param actorId    - The JWT sub or 'SYSTEM' for automated processes.
 * @param action     - The AuditAction enum value.
 * @param resourceId - The primary resource affected.
 * @param extras     - Optional additional fields (encryptionVersion, ip, metadata).
 *
 * @returns The Redis Stream entry ID (e.g., '1713234567890-0').
 *          This ID is useful for correlating log entries in SIEM tools.
 */
export async function appendAuditLog(
  tenantId: string | undefined,
  actorId: string,
  action: AuditAction,
  resourceId: string,
  extras: {
    encryptionVersion?: string;
    ipAddress?: string;
    metadata?: Record<string, string | number | boolean>;
  } = {}
): Promise<string> {
  const redis = getRedis();
  const streamKey = resolveStreamKey(tenantId);

  const entry: Omit<AuditEntry, 'auditId'> = {
    timestamp: new Date().toISOString(),
    actorId,
    action,
    resourceId,
    mode: 'governed',
    ...extras,
  };

  // Flatten the entry for XADD — Redis Streams use flat key-value pairs,
  // not nested JSON. We stringify nested objects (like metadata).
  const fields: Record<string, string> = {
    timestamp: entry.timestamp,
    actorId: entry.actorId,
    action: entry.action,
    resourceId: entry.resourceId,
    mode: entry.mode,
  };

  if (entry.encryptionVersion) fields.encryptionVersion = entry.encryptionVersion;
  if (entry.ipAddress) fields.ipAddress = entry.ipAddress;
  if (entry.metadata) fields.metadata = JSON.stringify(entry.metadata);

  // XADD audit_trail:{tenantId} * <fields>
  // '*' tells Redis to auto-generate a unique, monotonically increasing ID.
  const streamId = await redis.xadd(streamKey, '*', fields);

  console.log(
    `[Audit] ${action} | actor=${actorId} | resource=${resourceId} | stream=${streamKey} | id=${streamId}`
  );

  return streamId as string;
}

/* ─── Convenience Wrappers ────────────────────────────────────── */

/**
 * Logs a governed document upload.
 * Called from the upload route AFTER the QStash job is enqueued.
 */
export function auditDocumentUpload(
  tenantId: string | undefined,
  actorId: string,
  sessionId: string,
  fileName: string,
  encryptionVersion: string
): Promise<string> {
  return appendAuditLog(tenantId, actorId, 'DOCUMENT_UPLOADED', `gov_${sessionId}`, {
    encryptionVersion,
    metadata: { fileName },
  });
}

/**
 * Logs the initiation of a governed namespace deletion.
 * The NAMESPACE_DELETE_REQUESTED action starts the 24-hour delay window.
 * The actual deletion only takes effect when NAMESPACE_DELETE_CONFIRMED is logged.
 */
export function auditDeleteRequest(
  tenantId: string | undefined,
  actorId: string,
  sessionId: string,
  reason?: string
): Promise<string> {
  return appendAuditLog(tenantId, actorId, 'NAMESPACE_DELETE_REQUESTED', `gov_${sessionId}`, {
    metadata: { reason: reason ?? 'unspecified', windowHours: 24 },
  });
}

/**
 * Logs the creation of a new decryption key (DEK).
 */
export function auditKeyCreated(
  tenantId: string | undefined,
  actorId: string,
  sessionId: string,
  version: string
): Promise<string> {
  return appendAuditLog(tenantId, actorId, 'KEY_CREATED', `gov_${sessionId}`, {
    encryptionVersion: version,
    metadata: { version },
  });
}

/**
 * Logs the initiation of a key rotation event.
 * Records which version is being rotated FROM and TO.
 */
export function auditKeyRotation(
  tenantId: string | undefined,
  actorId: string,
  sessionId: string,
  fromVersion: string,
  toVersion: string
): Promise<string> {
  return appendAuditLog(tenantId, actorId, 'KEY_ROTATION_INITIATED', `gov_${sessionId}`, {
    encryptionVersion: toVersion,
    metadata: { fromVersion, toVersion },
  });
}

/**
 * Logs a security halt — used by the cleanup cron when a governed
 * session is found in the ephemeral expiry index.
 * This is a SYSTEM-level event, not tenant-scoped.
 */
export function auditSecurityHalt(
  actorId: string,
  sessionId: string,
  reason: string
): Promise<string> {
  return appendAuditLog('system', actorId, 'SECURITY_HALT', sessionId, {
    metadata: { reason },
  });
}

/* ─── Read (for Admin Routes) ─────────────────────────────────── */

/**
 * Reads audit log entries for a tenant using XRANGE.
 * Returns entries in chronological order (oldest first).
 *
 * For compliance dashboards and admin review panels.
 *
 * @param tenantId - The tenant to read audit logs for.
 * @param count    - Maximum number of entries to return (default: 100).
 * @param fromId   - Optional stream ID to paginate from (exclusive).
 */
export async function readAuditLog(
  tenantId: string,
  count = 100,
  fromId = '-'
): Promise<Array<{ streamId: string; entry: Partial<AuditEntry> }>> {
  const redis = getRedis();
  const streamKey = resolveStreamKey(tenantId);

  // Upstash xrange signature: (key, start, end, count?)
  // Returns: Array<[streamId: string, fields: Record<string, string>]>
  const raw = await redis.xrange(streamKey, fromId, '+', count);
  const entries = raw as unknown as Array<[string, Record<string, string>]>;

  return entries.map(([streamId, fields]) => ({
    streamId,
    entry: {
      timestamp: fields.timestamp,
      actorId: fields.actorId,
      action: fields.action as AuditAction,
      resourceId: fields.resourceId,
      mode: 'governed' as const,
      encryptionVersion: fields.encryptionVersion,
      ipAddress: fields.ipAddress,
      metadata: fields.metadata ? JSON.parse(fields.metadata) : undefined,
    },
  }));
}
