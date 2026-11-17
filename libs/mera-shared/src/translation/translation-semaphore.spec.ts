import { TranslationSemaphore } from './translation-semaphore';

describe('TranslationSemaphore', () => {
  it('grants up to the limit, then hands a released permit to the next waiter', async () => {
    const sem = new TranslationSemaphore(1);
    const r1 = await sem.acquire(0);
    expect(r1).not.toBeNull();
    expect(sem.inUse).toBe(1);
    const pending = sem.acquire(Infinity);
    expect(sem.waiting).toBe(1);
    r1!();
    const r2 = await pending;
    expect(r2).not.toBeNull();
    expect(sem.inUse).toBe(1);
    r2!();
    expect(sem.inUse).toBe(0);
  });

  it('returns null immediately with a zero wait when full', async () => {
    const sem = new TranslationSemaphore(1);
    await sem.acquire(0);
    expect(await sem.acquire(0)).toBeNull();
  });

  it('returns null when the wait times out, and drops the waiter', async () => {
    const sem = new TranslationSemaphore(1);
    await sem.acquire(0);
    expect(await sem.acquire(10)).toBeNull();
    expect(sem.waiting).toBe(0);
  });

  it('returns null when the signal aborts while waiting', async () => {
    const sem = new TranslationSemaphore(1);
    await sem.acquire(0);
    const ctl = new AbortController();
    const pending = sem.acquire(Infinity, ctl.signal);
    ctl.abort();
    expect(await pending).toBeNull();
    expect(sem.waiting).toBe(0);
  });

  it('ignores a double release', async () => {
    const sem = new TranslationSemaphore(2);
    const r = await sem.acquire(0);
    r!();
    r!();
    expect(sem.inUse).toBe(0);
  });
});
