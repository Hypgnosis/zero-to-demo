/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Centralized Error Handling
 * ApiError class prevents stack trace leaks to the client.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import type { ApiErrorResponse } from './types';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  /**
   * Produces a sanitized JSON response — no stack traces, no internals.
   */
  toResponse(): NextResponse<ApiErrorResponse> {
    return NextResponse.json(
      { error: { code: this.code, message: this.message } },
      { status: this.statusCode }
    );
  }
}

/* ─── Factory Helpers ─────────────────────────────────────────── */

export const Errors = {
  validation: (message: string) =>
    new ApiError(400, 'VALIDATION_ERROR', message),

  unauthorized: (message = 'Authentication required.') =>
    new ApiError(401, 'UNAUTHORIZED', message),

  forbidden: (message = 'Access denied.') =>
    new ApiError(403, 'FORBIDDEN', message),

  notFound: (resource: string) =>
    new ApiError(404, 'NOT_FOUND', `${resource} not found.`),

  /** Phase 5: Session already exists with a different mode. Mode is immutable. */
  sessionConflict: (sessionId: string) =>
    new ApiError(409, 'SESSION_CONFLICT', `Session ${sessionId} already exists. Mode is immutable.`),

  rateLimited: () =>
    new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'),

  serverError: (message = 'An internal error occurred.') =>
    new ApiError(500, 'INTERNAL_ERROR', message),

  configMissing: (key: string) =>
    new ApiError(500, 'CONFIG_MISSING', `Server configuration error: ${key} is not set.`),

  /**
   * Phase 5: Hard security error. Indicates corrupted system state.
   * This should NEVER be caught and retried — it demands manual investigation.
   */
  securityViolation: (message: string) =>
    new ApiError(500, 'SECURITY_VIOLATION', `[SECURITY] ${message}`),

  noVectorData: () =>
    new ApiError(400, 'NO_VECTOR_DATA', 'No catalog data found for this session. Upload a PDF first.'),

  jobNotFound: (jobId: string) =>
    new ApiError(404, 'JOB_NOT_FOUND', `Ingestion job ${jobId} not found.`),
} as const;

/**
 * Wraps an API route handler with centralized error handling.
 * Catches ApiError instances and returns clean JSON responses.
 * Catches unknown errors and returns a sanitized 500 response.
 */
export function withErrorHandler(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        console.error(`[ApiError] ${error.code}: ${error.message}`);
        return error.toResponse();
      }

      // Unknown errors — log full stack server-side, sanitize for client
      console.error('[UnhandledError]', error);
      return Errors.serverError().toResponse();
    }
  };
}
