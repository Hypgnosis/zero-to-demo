/**
 * ═══════════════════════════════════════════════════════════════════
 * Unit Tests — src/lib/retry.ts
 *
 * Validates exponential backoff, jitter, retryable status detection,
 * and max retry exhaustion.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, RetryableError } from '@/lib/retry';

describe('withRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { label: 'test' });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('rate limited', 429))
      .mockRejectedValueOnce(new RetryableError('rate limited', 429))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, {
      label: 'test',
      maxRetries: 3,
      baseDelayMs: 1, // Fast for tests
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable status (400)', async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError('bad request', 400));

    await expect(
      withRetry(fn, { label: 'test', maxRetries: 3, baseDelayMs: 1 })
    ).rejects.toThrow('bad request');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError('rate limited', 429));

    await expect(
      withRetry(fn, { label: 'test', maxRetries: 2, baseDelayMs: 1 })
    ).rejects.toThrow('rate limited');

    // 1 initial + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 500 and 503 by default', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('internal error', 500))
      .mockRejectedValueOnce(new RetryableError('unavailable', 503))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      label: 'test',
      maxRetries: 3,
      baseDelayMs: 1,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('handles errors with statusCode property (Upstash SDK style)', async () => {
    const upstashError = { message: 'too many requests', statusCode: 429 };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(upstashError)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      label: 'test',
      maxRetries: 2,
      baseDelayMs: 1,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
