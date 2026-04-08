import { Index } from '@upstash/vector';
import { withRetry } from './retry';
import type { VectorMetadata } from './types';

/** Upstash requires metadata with string index signature. */
type VectorMeta = VectorMetadata & Record<string, unknown>;

/* ─── Singleton Client ────────────────────────────────────────── */

let vectorIndex: Index | null = null;

function getVectorIndex(): Index {
  if (!vectorIndex) {
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN must be set.'
      );
    }

    vectorIndex = new Index({ url, token });
  }
  return vectorIndex;
}

/* ─── Upsert ──────────────────────────────────────────────────── */

/**
 * Inserts vectors into the session-scoped namespace.
 *
 * Strategy:
 * - Batches upserts into groups of 100 to respect API payload limits.
 * - Each batch is wrapped in withRetry() for exponential backoff on 429s.
 * - Sequential batch execution prevents thundering herd on the index.
 */
export async function upsertVectors(
  sessionId: string,
  vectors: { id: string; vector: number[]; metadata: VectorMetadata }[]
): Promise<void> {
  const index = getVectorIndex();
  const ns = index.namespace(sessionId);

  const BATCH_SIZE = 100;
  const totalBatches = Math.ceil(vectors.length / BATCH_SIZE);

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = vectors.slice(i, i + BATCH_SIZE).map((v) => ({
      id: v.id,
      vector: v.vector,
      metadata: v.metadata as VectorMeta,
    }));

    await withRetry(() => ns.upsert(batch), {
      label: `vector-upsert-batch-${batchNum}/${totalBatches}`,
      maxRetries: 5,
      baseDelayMs: 500,
    });
  }
}

/* ─── Query ───────────────────────────────────────────────────── */

export interface VectorQueryResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

/**
 * Queries the session-scoped namespace for similar vectors.
 * Returns top-K results with metadata.
 *
 * @param sessionId - The session namespace to search.
 * @param queryVector - The embedding vector of the user's query.
 * @param topK - Number of results to return (default: 5, per mandate).
 */
export async function queryVectors(
  sessionId: string,
  queryVector: number[],
  topK: number = 5
): Promise<VectorQueryResult[]> {
  const index = getVectorIndex();
  const ns = index.namespace(sessionId);

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

/**
 * Checks if a namespace has any vectors.
 */
export async function namespaceHasVectors(
  sessionId: string
): Promise<boolean> {
  const index = getVectorIndex();
  const ns = index.namespace(sessionId);
  // Use range with limit 1 to check if namespace has any vectors
  const probe = await ns.range({ cursor: 0, limit: 1 });
  return probe.vectors.length > 0;
}

/**
 * Retrieves ALL text content from a namespace (for voice agent context injection).
 * Fetches vectors by querying with a zero vector to get all results.
 */
export async function getNamespaceContext(
  sessionId: string,
  maxChunks: number = 50
): Promise<string> {
  const index = getVectorIndex();
  const ns = index.namespace(sessionId);

  // Fetch by range to get all stored text
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

/**
 * Deletes all vectors in a session namespace.
 * Used by cleanup cron and manual session purge.
 */
export async function deleteNamespace(sessionId: string): Promise<void> {
  const index = getVectorIndex();
  const ns = index.namespace(sessionId);
  await ns.reset();
}
