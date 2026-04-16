/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/kms.ts
 *
 * Phase 3: Governance Suite — Key Management Verification
 *
 * Scenarios:
 * 1. Store and resolve keys for governed sessions.
 * 2. Mixed-version decryption (v1 + v2) correctly fetches both keys.
 * 3. GRACEFUL FAILURE: Missing key for a version skips rather than crashes.
 * 4. KEY ROTATION: Prevents overwriting existing versions.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  decryptChunks, 
  resolveKeysForChunks, 
  storeVersionKey, 
  initiateKeyRotation,
  encrypt,
  decrypt
} from '@/lib/kms';
import { getRedis } from '@/lib/redis';

// Mock Redis
vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(),
  Errors: {
    securityViolation: (msg: string) => new Error(`SECURITY: ${msg}`),
    configMissing: (name: string) => new Error(`CONFIG_MISSING: ${name}`),
  }
}));

// Set mock root key
process.env.AXIOM_G_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Key Management Service (KMS)', () => {
  const mockRedis = {
    hget: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (getRedis as any).mockReturnValue(mockRedis);
  });

  describe('resolveKeysForChunks', () => {
    it('resolves multiple version keys in parallel with envelope decryption', async () => {
      const sessionId = 'test-session';
      const chunks = [
        { id: 'vec-1', metadata: { text: 't1', encryptionVersion: 'v1' }, score: 0.9 },
        { id: 'vec-2', metadata: { text: 't2', encryptionVersion: 'v2' }, score: 0.8 },
      ];

      // DEKs are stored ENCRYPTED in Redis (Envelope Encryption)
      const dek1 = '00'.repeat(32);
      const dek2 = '11'.repeat(32);
      
      const rootKey = process.env.AXIOM_G_ROOT_KEY!;
      const encDek1 = encrypt(dek1, rootKey);
      const encDek2 = encrypt(dek2, rootKey);

      mockRedis.hget.mockImplementation((_key, version) => {
        if (version === 'v1') return Promise.resolve(encDek1);
        if (version === 'v2') return Promise.resolve(encDek2);
        return Promise.resolve(null);
      });

      const keyMap = await resolveKeysForChunks(sessionId, chunks);

      expect(keyMap.size).toBe(2);
      expect(keyMap.get('v1')).toBe(dek1);
      expect(keyMap.get('v2')).toBe(dek2);
      expect(mockRedis.hget).toHaveBeenCalledTimes(2);
    });

    it('logs error and omits versions with missing keys', async () => {
      const sessionId = 'test-session';
      const chunks = [
        { id: 'vec-1', metadata: { text: 't1', encryptionVersion: 'v1' }, score: 0.9 },
        { id: 'vec-2', metadata: { text: 't2', encryptionVersion: 'v99' }, score: 0.8 },
      ];

      const rootKey = process.env.AXIOM_G_ROOT_KEY!;
      mockRedis.hget.mockImplementation((_key, version) => {
        if (version === 'v1') return Promise.resolve(encrypt('key-material-1', rootKey));
        return Promise.resolve(null); // v99 is missing
      });

      const keyMap = await resolveKeysForChunks(sessionId, chunks);

      expect(keyMap.size).toBe(1);
      expect(keyMap.has('v1')).toBe(true);
      expect(keyMap.has('v99')).toBe(false);
    });
  });

  describe('decryptChunks (Phase 4 AES-GCM)', () => {
    it('decrypts real AES-GCM chunks using multiple keys', async () => {
      const sessionId = 'test-session';
      const key1 = 'aa'.repeat(32);
      const key2 = 'bb'.repeat(32);
      
      const payload1 = encrypt('secret message 1', key1);
      const payload2 = encrypt('secret message 2', key2);

      const chunks = [
        { id: 'v1-chunk', metadata: { text: payload1, encryptionVersion: 'v1' }, score: 0.9 },
        { id: 'v2-chunk', metadata: { text: payload2, encryptionVersion: 'v2' }, score: 0.85 },
      ];

      // Mock envelope storage for resolveKeys
      const rootKey = process.env.AXIOM_G_ROOT_KEY!;
      mockRedis.hget.mockImplementation((_key, v) => {
        if (v === 'v1') return Promise.resolve(encrypt(key1, rootKey));
        if (v === 'v2') return Promise.resolve(encrypt(key2, rootKey));
        return null;
      });

      const decrypted = await decryptChunks(sessionId, chunks);

      expect(decrypted.length).toBe(2);
      expect(decrypted[0].text).toBe('secret message 1');
      expect(decrypted[1].text).toBe('secret message 2');
    });

    it('filters out those with missing keys', async () => {
      const sessionId = 'test-session';
      const rootKey = process.env.AXIOM_G_ROOT_KEY!;
      const key1 = '0'.repeat(64);
      
      const chunks = [
        { id: 'vec-valid', metadata: { text: encrypt('any', key1), encryptionVersion: 'v1' }, score: 0.9 },
        { id: 'vec-missing', metadata: { text: 'any', encryptionVersion: 'v-ghost' }, score: 0.8 },
      ];

      mockRedis.hget.mockImplementation((_key, version) => {
        if (version === 'v1') return Promise.resolve(encrypt(key1, rootKey));
        return Promise.resolve(null);
      });

      const decrypted = await decryptChunks(sessionId, chunks);
      expect(decrypted.length).toBe(1);
    });
  });

  describe('Key Rotation Pipeline', () => {
    it('stores new version key successfully', async () => {
      const sessionId = 'test-session';
      mockRedis.hget.mockResolvedValue(null); // New version doesn't exist

      await initiateKeyRotation(sessionId, 'v1', 'v2', 'secret-key-material');

      // Verify it was called with encrypted DEK
      expect(mockRedis.hset).toHaveBeenCalledWith(
        `kms:${sessionId}`, 
        expect.objectContaining({ v2: expect.stringContaining(':') })
      );
    });

    it('rejects rotation if version identifier already exists (Anti-Replay)', async () => {
      const sessionId = 'test-session';
      const rootKey = process.env.AXIOM_G_ROOT_KEY!;
      const encKey = encrypt('some-key', rootKey);
      mockRedis.hget.mockResolvedValue(encKey); // v2 already exists

      await expect(
        initiateKeyRotation(sessionId, 'v1', 'v2', 'stale-key')
      ).rejects.toThrow(/version v2 already exists/);
      
      expect(mockRedis.hset).not.toHaveBeenCalled();
    });
  });
});
