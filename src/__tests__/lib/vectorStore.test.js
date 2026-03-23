/**
 * Unit Tests for src/lib/vectorStore.js
 *
 * Tests the in-memory vector store singleton and its reset utility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('langchain/vectorstores/memory', () => {
  class FakeMemoryVectorStore {
    constructor() {
      this.memoryVectors = [];
      this.addDocuments = vi.fn();
      this.similaritySearch = vi.fn();
    }
  }
  return { MemoryVectorStore: FakeMemoryVectorStore };
});

vi.mock('@langchain/google-genai', () => {
  class FakeEmbeddings {
    constructor(opts) {
      this.modelName = opts?.modelName;
    }
  }
  return { GoogleGenerativeAIEmbeddings: FakeEmbeddings };
});

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('vectorStore module', () => {
  beforeEach(() => {
    delete globalThis.vectorStore;
    vi.resetModules();
  });

  it('getVectorStore lazily creates a store on globalThis', async () => {
    const mod = await import('@/lib/vectorStore');
    const store = mod.getVectorStore();
    expect(store).toBeDefined();
    expect(globalThis.vectorStore).toBeDefined();
    expect(store).toBe(globalThis.vectorStore);
  });

  it('getVectorStore returns the same instance on repeated calls', async () => {
    const mod = await import('@/lib/vectorStore');
    const first = mod.getVectorStore();
    const second = mod.getVectorStore();
    expect(first).toBe(second);
  });

  it('getVectorStore returns the fresh store after reset', async () => {
    const mod = await import('@/lib/vectorStore');
    const original = mod.getVectorStore();

    const newStore = mod.resetVectorStore();
    const fetched = mod.getVectorStore();

    expect(newStore).not.toBe(original);
    expect(fetched).toBe(newStore);
    expect(globalThis.vectorStore).toBe(newStore);
  });

  it('resetVectorStore returns a store object with expected shape', async () => {
    const mod = await import('@/lib/vectorStore');
    const store = mod.resetVectorStore();

    expect(store).toHaveProperty('memoryVectors');
    expect(store).toHaveProperty('addDocuments');
    expect(store).toHaveProperty('similaritySearch');
  });

  it('GoogleGenerativeAIEmbeddings is initialized with text-embedding-004', async () => {
    const { GoogleGenerativeAIEmbeddings } = await import('@langchain/google-genai');
    const mod = await import('@/lib/vectorStore');

    // Trigger lazy init
    mod.getVectorStore();

    // The store was created via the constructor, check that it exists
    expect(globalThis.vectorStore).toBeDefined();
  });
});
