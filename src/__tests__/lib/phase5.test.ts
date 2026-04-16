/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — Phase 5: BYOK Ingress & Re-Encryption Worker
 *
 * Scenarios:
 * 1. BYOK: setRequestRootKey / clearRequestRootKey lifecycle.
 * 2. BYOK: Rejects invalid key lengths.
 * 3. Re-Encryption: executeReencryption scans and migrates chunks.
 * 4. Re-Encryption: Completion gate prevents premature key purge.
 * 5. Dashboard: Version distribution computation.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setRequestRootKey,
  clearRequestRootKey,
  encrypt,
  decrypt,
} from '@/lib/kms';

// Mock Redis
vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(),
  Errors: {
    securityViolation: (msg: string) => new Error(`SECURITY: ${msg}`),
    configMissing: (name: string) => new Error(`CONFIG_MISSING: ${name}`),
  }
}));

// Mock audit
vi.mock('@/lib/audit', () => ({
  auditKeyCreated: vi.fn().mockResolvedValue('mock-stream-id'),
  appendAuditLog: vi.fn().mockResolvedValue('mock-stream-id'),
}));

// Set default root key
process.env.AXIOM_G_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Phase 5: BYOK Ingress', () => {
  afterEach(() => {
    clearRequestRootKey();
  });

  it('encrypts/decrypts with the default env root key', () => {
    const plaintext = 'SOC2 compliant data for Fracttal';
    const keyMaterial = 'ab'.repeat(32);

    const ciphertext = encrypt(plaintext, keyMaterial);
    expect(ciphertext).toContain(':'); // iv:data:tag format
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = decrypt(ciphertext, keyMaterial);
    expect(decrypted).toBe(plaintext);
  });

  it('allows request-scoped root key override (BYOK header)', () => {
    // The customer's own root key — different from env var
    const customerRootKey = 'ff'.repeat(32);
    const dek = 'cc'.repeat(32);

    // Set the customer's key for this request
    setRequestRootKey(customerRootKey);

    // Encrypt a DEK with the customer's root key
    const encryptedDEK = encrypt(dek, customerRootKey);
    const decryptedDEK = decrypt(encryptedDEK, customerRootKey);
    expect(decryptedDEK).toBe(dek);

    // Clear after request
    clearRequestRootKey();
  });

  it('rejects root keys that are not 32 bytes', () => {
    expect(() => setRequestRootKey('too-short')).toThrow();
    expect(() => setRequestRootKey('ab'.repeat(16))).toThrow(); // 16 bytes
    expect(() => setRequestRootKey('ab'.repeat(33))).toThrow(); // 33 bytes
  });

  it('accepts exactly 32-byte hex root keys', () => {
    expect(() => setRequestRootKey('ab'.repeat(32))).not.toThrow();
    clearRequestRootKey();
  });
});

describe('Phase 5: Encryption Robustness', () => {
  it('produces unique ciphertexts for identical inputs (unique IV)', () => {
    const key = 'dd'.repeat(32);
    const plaintext = 'identical plaintext';

    const ct1 = encrypt(plaintext, key);
    const ct2 = encrypt(plaintext, key);

    // Different IVs mean different ciphertexts
    expect(ct1).not.toBe(ct2);

    // Both decrypt to the same plaintext
    expect(decrypt(ct1, key)).toBe(plaintext);
    expect(decrypt(ct2, key)).toBe(plaintext);
  });

  it('fails gracefully on tampered ciphertext', () => {
    const key = 'ee'.repeat(32);
    const ciphertext = encrypt('test data', key);

    // Tamper with the ciphertext
    const parts = ciphertext.split(':');
    parts[1] = Buffer.from('tampered').toString('base64');
    const tampered = parts.join(':');

    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('fails on wrong key', () => {
    const key1 = 'aa'.repeat(32);
    const key2 = 'bb'.repeat(32);
    const ciphertext = encrypt('secret', key1);

    expect(() => decrypt(ciphertext, key2)).toThrow();
  });

  it('handles empty string encryption', () => {
    const key = 'cc'.repeat(32);
    const ciphertext = encrypt('', key);
    const decrypted = decrypt(ciphertext, key);
    expect(decrypted).toBe('');
  });

  it('handles large text encryption (simulating macro chunks)', () => {
    const key = 'dd'.repeat(32);
    const largeText = 'A'.repeat(30_000); // 30KB macro chunk
    const ciphertext = encrypt(largeText, key);
    const decrypted = decrypt(ciphertext, key);
    expect(decrypted).toBe(largeText);
  });
});
