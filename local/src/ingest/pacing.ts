/**
 * At most `concurrency` feeds at once, one request at a time per host, and
 * `gapMs` between the end of one request to a host and the start of the next.
 */
export function createPacer(concurrency: number, gapMs: number) {
  const hostChains = new Map<string, Promise<unknown>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  return function run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = hostChains.get(host);
    const result = (async () => {
      if (previous) {
        await previous.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      await slot();
      try {
        return await task();
      } finally {
        release();
      }
    })();
    hostChains.set(host, result);
    return result;
  };
}
