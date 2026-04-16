/**
 * ═══════════════════════════════════════════════════════════════════
 * Integration Tests — POST /api/chat
 *
 * Mocks: Upstash Vector, Google GenAI, rateLimit, embeddings
 * Validates: Session gating, RAG pipeline, SSE response format
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

/* ─── Env Vars (must be set before imports) ───────────────────── */
process.env.GOOGLE_API_KEY = 'test-key';
process.env.AXIOM_0_VECTOR_URL = 'https://mock-ephemeral.upstash.io';
process.env.AXIOM_0_VECTOR_TOKEN = 'mock-ephemeral-token';
process.env.AXIOM_G_VECTOR_URL = 'https://mock-governed.upstash.io';
process.env.AXIOM_G_VECTOR_TOKEN = 'mock-governed-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-redis-token';
process.env.AXIOM_AUTH_BYPASS = 'true';

/* ─── Mocks ───────────────────────────────────────────────────── */

// Mock vectorClient (Phase 4: hierarchical metadata)
vi.mock('@/lib/vectorClient', () => ({
  queryVectors: vi.fn().mockResolvedValue([
    {
      id: 'micro-0',
      score: 0.92,
      metadata: {
        source: 'catalog.pdf',
        chunkIndex: 0,
        totalChunks: 3,
        text: 'Widget costs $50 per unit.',
        parentMacroId: 'macro-catalog.pdf-0',
        macroText: 'Product Catalog\n\n| Part | Price |\n|---|---|\n| Widget | $50 |\n| Sprocket | $75 |',
      },
    },
  ]),
  namespaceHasVectors: vi.fn().mockResolvedValue(true),
}));

// Mock embeddings
vi.mock('@/lib/embeddings', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedTexts: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  getGenAIClient: vi.fn(),
}));

// Mock Google GenAI for streaming chat
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGenAI {
      models = {
        generateContentStream: vi.fn().mockResolvedValue({
          async *[Symbol.asyncIterator]() {
            yield { text: 'Based on the catalog, widgets cost $50.' };
          },
        }),
      };
    },
  };
});

// Mock auth PEP (Phase 1)
vi.mock('@/lib/auth', () => ({
  authenticateRequest: vi.fn().mockResolvedValue({
    userId: 'dev-user-001',
    email: 'dev@axiom.local',
  }),
}));

// Mock session ownership (Phase 1)
vi.mock('@/lib/redis', () => ({
  validateSessionOwnership: vi.fn().mockResolvedValue({
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    userId: 'dev-user-001',
    status: 'active',
    createdAt: new Date().toISOString(),
  }),
}));

// Mock rate limiter (actual export name)
vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));

describe('POST /api/chat', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/chat/route');
    POST = mod.POST;
  });

  it('returns 400 on missing sessionId', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 on empty messages', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns streaming response on valid request', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'How much do widgets cost?' }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
