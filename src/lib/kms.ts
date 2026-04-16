/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-G — Key Management Service (KMS) Abstraction Layer
 *
 * Phase 5: Key Sovereignty — BYOK, Envelope Encryption, Lifecycle
 *
 * Purpose:
 * Industrial-grade key management for governed RAG sessions.
 * Implements AES-256-GCM encryption with envelope key protection
 * and BYOK (Bring Your Own Key) header-derived root key support.
 *
 * Architecture:
 * - Envelope Encryption: DEKs (Data Encryption Keys) are stored
 *   encrypted by a Root Key in Redis hashes.
 * - BYOK Priority Chain:
 *   1. X-Axiom-Root-Key header (per-request, never stored)
 *   2. AXIOM_G_ROOT_KEY env var (standard tenants)
 * - Multi-Version: Supports mixed encryption versions during rotation.
 * - Re-Encryption: Lifecycle managed by the reencryption.ts worker.
 *
 * Key Storage Schema (Redis):
 *   kms:{sessionId}  →  HSET { v1: <encrypted_DEK>, v2: <encrypted_DEK> }
 *
 * Security Contract:
 * - The chat route and process webhook are NEVER coupled to the
 *   key storage mechanism — they only call this module's public API.
 * - Failed decryption skips the chunk, never crashes the stream.
 * - Old version keys are NEVER deleted until the completion gate
 *   in reencryption.ts confirms zero remaining old-version chunks.
 * ═══════════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';
import { getRedis } from './redis';
import { Errors } from './errors';
import { auditKeyCreated } from './audit';

/* ─── Constants ───────────────────────────────────────────────── */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard for GCM
const KMS_PREFIX = 'kms:';

/**
 * BYOK (Bring Your Own Key) — Root Key Resolution
 *
 * Priority chain (highest to lowest):
 * 1. REQUEST-SCOPED OVERRIDE: Set by setRequestRootKey() from a
 *    header-derived secret (X-Axiom-Root-Key). This allows high-tier
 *    tenants (e.g., Fracttal) to pass their root key per-request,
 *    ensuring the master secret is NEVER stored in our infrastructure.
 *
 * 2. ENVIRONMENT VARIABLE: The AXIOM_G_ROOT_KEY env var serves as
 *    the default root key for standard tenants.
 *
 * 3. FATAL ERROR: If neither source is available, the system refuses
 *    to proceed — no fallback, no silent degradation.
 */

/** Thread-local (request-scoped) root key override for BYOK. */
let _requestScopedRootKey: string | null = null;

/**
 * Sets a request-scoped root key override.
 * Called by API middleware when X-Axiom-Root-Key header is present.
 * MUST call clearRequestRootKey() after the request completes.
 */
export function setRequestRootKey(hexKey: string): void {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== 32) {
    throw Errors.validation(
      'X-Axiom-Root-Key must be a 32-byte hex string (64 characters).'
    );
  }
  _requestScopedRootKey = hexKey;
}

/**
 * Clears the request-scoped root key.
 * MUST be called in a finally block after request processing.
 */
export function clearRequestRootKey(): void {
  _requestScopedRootKey = null;
}

const getRootKey = (): Buffer => {
  // Priority 1: Request-scoped BYOK header
  if (_requestScopedRootKey) {
    return Buffer.from(_requestScopedRootKey, 'hex');
  }

  // Priority 2: Environment variable
  const key = process.env.AXIOM_G_ROOT_KEY;
  if (!key) {
    throw Errors.configMissing('AXIOM_G_ROOT_KEY');
  }
  return Buffer.from(key, 'hex');
};

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * A resolved version key — the decryption key for a specific version.
 */
export interface VersionKey {
  version: string;
  /** The decryption key material for this version (AES-256-GCM in Phase 4). */
  key: string;
}

/**
 * Result of version-aware decryption on a single chunk.
 */
export interface DecryptedChunk {
  /** The decrypted plaintext content. */
  text: string;
  /** The encryption version used to decrypt. */
  version: string;
  /** The unique vector ID of the chunk. */
  vectorId: string;
}

/**
 * A raw chunk from the vector store with version metadata.
 */
export interface VersionedChunk {
  id: string;
  metadata: {
    text: string;
    encryptionVersion?: string;
    [key: string]: unknown;
  };
  score: number;
}

/* ─── Key Storage ─────────────────────────────────────────────── */

/* ─── Key Storage ─────────────────────────────────────────────── */

/**
 * Fetches the key material for a specific version from Redis.
 * Implements ENVELOPE DECRYPTION: The stored key is decrypted using the root key.
 */
async function fetchVersionKey(sessionId: string, version: string): Promise<string | null> {
  const redis = getRedis();
  const encryptedDEK = await redis.hget<string>(`${KMS_PREFIX}${sessionId}`, version);
  
  if (!encryptedDEK) return null;

  try {
    // Envelope Decryption: Root Key -> DEK
    return decrypt(encryptedDEK, getRootKey().toString('hex'));
  } catch (err) {
    console.error(`[KMS] 🚨 Failed to decrypt DEK for session=${sessionId} version=${version}:`, err);
    throw Errors.securityViolation('Failed to decrypt data-encryption key. Root key mismatch?');
  }
}

