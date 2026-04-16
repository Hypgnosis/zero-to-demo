/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 / AXIOM-G — Shared Type Definitions
 *
 * Phase 5: Dual-Mode Architecture (Zero-Trust Architect V2)
 *
 * Enterprise-grade type system. Zero `any` types permitted.
 * AxiomMode is the single source of truth for data lifecycle.
 * ═══════════════════════════════════════════════════════════════════
 */

/* ─── Dual-Mode Engine ────────────────────────────────────────── */

/**
 * The operational mode discriminant.
 * - 'ephemeral': Axiom-0 Ghost Pipeline. 4h TTL, auto-purged, demo data.
 * - 'governed':  Axiom-G Digital Employee. No TTL, persistent, enterprise data.
 *
 * FAIL-TO-EPHEMERAL: If mode is missing, undefined, or unrecognized,
 * the system MUST treat it as 'ephemeral'. This is a security invariant.
 */
export type AxiomMode = 'ephemeral' | 'governed';

/**
 * Readonly namespace prefix constants.
 * Used by EVERY function that touches vector namespaces.
 * The `as const` assertion makes these string literals at the type level —
 * TypeScript will catch any code that tries to assign a dynamic prefix.
 */
export const NAMESPACE_PREFIX = {
  EPHEMERAL: 'eph_',
  GOVERNED: 'gov_',
} as const;

/* ─── Session ─────────────────────────────────────────────────── */

/**
 * AxiomSession replaces DemoSession.
 * The `mode` field is immutable for the session's entire lifecycle.
 * Once created, a session's mode CANNOT change (enforced by NX in Redis).
 */
export interface AxiomSession {
  sessionId: string;
  userId: string;       // Verified owner (from JWT `sub` claim). Phase 1: Zero-Trust Identity.
  createdAt: string;    // ISO 8601
  /** ISO 8601. Present ONLY for ephemeral sessions. Governed sessions have no expiry. */
  expiresAt?: string;
  /** The operational mode. Determines namespace prefix, TTL, and cleanup eligibility. IMMUTABLE. */
  mode: AxiomMode;
  status: SessionStatus;
}

/**
 * @deprecated Use AxiomSession instead. Kept as alias during migration window.
 */
export type DemoSession = AxiomSession;

export type SessionStatus = 'active' | 'expired' | 'purged';

/* ─── Ingestion Job ───────────────────────────────────────────── */

export interface IngestionJob {
  jobId: string;
  sessionId: string;
  /** Google GenAI File API reference. Phase 2: Ghost Pipeline. */
  genAiFileName: string;
  /** Original file name for display/logging purposes only. */
  fileName: string;
  /** The mode under which this job was created. Determines which vector index receives data. */
  mode: AxiomMode;
  status: JobStatus;
  totalChunks?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type JobStatus = 'pending' | 'processing' | 'complete' | 'failed';

/* ─── Chat ─────────────────────────────────────────────────────── */

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  citations?: Citation[];
}

export interface Citation {
  source: string;
  section?: string;
  page?: number;
}

export interface ChatRequest {
  sessionId: string;
  messages: ChatMessage[];
}

export interface ChatStreamChunk {
  type: 'text' | 'citation' | 'done' | 'error';
  content?: string;
  citation?: Citation;
  error?: string;
}

/* ─── Upload ──────────────────────────────────────────────────── */

export interface UploadResponse {
  jobId: string;
  sessionId: string;
  fileName: string;
  mode: AxiomMode;
  status: 'accepted';
}

export interface StatusResponse {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  totalChunks?: number;
  error?: string;
}

/* ─── Vector (Phase 4: Hierarchical RAG + Phase 5: BYOK Surface) ── */

export interface VectorMetadata {
  source: string;
  chunkIndex: number;
  totalChunks: number;
  /** The micro-chunk text used for search matching. */
  text: string;
  /** Phase 4: Parent macro chunk ID for deduplication during retrieval. */
  parentMacroId: string;
  /** Phase 4: Full structural context from the parent macro chunk.
   *  Injected into Gemini's system prompt to preserve table/section integrity. */
  macroText: string;
  /**
   * Phase 5: Encryption key version for BYOK (Bring Your Own Key) support.
   * - Ephemeral: always undefined (no key management for demo data).
   * - Governed: REQUIRED. Tracks which tenant key encrypted this chunk.
   * - Format: "v1", "v2", etc. Key rotation creates new versions.
   *
   * RUNTIME INVARIANT: upsertVectors() MUST reject governed metadata
   * where this field is undefined. Compile-time optional, runtime mandatory.
   */
  encryptionVersion?: string;
  /** Index signature required for VersionedChunk compatibility in kms.ts */
  [key: string]: unknown;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: VectorMetadata;
}

/* ─── API Error Response ──────────────────────────────────────── */

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

/* ─── Voice Proxy ──────────────────────────────────────────────── */

export interface VoiceHandshake {
  sessionId: string;
  lang: 'en' | 'es';
}
