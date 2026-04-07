/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Zod Validation Schemas
 * Every API route validates through these schemas. No raw req.json().
 * ═══════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';

/* ─── Upload ──────────────────────────────────────────────────── */

export const UploadQuerySchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  reset: z
    .string()
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
  blobUrl: z.string().url(),
  fileName: z.string().min(1),
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
