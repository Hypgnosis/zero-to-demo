/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 / AXIOM-G — Vector Client (Phase 5: Physical Isolation)
 *
 * THE IRON WALL: Two physical Upstash Vector indexes.
 * Ephemeral and governed data NEVER share an instance.
 * Even if a credential leak exposes one index, the other is untouched.
 *
 * STARTUP COLLISION CHECK: If AXIOM_0 and AXIOM_G point to the same
 * physical URL, the process refuses to start. This prevents a
 * developer from accidentally defeating isolation via copy-paste .env.
 *
 * BYOK VALIDATION: Governed upserts MUST include encryptionVersion.
 * Unversioned data in the enterprise index is a compliance violation.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Index } from '@upstash/vector';
import { withRetry } from './retry';
import { createLimiter } from './concurrency';
import { Errors } from '@/lib/errors';
import { NAMESPACE_PREFIX } from './types';
import type { AxiomMode, VectorMetadata } from './types';

/** Upstash requires metadata with string index signature. */
type VectorMeta = VectorMetadata & Record<string, unknown>;

/* ─── Startup Collision Guard ─────────────────────────────────── */

/**
 * Phase 5: Physical Isolation Enforcement.
 * Executed once at module load time. If both vector URLs are set
 * AND identical, the system is misconfigured — physical isolation
 * is defeated. We refuse to boot rather than silently commingle data.
 *
 * This check is intentionally at module scope (not lazy) because
 * a misconfigured deployment must fail BEFORE serving any request.
 */
const _ephUrl = process.env.AXIOM_0_VECTOR_URL;
const _govUrl = process.env.AXIOM_G_VECTOR_URL;

if (_ephUrl && _govUrl && _ephUrl === _govUrl) {
  console.error(
    '🚨 PHYSICAL ISOLATION VIOLATION: AXIOM_0_VECTOR_URL and AXIOM_G_VECTOR_URL ' +
    'resolve to the same physical index. Ephemeral and governed data would be commingled. ' +
    'This is a critical configuration error. Refusing to start.'
  );
  process.exit(1);
}

/* ─── Two-Index Factory ───────────────────────────────────────── */

let ephemeralIndex: Index | null = null;
let governedIndex: Index | null = null;

/**
 * Returns the vector index for the requested mode.
 * Each mode has its own physical Upstash instance with separate credentials.
 *
 * FAIL-TO-EPHEMERAL: This function does not default — the caller
 * must provide an explicit mode. The resolveMode() function in
 * validation.ts handles the fail-to-ephemeral logic upstream.
 */
function getVectorIndex(mode: AxiomMode): Index {
  if (mode === 'governed') {
    if (!governedIndex) {
      const url = process.env.AXIOM_G_VECTOR_URL;
      const token = process.env.AXIOM_G_VECTOR_TOKEN;
      if (!url || !token) {
        throw Errors.configMissing('AXIOM_G_VECTOR_URL and/or AXIOM_G_VECTOR_TOKEN');
      }
      governedIndex = new Index({ url, token });
    }
    return governedIndex;
  }

  // Ephemeral (default physical index)
  if (!ephemeralIndex) {
    const url = process.env.AXIOM_0_VECTOR_URL;
    const token = process.env.AXIOM_0_VECTOR_TOKEN;
    if (!url || !token) {
      throw Errors.configMissing('AXIOM_0_VECTOR_URL and/or AXIOM_0_VECTOR_TOKEN');
    }
    ephemeralIndex = new Index({ url, token });
  }
  return ephemeralIndex;
}

/* ─── Namespace Resolution ────────────────────────────────────── */

/**
 * Constructs the prefixed namespace string for a session.
 * The prefix is derived from the mode via NAMESPACE_PREFIX constants,
 * AND strictly bound to the tenant_id to prevent cross-tenant vector contamination.
 *
 * @param sessionId - Raw session UUID.
 * @param mode      - The operational mode (ephemeral or governed).
 * @param tenantId  - The verified tenant ID from the JWT.
 * @returns Prefixed namespace string (e.g., "eph_tenantId_abc123" or "gov_tenantId_abc123").
 */
