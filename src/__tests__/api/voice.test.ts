/**
 * ═══════════════════════════════════════════════════════════════════
 * Integration Tests — POST /api/voice
 *
 * Mocks: jose JWT signing, Redis session lookup, vectorClient, rateLimit
 * Validates: JWT generation, session validation, error handling
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

/* ─── Env Vars ────────────────────────────────────────────────── */
process.env.VOICE_PROXY_URL = 'wss://proxy.example.com';
process.env.VOICE_PROXY_SECRET = 'test-voice-secret-key-32chars!!!';
process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-redis-token';
process.env.UPSTASH_VECTOR_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_VECTOR_REST_TOKEN = 'mock-token';
process.env.AXIOM_AUTH_BYPASS = 'true';

/* ─── Mocks ───────────────────────────────────────────────────── */

vi.mock('@/lib/vectorClient', () => ({
  namespaceHasVectors: vi.fn().mockResolvedValue(true),
}));

// Mock auth PEP (Phase 1)
vi.mock('@/lib/auth', () => ({
  authenticateRequest: vi.fn().mockResolvedValue({
    userId: 'dev-user-001',
    email: 'dev@axiom.local',
  }),
}));

vi.mock('@/lib/redis', () => ({
  validateSessionOwnership: vi.fn().mockResolvedValue({
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    userId: 'dev-user-001',
    status: 'active',
    createdAt: new Date().toISOString(),
  }),
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));

// Mock jose to avoid jsdom Uint8Array incompatibility
vi.mock('jose', () => ({
  SignJWT: class MockSignJWT {
    constructor() {
      // no-op
    }
    setProtectedHeader() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'mock-jwt-token'; }
  },
}));

describe('POST /api/voice', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/voice/route');
    POST = mod.POST;
  });

  it('returns 400 on missing sessionId', async () => {
    const req = new Request('http://localhost/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'en' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-UUID sessionId', async () => {
    const req = new Request('http://localhost/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'not-a-uuid', lang: 'en' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns wsUrl with JWT on valid request', async () => {
    const req = new Request('http://localhost/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        lang: 'en',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.wsUrl).toBeDefined();
    expect(typeof body.wsUrl).toBe('string');
    expect(body.wsUrl).toContain('proxy.example.com');
  });
});
