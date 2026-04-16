/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/validation.ts
 *
 * Validates Zod schemas for all API endpoints.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
  ChatRequestSchema,
  StatusQuerySchema,
  VoiceHandshakeSchema,
  ProcessDocumentPayloadSchema,
  UploadQuerySchema,
} from '@/lib/validation';

describe('Zod Validation Schemas', () => {
  describe('ChatRequestSchema', () => {
    it('accepts valid input', () => {
      const result = ChatRequestSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is the pricing?' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing sessionId', () => {
      const result = ChatRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty messages array', () => {
      const result = ChatRequestSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid message role', () => {
      const result = ChatRequestSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'admin', content: 'hello' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('StatusQuerySchema', () => {
    it('accepts valid jobId', () => {
      const result = StatusQuerySchema.safeParse({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing jobId', () => {
      const result = StatusQuerySchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects non-UUID jobId', () => {
      const result = StatusQuerySchema.safeParse({ jobId: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });
  });

  describe('UploadQuerySchema', () => {
    it('accepts valid sessionId', () => {
      const result = UploadQuerySchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('parses reset=true correctly', () => {
      const result = UploadQuerySchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        reset: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reset).toBe(true);
      }
    });
  });

  describe('VoiceHandshakeSchema', () => {
    it('accepts valid handshake', () => {
      const result = VoiceHandshakeSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        lang: 'en',
      });
      expect(result.success).toBe(true);
    });

    it('defaults lang to en when omitted', () => {
      const result = VoiceHandshakeSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lang).toBe('en');
      }
    });

    it('rejects invalid lang', () => {
      const result = VoiceHandshakeSchema.safeParse({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        lang: 'fr',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProcessDocumentPayloadSchema', () => {
    it('accepts valid payload', () => {
      const result = ProcessDocumentPayloadSchema.safeParse({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        genAiFileName: 'files/abc123',
        fileName: 'catalog.pdf',
        mode: 'ephemeral',
      });
      expect(result.success).toBe(true);
    });

    it('accepts governed mode', () => {
      const result = ProcessDocumentPayloadSchema.safeParse({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        genAiFileName: 'files/abc123',
        fileName: 'catalog.pdf',
        mode: 'governed',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing mode', () => {
      const result = ProcessDocumentPayloadSchema.safeParse({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        genAiFileName: 'files/abc123',
        fileName: 'catalog.pdf',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty fileName', () => {
      const result = ProcessDocumentPayloadSchema.safeParse({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
        genAiFileName: 'files/abc123',
        fileName: '',
        mode: 'ephemeral',
      });
      expect(result.success).toBe(false);
    });
  });
});
