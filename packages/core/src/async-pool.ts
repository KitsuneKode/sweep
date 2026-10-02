/**
 * Run async work over items with a bounded concurrency pool.
 * When `isCancelled` returns true, unprocessed items are skipped - the pool
 * drains in-flight work and resolves (results array keeps empty slots).
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  isCancelled?: () => boolean,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function runWorker(): Promise<void> {
    while (true) {
      if (failed || isCancelled?.()) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  // Do not reject while sibling work still owns resources. Stop claiming
  // jobs on first failure, drain every admitted worker, then surface it.
  const settled = await Promise.allSettled(workers);
  const rejection = settled.find((result) => result.status === "rejected");
  if (rejection?.status === "rejected") throw rejection.reason;
  return results;
}
