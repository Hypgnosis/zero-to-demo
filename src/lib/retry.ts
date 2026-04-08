/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Retry with Exponential Backoff
 *
 * Zero-dependency utility for resilient network calls.
 * Specifically designed to handle 429 (Rate Limited) responses from
 * Upstash Vector and Google GenAI APIs.
 *
 * Strategy: exponential backoff + full jitter to decorrelate burst retries.
 * ═══════════════════════════════════════════════════════════════════
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5). */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 500). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000). */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry (default: [429, 500, 502, 503]). */
  retryableStatuses?: number[];
  /** Optional label for structured logging. */
  label?: string;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  retryableStatuses: [429, 500, 502, 503],
  label: 'retry',
};

/**
 * Custom error that carries the HTTP status from a failed network call.
 * Upstash SDK and fetch() errors may or may not expose a `status` field,
 * so we normalize it here.
 */
export class RetryableError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

/**
 * Extracts an HTTP-like status code from an unknown error.
 * Handles: fetch Response errors, Upstash SDK errors, generic objects.
 */
function extractStatus(error: unknown): number | null {
  if (error instanceof RetryableError) return error.status;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  return null;
}

/**
 * Sleep with full jitter: random(0, min(cap, base * 2^attempt))
 * This decorrelates retries from multiple concurrent workers.
 */
function jitteredDelay(attempt: number, baseMs: number, capMs: number): number {
  const exponential = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.random() * exponential;
}

/**
 * Retries an async function with exponential backoff + jitter.
 *
 * @param fn - The async function to retry.
 * @param opts - Retry configuration.
 * @returns The result of the first successful call.
 * @throws The last error if all retries are exhausted.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => ns.upsert(batch),
 *   { label: 'vector-upsert', maxRetries: 5 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const status = extractStatus(error);
      const isRetryable =
        status !== null && options.retryableStatuses.includes(status);

      // If it's the last attempt or non-retryable, throw immediately
      if (attempt === options.maxRetries || !isRetryable) {
        throw error;
      }

      const delay = jitteredDelay(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs
      );

      console.warn(
        `[${options.label}] Attempt ${attempt + 1}/${options.maxRetries} failed (status=${status}). ` +
          `Retrying in ${Math.round(delay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // TypeScript: unreachable, but satisfies the compiler
  throw lastError;
}
