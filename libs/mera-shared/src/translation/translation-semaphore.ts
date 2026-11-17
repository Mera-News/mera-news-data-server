/** Returned by {@link TranslationSemaphore.acquire}; idempotent. */
export type Release = () => void;

/**
 * A counting semaphore with a TIMED, abortable acquire that hands back an
 * explicit release. The routed provider needs both: a permit wait capped so a
 * saturated OpenRouter spills to Gemini instead of holding a worker slot, and
 * a release it can call before starting the next leg, so no call ever holds
 * one permit while waiting for another. cockatiel's bulkhead only wraps a
 * function, so it can express neither.
 */
export class TranslationSemaphore {
  private active = 0;
  private readonly waiters: Array<(release: Release | null) => void> = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a release once a permit is free, or `null` when `timeoutMs`
   * passes first or `signal` aborts. `timeoutMs` of Infinity waits forever;
   * 0 or less takes a permit only if one is free right now.
   */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<Release | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(null);
      const waiter = (release: Release | null) => settle(release);
      const settle = (release: Release | null) => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      };
      this.waiters.push(waiter);
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => settle(null), timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit straight to the next waiter: `active` is unchanged.
        next(this.releaser());
      } else {
        this.active--;
      }
    };
  }
}
