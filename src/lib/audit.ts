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
import { Storage } from '@google-cloud/storage';

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

  // Phase 5 Trace: Register this tenant in the active audit set for the draining worker.
  // This allows the archiver to find all streams without using the 'KEYS' command.
  if (tenantId && tenantId !== 'system') {
    await redis.sadd('active_audit_tenants', tenantId);
  }

  // Stream Throttling (Architectural Requirement #4)
  // If a massive ingestion event occurs, don't wait for the 24h cron to drain.
  // By running an emergency drain when we burst past 5,000 entries, we protect Redis RAM.
  const streamLen = await redis.xlen(streamKey);
  if (streamLen > 5000) {
    console.warn(`[Audit-Throttle] 🌊 High water mark reached for ${streamKey} (${streamLen} entries). Dispatching QStash emergency drain.`);
    const qstashToken = process.env.QSTASH_TOKEN;
    const appUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    
    if (qstashToken) {
      // Fire-and-forget QStash publish. It will hit the /api/cron/archive-audit endpoint, 
      // ensuring the heavy GCP upload gets a full 300s serverless/cloud-run timeout, preventing cut-offs.
      import('@upstash/qstash').then(({ Client }) => {
        const qstash = new Client({ token: qstashToken });
        return qstash.publishJSON({
          url: `${appUrl}/api/cron/archive-audit`,
          body: { reason: 'high_water_mark' }
        });
      }).catch(err => {
        console.error(`[Audit-Throttle] 🚨 Failed to dispatch emergency drain to QStash:`, err);
      });
    } else {
      console.warn(`[Audit-Throttle] ⚠️ QSTASH_TOKEN missing. Skipping emergency dispatch.`);
    }
  }

  console.log(
    `[Audit] ${action} | actor=${actorId} | resource=${resourceId} | stream=${streamKey} | id=${streamId}`
  );

  return streamId as string;
}

/**
 * Drains and archives all active audit streams.
 *
 * Pattern:
 * 1. Fetch all tenantIds from 'active_audit_tenants'.
 * 2. For each tenant (and 'system'):
 *    a) XRANGE all entries.
 *    b) Log/Archive (Mocking BigQuery handoff).
 *    c) XTRIM to clear the stream after confirmation.
 */
export async function drainAuditStreams(): Promise<{ processed: number; streams: string[] }> {
  const redis = getRedis();

  const bucketName = process.env.AUDIT_ARCHIVE_BUCKET;
  if (!bucketName) {
    console.warn('[Audit] ⚠️ AUDIT_ARCHIVE_BUCKET not set. Skipping persistent GCS archival.');
    return { processed: 0, streams: [] };
  }

  // CONCURRENCY LOCK (Architectural Requirement: Drain Storm Prevention)
  const LOCK_KEY = 'lock:audit_drain';
  // set with NX and EX (30 seconds TTL)
  const acquired = await redis.set(LOCK_KEY, 'locked', { nx: true, ex: 30 });
  if (!acquired) {
    console.warn('[Audit-Drain] ⚠️ Drain job is already locked by another worker. Aborting current execution to prevent Drain Storms.');
    return { processed: 0, streams: [] };
  }

  try {
    const rawTenants = await redis.smembers('active_audit_tenants');
    const tenants = Array.from(new Set(['system', ...rawTenants]));
    
    const results = { processed: 0, streams: [] as string[] };

    for (const tenant of tenants) {
    const key = resolveStreamKey(tenant);
    const entries = await readAuditLog(tenant, 1000); // Batch size 1000
    
    if (entries.length === 0) continue;

    // ═══════════════════════════════════════════════════════════════
    // ARCHIVE HANDOFF (Architectural Requirement #3)
    // Converts entries to JSONL and uploads to a GCS bucket.
    // ═══════════════════════════════════════════════════════════════
    console.log(`[Audit-Drain] Archiving ${entries.length} entries for stream=${key}`);
    
    const bucketName = process.env.AUDIT_ARCHIVE_BUCKET;
    if (bucketName) {
      try {
        const storage = new Storage();
        const bucket = storage.bucket(bucketName);
        const dateStr = new Date().toISOString().split('T')[0];
        // Ensure tenant identity is preserved in path for SOC2 data sovereignty checks
        const cleanTenant = tenant.replace(/[^a-zA-Z0-9-_]/g, '_');
        const filename = `audit/tenant=${cleanTenant}/date=${dateStr}/${Date.now()}.jsonl`;
        const file = bucket.file(filename);

        const jsonl = entries.map(e => JSON.stringify({ streamId: e.streamId, ...e.entry })).join('\n');
        await file.save(jsonl, {
          contentType: 'application/json', // Can be application/jsonl or application/x-ndjson
        });
        console.log(`[Audit-Drain] 🔒 Successfully persisted to GCP: gs://${bucketName}/${filename}`);
      } catch (gcsErr) {
        console.error(`[Audit-Drain] 🚨 GCS Upload failed for ${key}:`, gcsErr);
        // Hard security constraint: DO NOT trim the stream if persistence fails!
        continue; 
      }
    } else {
      console.warn(`[Audit-Drain] ⚠️ AUDIT_ARCHIVE_BUCKET not set. Skipping physical GCP archive for ${key}.`);
    }

    // Once physically archived (or purposefully bypassed if bucket omitted), we trim.
    // We trim everything UP TO the last read ID to safely free Redis memory.
    const lastId = entries[entries.length - 1].streamId;
    // @ts-expect-error Upstash Redis types don't officially support MINID but the server does
    await redis.xtrim(key, 'MINID', lastId);
    
    results.processed += entries.length;
    results.streams.push(key);
    }

    return results;
  } finally {
    // Release the concurrency lock so future crons/throttles can run
    await redis.del(LOCK_KEY);
  }
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