export function resolveNamespace(sessionId: string, mode: AxiomMode, tenantId: string | undefined): string {
  const prefix = mode === 'governed'
    ? NAMESPACE_PREFIX.GOVERNED
    : NAMESPACE_PREFIX.EPHEMERAL;
  const tn = tenantId && tenantId.trim() !== '' ? tenantId : 'anon';
  return `${prefix}${tn}_${sessionId}`;
}

/* ─── Upsert ──────────────────────────────────────────────────── */

export async function upsertVectors(
  sessionId: string,
  mode: AxiomMode,
  tenantId: string | undefined,
  vectors: { id: string; vector: number[]; metadata: VectorMetadata }[]
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════
  // BYOK VALIDATION GATE
  // ═══════════════════════════════════════════════════════════════
  if (mode === 'governed') {
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i]!.metadata.encryptionVersion) {
        throw Errors.securityViolation(
          `Governed vector ${vectors[i]!.id} (index ${i}) is missing encryptionVersion.`
        );
      }
    }
  }

  const index = getVectorIndex(mode);
  const namespace = resolveNamespace(sessionId, mode, tenantId);
  const ns = index.namespace(namespace);

  const BATCH_SIZE = 100;

  // Bounded concurrency: max 5 simultaneous upserts to prevent
  // 429 rate-limit storms and socket pool exhaustion on serverless.
  const limit = createLimiter(5);
  const batchPromises = [];
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    const formattedBatch = batch.map((v) => ({
      id: v.id,
      vector: v.vector,
      metadata: v.metadata as VectorMeta,
    }));
    batchPromises.push(
      limit(() => withRetry(() => ns.upsert(formattedBatch), { label: `upsert-batch-${i}` }))
    );
  }

  console.log(`[VectorClient] Upserting ${vectors.length} vectors in ${batchPromises.length} batches (concurrency=5)`);
  await Promise.all(batchPromises);
}

/* ─── Query ───────────────────────────────────────────────────── */

export interface VectorQueryResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export async function queryVectors(
  sessionId: string,
  mode: AxiomMode,
  tenantId: string | undefined,
  queryVector: number[],
  topK: number = 5
): Promise<VectorQueryResult[]> {
  const index = getVectorIndex(mode);
  const namespace = resolveNamespace(sessionId, mode, tenantId);
  const ns = index.namespace(namespace);

  const results = await ns.query<VectorMeta>({
    vector: queryVector,
    topK,
    includeMetadata: true,
  });

  return results
    .filter((r) => r.metadata != null)
    .map((r) => ({
      id: String(r.id),
      score: r.score,
      metadata: r.metadata as VectorMetadata,
    }));
}

/* ─── Namespace Management ────────────────────────────────────── */

export async function namespaceHasVectors(
  sessionId: string,
  mode: AxiomMode,
  tenantId: string | undefined
): Promise<boolean> {
  const index = getVectorIndex(mode);
  const namespace = resolveNamespace(sessionId, mode, tenantId);
  const ns = index.namespace(namespace);
  const probe = await ns.range({ cursor: 0, limit: 1 });
  return probe.vectors.length > 0;
}

export async function getNamespaceContext(
  sessionId: string,
  mode: AxiomMode,
  tenantId: string | undefined,
  maxChunks: number = 50
): Promise<string> {
  const index = getVectorIndex(mode);
  const namespace = resolveNamespace(sessionId, mode, tenantId);
  const ns = index.namespace(namespace);

  const results = await ns.range<VectorMeta>({
    cursor: 0,
    limit: maxChunks,
    includeMetadata: true,
  });

  if (results.vectors.length === 0) return '';

  return results.vectors
    .filter((v) => v.metadata?.text)
    .map((v) => v.metadata!.text)
    .join('\n\n---\n\n');
}

export async function deleteNamespace(
  sessionId: string,
  mode: AxiomMode,
  tenantId: string | undefined
): Promise<void> {
  const index = getVectorIndex(mode);
  const namespace = resolveNamespace(sessionId, mode, tenantId);
  const ns = index.namespace(namespace);
  await ns.reset();
}
