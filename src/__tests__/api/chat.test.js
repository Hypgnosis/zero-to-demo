/**
 * Integration Tests for POST /api/chat
 *
 * Validates the RAG chat endpoint: auth guard, input validation, vector store
 * guard, successful streaming path, and error handling.
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

vi.mock('@langchain/google-genai', () => {
  class FakeChatModel {
    constructor() {}
  }
  return { ChatGoogleGenerativeAI: FakeChatModel };
});

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn(() => ({})),
  },
}));

const mockStream = {
  [Symbol.asyncIterator]: async function* () {
    yield new TextEncoder().encode('Hello');
    yield new TextEncoder().encode(' World');
  },
};

vi.mock('@langchain/core/runnables', () => ({
  RunnableSequence: {
    from: vi.fn(() => ({
      stream: vi.fn().mockResolvedValue(mockStream),
    })),
  },
}));

vi.mock('langchain/output_parsers', () => {
  class FakeParser {}
  return { HttpResponseOutputParser: FakeParser };
});

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

    mockVectorStore.memoryVectors = [{ id: 'v1' }];
    mockVectorStore.similaritySearch.mockResolvedValue([
      { pageContent: 'Widget A supports 500 PSI pressure.' },
      { pageContent: 'Widget B is stainless steel.' },
    ]);

    const mod = await import('@/app/api/chat/route');
    POST = mod.POST;
  });

  // ── Auth guard ────────────────────────────────────────────────────────────
  it('returns 401 when GOOGLE_API_KEY is the placeholder value', async () => {
    process.env.GOOGLE_API_KEY = 'your_google_api_key_here';
    const mod = await import('@/app/api/chat/route');
    const res = await mod.POST(buildRequest({ messages: [{ role: 'user', text: 'hi' }] }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toContain('CRITICAL');
  });

  it('returns 401 when GOOGLE_API_KEY is empty', async () => {
    process.env.GOOGLE_API_KEY = '';
    const mod = await import('@/app/api/chat/route');
    const res = await mod.POST(buildRequest({ messages: [{ role: 'user', text: 'hi' }] }));

    expect(res.status).toBe(401);
  });

  // ── Input validation ─────────────────────────────────────────────────────
  it('returns 400 when messages array is empty', async () => {
    const res = await POST(buildRequest({ messages: [] }));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('No messages');
  });

  it('returns 400 when messages is undefined', async () => {
    const res = await POST(buildRequest({}));
    const data = await res.json();

    expect(res.status).toBe(400);
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
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('calls similaritySearch with the latest query and k=4', async () => {
    await POST(
      buildRequest({
        messages: [
          { role: 'user', text: 'first' },
          { role: 'ai', text: 'reply' },
          { role: 'user', text: 'latest question' },
        ],
      })
    );

    expect(mockVectorStore.similaritySearch).toHaveBeenCalledWith('latest question', 4);
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
