/**
 * ═══════════════════════════════════════════════════════════════════
 * Integration Tests — POST /api/upload
 *
 * Mocks: Vercel Blob, QStash client, Redis, rateLimit
 * Validates: File validation, session creation, QStash dispatch
 *
 * NOTE: The upload route reads sessionId from query parameters, not
 * form body. The session must be a valid UUID.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

/* ─── Env Vars ────────────────────────────────────────────────── */
process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-redis-token';
process.env.QSTASH_TOKEN = 'mock-qstash-token';
process.env.BLOB_READ_WRITE_TOKEN = 'mock-blob-token';
process.env.UPSTASH_VECTOR_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_VECTOR_REST_TOKEN = 'mock-token';

/* ─── Mocks ───────────────────────────────────────────────────── */

vi.mock('@vercel/blob', () => ({
  put: vi.fn().mockResolvedValue({
    url: 'https://blob.vercel.app/test.pdf',
  }),
}));

vi.mock('@upstash/qstash', () => ({
  Client: class MockQStash {
    publishJSON = vi.fn().mockResolvedValue({ messageId: 'qstash-msg-1' });
  },
}));

vi.mock('@/lib/redis', () => ({
  createSession: vi.fn().mockResolvedValue({
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'active',
    createdAt: new Date().toISOString(),
  }),
  getSession: vi.fn().mockResolvedValue({
    id: '550e8400-e29b-41d4-a716-446655440000',
    status: 'active',
    createdAt: new Date().toISOString(),
  }),
  createJob: vi.fn().mockResolvedValue(undefined),
  updateJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));

// Do NOT mock uuid — the route uses v4() internally for jobId generation

describe('POST /api/upload', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/upload/route');
    POST = mod.POST;
  });

  it('returns 400 when no file is provided', async () => {
    const formData = new FormData();
    const req = new Request(
      'http://localhost:3000/api/upload?sessionId=550e8400-e29b-41d4-a716-446655440000',
      { method: 'POST' }
    );
    req.formData = async () => formData;

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-PDF files (text/plain is actually allowed)', async () => {
    const formData = new FormData();
    formData.append(
      'file',
      new File(['hello'], 'test.exe', { type: 'application/x-msdownload' })
    );

    const req = new Request(
      'http://localhost:3000/api/upload?sessionId=550e8400-e29b-41d4-a716-446655440000',
      { method: 'POST' }
    );
    req.formData = async () => formData;

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('accepts a PDF and returns jobId with status 202', async () => {
    const formData = new FormData();
    formData.append(
      'file',
      new File(['%PDF-1.4 fake content'], 'catalog.pdf', {
        type: 'application/pdf',
      })
    );

    const req = new Request(
      'http://localhost:3000/api/upload?sessionId=550e8400-e29b-41d4-a716-446655440000',
      { method: 'POST' }
    );
    req.formData = async () => formData;

    const res = await POST(req);
    const body = await res.json();

    if (res.status !== 202) {
      console.error('Upload test response:', res.status, body);
    }

    expect(res.status).toBe(202);
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe('string');
    expect(body.status).toBe('accepted');
  });
});
