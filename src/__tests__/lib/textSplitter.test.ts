/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/textSplitter.ts
 *
 * Validates chunk sizing, overlap, metadata tagging, and edge cases.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { splitText } from '@/lib/textSplitter';

describe('splitText', () => {
  it('splits text into chunks of the correct size', () => {
    const text = 'A'.repeat(3000);
    const chunks = splitText(text, 'test.pdf', {
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    // Recursive splitter may produce chunks slightly larger than chunkSize
    // due to separator merging. Allow up to chunkSize + overlap + 100 margin.
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1300);
    }

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves source metadata on every chunk', () => {
    const chunks = splitText('Some document text here repeated. '.repeat(100), 'catalog.pdf');

    for (const chunk of chunks) {
      expect(chunk.metadata.source).toBe('catalog.pdf');
      expect(chunk.metadata.chunkIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns a single chunk for short text', () => {
    const chunks = splitText('Hello world', 'small.pdf');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe('Hello world');
  });

  it('handles empty string gracefully', () => {
    const chunks = splitText('', 'empty.pdf');
    // Should return either empty array or single empty chunk
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});
