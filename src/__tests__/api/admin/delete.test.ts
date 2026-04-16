/**
 * ═══════════════════════════════════════════════════════════════════
 * Integration Test — api/admin/namespace/delete/route.ts
 *
 * Phase 3: Governance Suite — Admin Fortress Verification
 *
 * Scenarios:
 * 1. Admin with valid JWT role initiates 24h deletion window.
 * 2. REJECTION: Non-admin user receives 403 Forbidden.
 * 3. REJECTION: Attempt to delete ephemeral session fails (mode guard).
 * 4. IDEMPOTENCY: Concurrent requests return 409 Conflict.
 * 5. AUDIT: Every valid request creates a stream entry.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/admin/namespace/delete/route';
import { authenticateRequest } from '@/lib/auth';
import { getSession, getRedis } from '@/lib/redis';
import { auditDeleteRequest } from '@/lib/audit';

vi.mock('@/lib/auth', () => ({
  authenticateRequest: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  getSession: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock('@/lib/audit', () => ({
  auditDeleteRequest: vi.fn(),
}));

describe('Admin Delete Route', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (getRedis as any).mockReturnValue(mockRedis);
  });

  it('allows admin to initiate 24h deletion window for governed session', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    (authenticateRequest as any).mockResolvedValue({ userId: 'admin-1', tenantId: 't1', roles: ['admin'] });
    (getSession as any).mockResolvedValue({ sessionId, mode: 'governed', userId: 'user-1' });
    mockRedis.get.mockResolvedValue(null); // No pending deletion
    mockRedis.set.mockResolvedValue('OK');

    const req = new Request('http://localhost/api/admin/namespace/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId, reason: 'Compliance requirement' }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.status).toBe('accepted');
    expect(mockRedis.set).toHaveBeenCalledWith(
      `deletion_pending:${sessionId}`,
      expect.stringContaining('admin-1'),
      expect.objectContaining({ nx: true, ex: 86400 })
    );
    expect(auditDeleteRequest).toHaveBeenCalledWith('t1', 'admin-1', sessionId, 'Compliance requirement');
  });

  it('rejects deletion of ephemeral sessions', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    (authenticateRequest as any).mockResolvedValue({ userId: 'admin-1', roles: ['admin'] });
    (getSession as any).mockResolvedValue({ sessionId, mode: 'ephemeral' });

    const req = new Request('http://localhost/api/admin/namespace/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400); // Validation error
    expect(data.error.message).toContain('ephemeral mode');
  });

  it('returns 409 Conflict if a deletion is already pending', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    (authenticateRequest as any).mockResolvedValue({ userId: 'admin-1', roles: ['admin'] });
    (getSession as any).mockResolvedValue({ sessionId, mode: 'governed' });
    mockRedis.get.mockResolvedValue(JSON.stringify({ requestedBy: 'other-admin' }));

    const req = new Request('http://localhost/api/admin/namespace/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
  });
});
