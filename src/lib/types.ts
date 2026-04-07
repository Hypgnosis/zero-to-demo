/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Shared Type Definitions
 * Enterprise-grade type system. Zero `any` types permitted.
 * ═══════════════════════════════════════════════════════════════════
 */

/* ─── Session ─────────────────────────────────────────────────── */

export interface DemoSession {
  sessionId: string;
  createdAt: string;   // ISO 8601
  expiresAt: string;   // ISO 8601 — TTL: +4 hours
  status: SessionStatus;
}

export type SessionStatus = 'active' | 'expired' | 'purged';

/* ─── Ingestion Job ───────────────────────────────────────────── */

export interface IngestionJob {
  jobId: string;
  sessionId: string;
  blobUrl: string;
  fileName: string;
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
  status: 'accepted';
}

export interface StatusResponse {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  totalChunks?: number;
  error?: string;
}

/* ─── Vector ──────────────────────────────────────────────────── */

export interface VectorMetadata {
  source: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
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
