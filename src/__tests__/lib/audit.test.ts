/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/audit.ts
 *
 * Phase 3: Governance Suite — Audit Trail Verification
 *
 * Scenarios:
 * 1. Append log entries to tenant streams via XADD.
 * 2. Proper flattening of metadata objects into strings.
 * 3. Read back entries via XRANGE with correct ID parsing.
 * 4. System-level audit routing for global events.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appendAuditLog, readAuditLog, auditDocumentUpload } from '@/lib/audit';
import { getRedis } from '@/lib/redis';

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(),
}));

describe('Audit Trail Service', () => {
  const mockRedis = {
    xadd: vi.fn(),
    xrange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (getRedis as any).mockReturnValue(mockRedis);
  });

  describe('appendAuditLog', () => {
    it('appends formatted entry to the correct tenant stream', async () => {
      const tenantId = 'acme-inc';
      const actorId = 'user-001';
      const action = 'DOCUMENT_UPLOADED';
      const resourceId = 'gov_session-123';
      
      mockRedis.xadd.mockResolvedValue('1713234567890-0');

      const streamId = await appendAuditLog(tenantId, actorId, action, resourceId, {
        encryptionVersion: 'v1',
        metadata: { fileName: 'confidential.pdf' }
      });

      expect(streamId).toBe('1713234567890-0');
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'audit_trail:acme-inc',
        '*',
        expect.objectContaining({
          actorId: 'user-001',
          action: 'DOCUMENT_UPLOADED',
          metadata: JSON.stringify({ fileName: 'confidential.pdf' })
        })
      );
    });

    it('routes to system stream when tenantId is undefined', async () => {
      await appendAuditLog(undefined, 'SYSTEM', 'SECURITY_HALT', 'global');
      expect(mockRedis.xadd).toHaveBeenCalledWith('audit_trail:system', '*', expect.anything());
    });
  });

  describe('readAuditLog', () => {
    it('parses Redis stream entries back into structured objects', async () => {
      const tenantId = 'acme-inc';
      // Mock raw output from Upstash Redis (Array of [id, fields])
      mockRedis.xrange.mockResolvedValue([
        [
          '1713234567890-0', 
          { 
            timestamp: '2024-04-16T12:00:00Z', 
            actorId: 'user-1', 
            action: 'SESSION_CREATED',
            resourceId: 'res-1',
            metadata: JSON.stringify({ key: 'val' })
          }
        ]
      ]);

      const log = await readAuditLog(tenantId);

      expect(log.length).toBe(1);
      expect(log[0].streamId).toBe('1713234567890-0');
      expect(log[0].entry.action).toBe('SESSION_CREATED');
      expect(log[0].entry.metadata).toEqual({ key: 'val' });
    });
  });

  describe('Convenience Wrappers', () => {
    it('auditDocumentUpload calls append with correct parameters', async () => {
      await auditDocumentUpload('t1', 'u1', 's1', 'file.txt', 'v1');
      
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'audit_trail:t1',
        '*',
        expect.objectContaining({
          action: 'DOCUMENT_UPLOADED',
          resourceId: 'gov_s1'
        })
      );
    });
  });
});