/**
 * Public wrapper for fetchVersionKey.
 * Used by the re-encryption worker which operates outside the KMS
 * internal scope but needs direct key resolution.
 */
export async function fetchVersionKeyPublic(sessionId: string, version: string): Promise<string | null> {
  return fetchVersionKey(sessionId, version);
}

/**
 * Stores a versioned key for a session.
 * Implements ENVELOPE ENCRYPTION: The DEK is encrypted with the root key before storage.
 */
export async function storeVersionKey(
  sessionId: string,
  version: string,
  keyMaterial: string
): Promise<void> {
  // Envelope Encryption: DEK -> Root Key
  const encryptedDEK = encrypt(keyMaterial, getRootKey().toString('hex'));
  
  const redis = getRedis();
  await redis.hset(`${KMS_PREFIX}${sessionId}`, { [version]: encryptedDEK });
  console.log(`[KMS] Stored encrypted DEK for session=${sessionId} version=${version}`);
}

/**
 * Gets all known encryption versions for a session.
 * Used by the key rotation pipeline to know what versions exist.
 */
export async function getSessionVersions(sessionId: string): Promise<string[]> {
  const redis = getRedis();
  const hash = await redis.hgetall<Record<string, string>>(`${KMS_PREFIX}${sessionId}`);
  return hash ? Object.keys(hash) : [];
}

/* ─── Key Generation ─────────────────────────────────────────── */

/**
 * Generates a new cryptographically secure 32-byte key (DEK)
 * and stores it for the session using envelope encryption.
 */
export async function createVersionKey(
  sessionId: string, 
  version: string,
  tenantId?: string,
  actorId: string = 'SYSTEM'
): Promise<string> {
  const keyMaterial = crypto.randomBytes(32).toString('hex');
  await storeVersionKey(sessionId, version, keyMaterial);
  
  // Log to immutable audit trail
  await auditKeyCreated(tenantId, actorId, sessionId, version);
  
  return keyMaterial;
}

/**
 * Ensures a session has a specific version key initialized.
 * If missing, generates and stores a new one.
 * Returns the plaintext key material.
 */
export async function ensureKeyInitialized(
  sessionId: string, 
  version: string = 'v1',
  tenantId?: string,
  actorId: string = 'SYSTEM'
): Promise<string> {
  const existing = await fetchVersionKey(sessionId, version);
  if (existing) return existing;
  
  console.log(`[KMS] Initializing ${version} key for session=${sessionId}`);
  return createVersionKey(sessionId, version, tenantId, actorId);
}

/* ─── Multi-Version Key Resolution ───────────────────────────── */

/**
 * Fetches the decryption keys for ALL versions present in a set of chunks.
 *
 * This is the core of the "2 AM Risk" remedy. Instead of assuming a single
 * current version, we inspect every retrieved chunk, collect the unique
 * set of versions, and fetch the corresponding key for each.
 *
 * If we're mid-rotation (v1 + v2 chunks mixed), we fetch BOTH keys
 * so each chunk can be decrypted with its correct key.
 *
 * @param sessionId      - The session owning the chunks.
 * @param chunks         - The raw vector results from queryVectors().
 * @returns              - A Map from version string to key material.
 *                         Versions with missing keys are logged and omitted.
 */
export async function resolveKeysForChunks(
  sessionId: string,
  chunks: VersionedChunk[]
): Promise<Map<string, string>> {
  // 1. Extract the unique set of versions present in this retrieval batch.
  //    Default to 'v1' if a chunk has no encryptionVersion tag.
  const presentVersions = new Set<string>(
    chunks.map((c) => c.metadata.encryptionVersion ?? 'v1')
  );

  console.log(
    `[KMS] Resolving keys for session=${sessionId}, versions=[${Array.from(presentVersions).join(', ')}]`
  );

  // 2. Parallel fetch of all required version keys.
  const keyResolutions = await Promise.allSettled(
    Array.from(presentVersions).map(async (version) => {
      const keyMaterial = await fetchVersionKey(sessionId, version);
      return { version, keyMaterial };
    })
  );

  // 3. Build the version → key map, logging any missing keys as security alerts.
  const keyMap = new Map<string, string>();

  for (const result of keyResolutions) {
    if (result.status === 'rejected') {
      console.error('[KMS] ❌ Key fetch failed:', result.reason);
      continue;
    }

    const { version, keyMaterial } = result.value;

    if (!keyMaterial) {
      // A missing key for a version that exists in the index is a
      // SECURITY ALERT — it may indicate tampering or a misconfigured rotation.
      console.error(
        `[KMS] 🚨 SECURITY: Missing key for session=${sessionId} version=${version}. ` +
        `Chunks encrypted with this version will be skipped.`
      );
      // Do NOT add to keyMap — callers must handle the missing key case gracefully.
      continue;
    }

    keyMap.set(version, keyMaterial);
  }

  return keyMap;
}

