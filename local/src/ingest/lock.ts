import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { StoreError } from '../store/store.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The process id holding the write lock, or null when no live process holds it. */
export function writeLockHolder(dbPath: string): number | null {
  try {
    const pid = Number(readFileSync(`${dbPath}.lock`, 'utf8').trim());
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * One writer at a time: a lock file next to the news file, holding the writer's
 * process id. A lock left by a process that is gone is taken over.
 */
export function acquireWriteLock(dbPath: string): () => void {
  const path = `${dbPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid && alive(pid)) {
        throw new StoreError(
          'store_busy',
          `Another ingest (process ${pid}) is writing to this news file. Wait for it to finish.`,
          'mera-news-local status',
        );
      }
      rmSync(path, { force: true });
    }
  }
  throw new StoreError('store_busy', 'The news file stayed locked.', 'mera-news-local status');
}
