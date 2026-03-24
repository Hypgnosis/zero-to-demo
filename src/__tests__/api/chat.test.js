/**
 * Integration Tests for POST /api/chat
 *
 * Validates the RAG chat endpoint: vector store guard, successful streaming
 * path (model.pipe(StringOutputParser).stream), and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
let mockVectorStore = {
  memoryVectors: [],
  similaritySearch: vi.fn().mockResolvedValue([]),
};

vi.mock('@/lib/vectorStore', () => ({
  getVectorStore: () => mockVectorStore,
}));

// Mock the new route architecture: model.pipe(parser).stream([messages])
const mockStream = (async function* () {
  yield 'Hello';
  yield ' World';
})();

vi.mock('@langchain/google-genai', () => {
  class FakeChatModel {
    constructor() {}
    pipe() {
      return {
        stream: vi.fn().mockResolvedValue(mockStream),
      };
    }
  }
  return { ChatGoogleGenerativeAI: FakeChatModel };
});

vi.mock('@langchain/core/output_parsers', () => {
  class FakeStringOutputParser {}
  return { StringOutputParser: FakeStringOutputParser };
});

vi.mock('@langchain/core/messages', () => ({
  SystemMessage: class { constructor(text) { this.text = text; } },
  HumanMessage: class { constructor(text) { this.text = text; } },
}));

// ─── Helper ───────────────────────────────────────────────────────────────────
function buildRequest(body) {
  return {
    json: () => Promise.resolve(body),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('POST /api/chat', () => {
  let POST;

  beforeEach(async () => {
    vi.resetModules();

    process.env.GOOGLE_API_KEY = 'real-key-here';

    mockVectorStore.memoryVectors = [{ id: 'v1', content: 'test' }];
    mockVectorStore.similaritySearch.mockResolvedValue([
      { pageContent: 'Widget A supports 500 PSI pressure.' },
      { pageContent: 'Widget B is stainless steel.' },
    ]);

    const mod = await import('@/app/api/chat/route');
    POST = mod.POST;
  });

  // ── Vector store guard ────────────────────────────────────────────────────
  it('returns 400 when vector store has no documents', async () => {
    mockVectorStore.memoryVectors = [];
    const mod = await import('@/app/api/chat/route');
    const res = await mod.POST(buildRequest({ messages: [{ role: 'user', text: 'hi' }] }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('No catalog data');
  });

  // ── Successful streaming path ─────────────────────────────────────────────
  it('returns a streaming Response with correct Content-Type on success', async () => {
    const res = await POST(
      buildRequest({ messages: [{ role: 'user', text: 'What is Widget A?' }] })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('calls similaritySearch with the latest query and k=30', async () => {
    await POST(
      buildRequest({
        messages: [
          { role: 'user', text: 'first' },
          { role: 'ai', text: 'reply' },
          { role: 'user', text: 'latest question' },
        ],
      })
    );

    expect(mockVectorStore.similaritySearch).toHaveBeenCalledWith('latest question', 30);
  });

  // ── Error handling ────────────────────────────────────────────────────────
  it('returns 500 when an unexpected error occurs', async () => {
    const badReq = {
      json: () => Promise.reject(new Error('bad body')),
    };

    const res = await POST(badReq);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain('bad body');
  });
});