/**
 * Encrypts plaintext with the given key using AES-256-GCM.
 * Output Format: iv:ciphertext:tag (base64 encoded)
 */
export function encrypt(plaintext: string, keyMaterial: string): string {
  const key = Buffer.from(keyMaterial, 'hex');
  if (key.length !== 32) {
    throw new Error('KMS: Encryption key must be 32 bytes (64 hex chars).');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const tag = cipher.getAuthTag().toString('base64');
  
  return `${iv.toString('base64')}:${encrypted}:${tag}`;
}

/**
 * Decrypts ciphertext with the given key using AES-256-GCM.
 * Input Format: iv:ciphertext:tag (base64 encoded)
 */
export function decrypt(ciphertext: string, keyMaterial: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('KMS: Invalid ciphertext format. Expected iv:data:tag');
  }

  const [ivB64, dataB64, tagB64] = parts;
  const key = Buffer.from(keyMaterial, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(dataB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/* ─── Version-Aware Decryption (Core of the 2 AM Remedy) ──────── */

/**
 * Decrypts a batch of chunks using version-aware key lookup.
 *
 * Multi-Version Safety Contract:
 * - Each chunk is decrypted with its OWN version's key.
 * - Chunks whose key is missing are SKIPPED — they produce a
 *   server-side warning but do NOT crash the inference stream.
 * - The caller receives only successfully decrypted plaintext.
 *
 * This function is the definitive answer to the "2 AM Risk":
 * during a key rotation, v1 and v2 chunks coexist in the index.
 * This function handles the mixed state transparently, producing
 * clean plaintext for every version present without crashing.
 *
 * @param sessionId - The session owning the chunks.
 * @param chunks    - Raw vector query results with version metadata.
 * @returns         - Successfully decrypted chunks in score order.
 */
export async function decryptChunks(
  sessionId: string,
  chunks: VersionedChunk[]
): Promise<DecryptedChunk[]> {
  if (chunks.length === 0) return [];

  // 1. Resolve keys for all versions present in the batch.
  const keyMap = await resolveKeysForChunks(sessionId, chunks);

  // 2. Decrypt each chunk with its version's key.
  const decrypted: DecryptedChunk[] = [];

  for (const chunk of chunks) {
    const version = chunk.metadata.encryptionVersion ?? 'v1';
    const keyMaterial = keyMap.get(version);

    if (!keyMaterial) {
      // Missing key — skip this chunk and log.
      // The LLM receives fewer context chunks rather than garbage.
      console.warn(
        `[KMS] Skipping chunk id=${chunk.id} (missing key for version=${version}). ` +
        `This chunk will NOT appear in the LLM context.`
      );
      continue;
    }

    try {
      const decryptedText = decrypt(chunk.metadata.text, keyMaterial);
      decrypted.push({
        text: decryptedText,
        version,
        vectorId: chunk.id,
      });
    } catch (err: unknown) {
      // Decryption failure — safety skip, not a crash.
      console.error(
        `[KMS] Decryption failed for chunk id=${chunk.id} version=${version}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const skipped = chunks.length - decrypted.length;
  if (skipped > 0) {
    console.warn(`[KMS] Decryption summary: ${decrypted.length}/${chunks.length} chunks decrypted. ${skipped} skipped.`);
  }

  return decrypted;
}

/* ─── Key Rotation Pipeline ───────────────────────────────────── */

/**
 * Initiates a key rotation for a governed session.
 *
 * Phase 3 Contract:
 * - Stores the new key version in Redis.
 * - All NEW ingestions will use `newVersion`.
 * - Existing chunks remain at `currentVersion` until re-encrypted.
 * - The chat route handles mixed-version retrieval transparently.
 *
 * Phase 4 Full Implementation:
 * - Enqueue a QStash job to re-encrypt all existing chunks.
 * - The job reads all vectors, decrypts with `currentVersion`,
 *   re-encrypts with `newVersion`, and upserts back.
 * - Once complete, remove `currentVersion` from the key hash.
 * - Emit KEY_ROTATION_COMPLETED audit event.
 *
 * @param sessionId      - The governed session ID.
 * @param currentVersion - The version being rotated away from.
 * @param newVersion     - The new version identifier.
 * @param newKeyMaterial - The new key material to store.
 */
export async function initiateKeyRotation(
  sessionId: string,
  currentVersion: string,
  newVersion: string,
  newKeyMaterial: string
): Promise<void> {
  // Validate the new version doesn't already exist (anti-overwrite).
  const existing = await fetchVersionKey(sessionId, newVersion);
  if (existing) {
    throw Errors.securityViolation(
      `Key rotation rejected — version ${newVersion} already exists for session ${sessionId}. ` +
      `This may indicate a replay attack or double-rotation error.`
    );
  }

  // Store the new version key.
  await storeVersionKey(sessionId, newVersion, newKeyMaterial);

  console.log(
    `[KMS] Key rotation initiated: session=${sessionId} ` +
    `${currentVersion} → ${newVersion}. ` +
    `Mixed-version retrieval is now active. Enqueue re-encryption job to complete rotation.`
  );
}
