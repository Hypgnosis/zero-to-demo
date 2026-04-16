/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 / AXIOM-G — Zod Validation Schemas
 *
 * Phase 5: Dual-Mode Architecture
 *
 * Every API route validates through these schemas. No raw req.json().
 * Mode parsing uses FAIL-TO-EPHEMERAL: any unrecognized or missing
 * mode value defaults to 'ephemeral'.
 * ═══════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { AxiomMode } from './types';

/* ─── Mode Resolution ─────────────────────────────────────────── */

/**
 * Resolves the AxiomMode from a raw header/param value.
 * FAIL-TO-EPHEMERAL: anything that isn't exactly 'governed' → 'ephemeral'.
 * This is a security invariant — ambiguity defaults to the safe path.
 */
export function resolveMode(raw: string | null | undefined): AxiomMode {
  return raw === 'governed' ? 'governed' : 'ephemeral';
}

/* ─── Upload ──────────────────────────────────────────────────── */

export const UploadQuerySchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  reset: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v === 'true'),
});

/* ─── Chat ────────────────────────────────────────────────────── */

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'model']),
  content: z
    .string()
    .min(1, 'Message content cannot be empty')
    .max(10000, 'Message content exceeds maximum length'),
});

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  messages: z
    .array(ChatMessageSchema)
    .min(1, 'At least one message is required')
    .max(100, 'Message history exceeds maximum length'),
});

/* ─── Status Polling ──────────────────────────────────────────── */

export const StatusQuerySchema = z.object({
  jobId: z.string().uuid('jobId must be a valid UUID'),
});

/* ─── QStash Webhook Payload ──────────────────────────────────── */

export const ProcessDocumentPayloadSchema = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
  /** Google GenAI File API reference (e.g., "files/abc123"). Phase 2: Ghost Pipeline. */
  genAiFileName: z.string().min(1),
  fileName: z.string().min(1),
  /** Phase 5: The mode that was active when the upload was accepted. */
  mode: z.enum(['ephemeral', 'governed']),
});

/* ─── Voice Handshake ─────────────────────────────────────────── */

export const VoiceHandshakeSchema = z.object({
  sessionId: z.string().uuid(),
  lang: z.enum(['en', 'es']).default('en'),
});

/* ─── Type Exports (inferred from schemas) ────────────────────── */

export type UploadQuery = z.infer<typeof UploadQuerySchema>;
export type ChatRequestPayload = z.infer<typeof ChatRequestSchema>;
export type StatusQuery = z.infer<typeof StatusQuerySchema>;
export type ProcessDocumentPayload = z.infer<typeof ProcessDocumentPayloadSchema>;
export type VoiceHandshakePayload = z.infer<typeof VoiceHandshakeSchema>;
