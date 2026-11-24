/** The one table of refusals: every code the commands print, its exit code and the command that fixes it. */
const CMD = 'mera-news-local';
const GBR = `${CMD} feeds load --only country:GBR`;

interface Entry {
  exit: 1 | 2 | 3 | 0;
  /** `{model}` and `{n}` are filled from the error's vars; null means there is no command to run. */
  fix: string | null;
}

export const ERRORS: Record<string, Entry> = {
  store_busy: { exit: 2, fix: `${CMD} status` },
  store_too_old: { exit: 2, fix: 'npm ci' },
  wrong_model: { exit: 2, fix: `${CMD} reembed --model {model}` },
  model_missing: { exit: 2, fix: `${CMD} model download --model {model}` },
  model_unknown: { exit: 1, fix: `${CMD} model download --model e5-small` },
  model_runtime_missing: { exit: 2, fix: 'npm ci' },
  download_interrupted: { exit: 2, fix: `${CMD} model download --model {model}` },
  model_load_failed: { exit: 1, fix: `${CMD} model download --model {model}` },
  embed_endpoint_unreachable: { exit: 2, fix: `${CMD} config show` },
  embed_endpoint_failed: { exit: 1, fix: `${CMD} config show` },
  embed_bad_response: { exit: 1, fix: `${CMD} config set embedder local` },
  embed_dims_mismatch: { exit: 2, fix: `${CMD} config set embedder.dims <n>` },
  no_articles_yet: { exit: 2, fix: `${CMD} ingest` },
  no_match: { exit: 0, fix: `${CMD} search "<other words>"` },
  feeds_none: { exit: 2, fix: GBR },
  feeds_choose: { exit: 2, fix: GBR },
  selector_invalid: { exit: 1, fix: GBR },
  feed_url_invalid: { exit: 1, fix: `${CMD} feeds add https://example.com/rss.xml` },
  feeds_failed: { exit: 3, fix: `${CMD} feeds list --failed` },
  no_ingest_yet: { exit: 2, fix: `${CMD} ingest` },
  // Added beside the design's table: refusals the commands themselves can make.
  usage: { exit: 1, fix: `${CMD} help` },
  config_invalid: { exit: 1, fix: `${CMD} config show` },
  embedder_incomplete: { exit: 2, fix: `${CMD} config set embedder.url <url>` },
  feed_unknown: { exit: 1, fix: `${CMD} feeds list` },
  test_embedder_refused: { exit: 1, fix: 'unset MERA_NEWS_LOCAL_TEST_EMBEDDER' },
  error: { exit: 1, fix: `${CMD} status` },
};

/** A refusal raised by a command. Errors from the store and the embedder are mapped by `refusalOf`. */
export class CliError extends Error {
  readonly code: string;
  readonly vars: Record<string, string>;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.vars = vars;
    this.extra = extra;
  }
}

export interface Refusal {
  ok: false;
  code: string;
  message: string;
  fix: string | null;
  exit: number;
  extra: Record<string, unknown>;
}

const fill = (fix: string, vars: Record<string, string>) => fix.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `<${k}>`);

export function refusalOf(error: unknown): Refusal {
  const e = error as { code?: unknown; message?: unknown; fix?: unknown; vars?: Record<string, string>; extra?: Record<string, unknown> };
  const code = typeof e?.code === 'string' && e.code in ERRORS ? e.code : 'error';
  const entry = ERRORS[code]!;
  const message = typeof e?.message === 'string' && e.message ? e.message : 'Something went wrong.';
  // The store and the embedder sometimes give advice as a sentence; only an exact command is a fix.
  const own = typeof e?.fix === 'string' && e.fix.startsWith(`${CMD} `) ? e.fix : null;
  const fix = own ?? (entry.fix === null ? null : fill(entry.fix, e?.vars ?? {}));
  return { ok: false, code, message, fix, exit: entry.exit, extra: e?.extra ?? {} };
}
