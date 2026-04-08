/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/vectorClient.ts
 *
 * Validates:
 * - Batched upsert (groups of 100)
 * - Retry integration on 429 errors
 * - Namespace isolation (query/delete)
 *
 * All Upstash SDK calls are mocked.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the retry utility — we test retry logic separately
vi.mock('@/lib/retry', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// Mock the Upstash Vector SDK with a proper class constructor
const mockUpsert = vi.fn().mockResolvedValue(undefined);
const mockQuery = vi.fn().mockResolvedValue([]);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockRange = vi.fn().mockResolvedValue({ vectors: [] });

const mockNamespace = vi.fn(() => ({
  upsert: mockUpsert,
  query: mockQuery,
  reset: mockReset,
  range: mockRange,
}));

vi.mock('@upstash/vector', () => ({
  Index: class MockIndex {
    namespace = mockNamespace;
    constructor() {
      // no-op
    }
  },
}));

// Set env vars before importing the module
process.env.UPSTASH_VECTOR_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_VECTOR_REST_TOKEN = 'mock-token';

import {
  upsertVectors,
  queryVectors,
  deleteNamespace,
  namespaceHasVectors,
} from '@/lib/vectorClient';
import { withRetry } from '@/lib/retry';

describe('vectorClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('upsertVectors', () => {
    it('upserts a small batch in a single call', async () => {
      const vectors = Array.from({ length: 5 }, (_, i) => ({
        id: `chunk-${i}`,
        vector: [0.1, 0.2, 0.3],
        metadata: { source: 'test.pdf', chunkIndex: i, totalChunks: 5, text: `text-${i}` },
      }));

      await upsertVectors('session-123', vectors);

      expect(mockNamespace).toHaveBeenCalledWith('session-123');
      expect(withRetry).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert.mock.calls[0]![0]).toHaveLength(5);
    });

    it('batches 250 vectors into 3 calls (100+100+50)', async () => {
      const vectors = Array.from({ length: 250 }, (_, i) => ({
        id: `chunk-${i}`,
        vector: [0.1],
        metadata: { source: 'big.pdf', chunkIndex: i, totalChunks: 250, text: `t-${i}` },
      }));

      await upsertVectors('session-456', vectors);

      expect(withRetry).toHaveBeenCalledTimes(3);
      expect(mockUpsert).toHaveBeenCalledTimes(3);

      // Verify batch sizes
      expect(mockUpsert.mock.calls[0]![0]).toHaveLength(100);
      expect(mockUpsert.mock.calls[1]![0]).toHaveLength(100);
      expect(mockUpsert.mock.calls[2]![0]).toHaveLength(50);
    });
  });

  describe('queryVectors', () => {
    it('queries the correct namespace with topK', async () => {
      mockQuery.mockResolvedValueOnce([
        { id: 'c-0', score: 0.95, metadata: { source: 'doc.pdf', chunkIndex: 0, totalChunks: 1, text: 'hello' } },
      ]);

      const results = await queryVectors('session-789', [0.1, 0.2], 5);

      expect(mockNamespace).toHaveBeenCalledWith('session-789');
      expect(mockQuery).toHaveBeenCalledWith({
        vector: [0.1, 0.2],
        topK: 5,
        includeMetadata: true,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.metadata.text).toBe('hello');
    });

    it('filters out results with null metadata', async () => {
      mockQuery.mockResolvedValueOnce([
        { id: 'c-0', score: 0.9, metadata: null },
        { id: 'c-1', score: 0.8, metadata: { source: 'a.pdf', chunkIndex: 0, totalChunks: 1, text: 'ok' } },
      ]);

      const results = await queryVectors('s', [0.1], 5);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('c-1');
    });
  });

  describe('deleteNamespace', () => {
    it('resets the correct namespace', async () => {
      await deleteNamespace('session-to-delete');
      expect(mockNamespace).toHaveBeenCalledWith('session-to-delete');
      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('namespaceHasVectors', () => {
    it('returns false when namespace is empty', async () => {
      mockRange.mockResolvedValueOnce({ vectors: [] });
      expect(await namespaceHasVectors('empty-ns')).toBe(false);
    });

    it('returns true when namespace has vectors', async () => {
      mockRange.mockResolvedValueOnce({ vectors: [{ id: 'x' }] });
      expect(await namespaceHasVectors('full-ns')).toBe(true);
    });
  });
});
