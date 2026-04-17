/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/vectorClient.ts
 *
 * Phase 5: Dual-Mode Architecture
 *
 * Validates:
 * - Batched upsert with mode routing (ephemeral/governed)
 * - BYOK validation gate (governed must have encryptionVersion)
 * - Namespace prefix shield (eph_/gov_ prefixing)
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

// Set env vars before importing the module — TWO DISTINCT physical indexes
process.env.AXIOM_0_VECTOR_URL = 'https://mock-ephemeral.upstash.io';
process.env.AXIOM_0_VECTOR_TOKEN = 'mock-ephemeral-token';
process.env.AXIOM_G_VECTOR_URL = 'https://mock-governed.upstash.io';
process.env.AXIOM_G_VECTOR_TOKEN = 'mock-governed-token';

import {
  upsertVectors,
  queryVectors,
  deleteNamespace,
  namespaceHasVectors,
  resolveNamespace,
} from '@/lib/vectorClient';
import { withRetry } from '@/lib/retry';
import { NAMESPACE_PREFIX } from '@/lib/types';

describe('vectorClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveNamespace', () => {
    it('prefixes ephemeral sessions with eph_', () => {
      expect(resolveNamespace('abc-123', 'ephemeral', undefined)).toBe('eph_abc-123');
    });

    it('prefixes governed sessions with gov_', () => {
      expect(resolveNamespace('abc-123', 'governed', 'tenant-123')).toBe('gov_tenant-123_abc-123');
    });
  });

  describe('upsertVectors', () => {
    it('upserts a small ephemeral batch in a single call', async () => {
      const vectors = Array.from({ length: 5 }, (_, i) => ({
        id: `chunk-${i}`,
        vector: [0.1, 0.2, 0.3],
        metadata: { source: 'test.pdf', chunkIndex: i, totalChunks: 5, text: `text-${i}`, parentMacroId: 'macro-test.pdf-0', macroText: 'full section text' },
      }));

      await upsertVectors('session-123', 'ephemeral', undefined, vectors);

      expect(mockNamespace).toHaveBeenCalledWith(`${NAMESPACE_PREFIX.EPHEMERAL}session-123`);
      expect(withRetry).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert.mock.calls[0]![0]).toHaveLength(5);
    });

    it('batches 250 vectors into 3 calls (100+100+50)', async () => {
      const vectors = Array.from({ length: 250 }, (_, i) => ({
        id: `chunk-${i}`,
        vector: [0.1],
        metadata: { source: 'big.pdf', chunkIndex: i, totalChunks: 250, text: `t-${i}`, parentMacroId: `macro-big.pdf-${Math.floor(i / 30)}`, macroText: 'macro' },
      }));

      await upsertVectors('session-456', 'ephemeral', undefined, vectors);

      expect(withRetry).toHaveBeenCalledTimes(3);
      expect(mockUpsert).toHaveBeenCalledTimes(3);

      // Verify batch sizes
      expect(mockUpsert.mock.calls[0]![0]).toHaveLength(100);
      expect(mockUpsert.mock.calls[1]![0]).toHaveLength(100);
      expect(mockUpsert.mock.calls[2]![0]).toHaveLength(50);
    });

    it('routes governed upserts to the governed namespace', async () => {
      const vectors = [{
        id: 'chunk-0',
        vector: [0.1],
        metadata: { source: 'doc.pdf', chunkIndex: 0, totalChunks: 1, text: 'hello', parentMacroId: 'macro-0', macroText: 'section', encryptionVersion: 'v1' },
      }];

      await upsertVectors('gov-session', 'governed', 'tenant-123', vectors);

      expect(mockNamespace).toHaveBeenCalledWith(`${NAMESPACE_PREFIX.GOVERNED}gov-session`);
    });

    it('REJECTS governed vectors without encryptionVersion (BYOK gate)', async () => {
      const vectors = [{
        id: 'chunk-0',
        vector: [0.1],
        metadata: { source: 'doc.pdf', chunkIndex: 0, totalChunks: 1, text: 'hello', parentMacroId: 'macro-0', macroText: 'section' },
        // encryptionVersion intentionally missing
      }];

      await expect(upsertVectors('gov-session', 'governed', 'tenant-123', vectors))
        .rejects.toThrow(/BYOK compliance violation/);

      // Verify NO upsert was attempted
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('queryVectors', () => {
    it('queries the correct namespace with topK', async () => {
      mockQuery.mockResolvedValueOnce([
        { id: 'c-0', score: 0.95, metadata: { source: 'doc.pdf', chunkIndex: 0, totalChunks: 1, text: 'hello', parentMacroId: 'macro-doc.pdf-0', macroText: 'section text' } },
      ]);

      const results = await queryVectors('session-789', 'ephemeral', undefined, [0.1, 0.2], 5);

      expect(mockNamespace).toHaveBeenCalledWith(`${NAMESPACE_PREFIX.EPHEMERAL}session-789`);
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
        { id: 'c-1', score: 0.8, metadata: { source: 'a.pdf', chunkIndex: 0, totalChunks: 1, text: 'ok', parentMacroId: 'macro-a.pdf-0', macroText: 'section' } },
      ]);

      const results = await queryVectors('s', 'ephemeral', undefined, [0.1], 5);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('c-1');
    });
  });

  describe('deleteNamespace', () => {
    it('resets the correct ephemeral namespace', async () => {
      await deleteNamespace('session-to-delete', 'ephemeral', undefined);
      expect(mockNamespace).toHaveBeenCalledWith(`${NAMESPACE_PREFIX.EPHEMERAL}session-to-delete`);
      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('namespaceHasVectors', () => {
    it('returns false when namespace is empty', async () => {
      mockRange.mockResolvedValueOnce({ vectors: [] });
      expect(await namespaceHasVectors('empty-ns', 'ephemeral', undefined)).toBe(false);
    });

    it('returns true when namespace has vectors', async () => {
      mockRange.mockResolvedValueOnce({ vectors: [{ id: 'x' }] });
      expect(await namespaceHasVectors('full-ns', 'ephemeral', undefined)).toBe(true);
    });
  });
});
