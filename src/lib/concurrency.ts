/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Bounded Concurrency Limiter
 *
 * Zero-dependency replacement for p-limit. Caps the number of
 * concurrent async operations to prevent socket pool exhaustion
 * and 429 rate-limit storms in serverless environments.
 *
 * Used by: vectorClient.ts, embeddings.ts
 *
 * Why not p-limit? It's ESM-only in v4+ and a transitive dep in v3.
 * Importing a transitive dependency is fragile. 40 lines of code
 * eliminate that risk permanently.
 * ═══════════════════════════════════════════════════════════════════
 */

export interface ConcurrencyLimiter {
  <T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Creates a concurrency limiter that allows at most `concurrency`
 * async tasks to run simultaneously. Additional tasks are queued
 * and executed in FIFO order as slots free up.
 *
 * @param concurrency - Max number of concurrent tasks (must be >= 1).
 * @returns A wrapper function that schedules tasks through the limiter.
 *
 * @example
 * ```ts
 * const limit = createLimiter(5);
 * const results = await Promise.all(
 *   items.map(item => limit(() => processItem(item)))
 * );
 * ```
 */
export function createLimiter(concurrency: number): ConcurrencyLimiter {
  if (concurrency < 1) throw new Error('Concurrency must be >= 1');

  let activeCount = 0;
  const queue: Array<() => void> = [];

  function dequeue(): void {
    if (queue.length > 0 && activeCount < concurrency) {
      activeCount++;
      const next = queue.shift()!;
      next();
    }
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          activeCount--;
          dequeue();
        });
      };

      if (activeCount < concurrency) {
        activeCount++;
        run();
      } else {
        queue.push(run);
      }
    });
  };
}
