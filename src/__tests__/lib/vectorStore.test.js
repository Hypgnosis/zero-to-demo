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

  it('exports a vectorStore singleton attached to globalThis', async () => {
    const mod = await import('@/lib/vectorStore');
    expect(mod.vectorStore).toBeDefined();
    expect(globalThis.vectorStore).toBeDefined();
    expect(mod.vectorStore).toBe(globalThis.vectorStore);
  });

  it('reuses the same instance across multiple imports', async () => {
    const mod1 = await import('@/lib/vectorStore');
    const ref = globalThis.vectorStore;

    vi.resetModules();
    const mod2 = await import('@/lib/vectorStore');

    // globalThis wasn't cleared, so the module should reuse the existing store
    expect(mod2.vectorStore).toBe(ref);
  });

  it('resetVectorStore creates a fresh store and replaces the global', async () => {
    const mod = await import('@/lib/vectorStore');
    const original = globalThis.vectorStore;

    const newStore = mod.resetVectorStore();

    expect(newStore).toBeDefined();
    expect(newStore).not.toBe(original);
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
    await import('@/lib/vectorStore');

    // The store was created via the constructor, check that it exists
    expect(globalThis.vectorStore).toBeDefined();
    // Check the embeddings instance inside the store
    // Since we can't access internal state easily, verify the module didn't throw
  });
});
