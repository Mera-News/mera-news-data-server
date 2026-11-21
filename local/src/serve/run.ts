import type { Embedder } from '../embed/embedder.ts';
import type { Store } from '../store/store.ts';
import { DEFAULT_PORT, startServer, type RunningServer } from './http.ts';

export interface ServeOptions {
  store: Store;
  embedder: Embedder;
  port?: number;
  /** Minutes between ingests; this process is then the only writer. */
  every?: number;
  /** Runs one ingest; required with `every`. */
  ingest?: () => Promise<unknown>;
  onEvent: (event: Record<string, unknown>) => void;
  /** Resolves when the server should stop; default a stop signal. */
  until?: Promise<void>;
}

const stopSignal = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

/** Serves the store on 127.0.0.1 until stopped, ingesting every `every` minutes when asked. */
export async function runServe(options: ServeOptions): Promise<void> {
  const { store, embedder, onEvent } = options;
  store.assertEmbeddingModel({ id: embedder.model, dims: embedder.dims });
  const running: RunningServer = await startServer({ store, embedder }, options.port ?? DEFAULT_PORT);
  onEvent({ event: 'serve_start', url: `http://127.0.0.1:${running.port}/graphql`, port: running.port, every: options.every ?? null });

  let timer: NodeJS.Timeout | undefined;
  let busy: Promise<unknown> = Promise.resolve();
  if (options.every) {
    if (!options.ingest) throw new Error('serve --every needs an ingest to run');
    const ingest = options.ingest;
    const tick = () => {
      busy = ingest().catch((error: unknown) => onEvent({ event: 'ingest_error', message: (error as Error).message }));
    };
    tick();
    timer = setInterval(() => {
      busy.then(tick, tick);
    }, options.every * 60_000);
  }

  await (options.until ?? stopSignal());
  if (timer) clearInterval(timer);
  await busy.catch(() => undefined);
  await running.close();
  onEvent({ event: 'serve_stop' });
}
