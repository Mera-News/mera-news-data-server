/**
 * Optional Mongo pool timeouts, shared by every connection this repo opens.
 *
 * NO CODE DEFAULT, deliberately. `MeraModelsModule` is the single Mongoose
 * connection factory for FOUR apps — news-async, news-graphql, mera-scripts and
 * the bull job board — and a timeout that is right for a request-serving pool
 * is wrong for a batch one. `data-retention-sweep` issues `deleteMany` over 10k
 * ids, which is one round trip with no intervening data, so a socket timeout
 * sized for a web request would kill a healthy sweep; the scripts' backfills
 * are worse. Infra therefore sets these on news-graphql and news-auth only, and
 * an unset variable means "the driver's own default", never a number we picked
 * on their behalf.
 *
 * Unset, empty, non-numeric, zero and negative all mean unset: the key is
 * OMITTED from the options object rather than passed as undefined, so nothing
 * downstream has to tell the two apart.
 */

/**
 * Coerce an env value to a positive finite number, or undefined.
 *
 * `ConfigService.get<number>(key)` returns a STRING when the value came from
 * the environment — the generic is a claim, not a coercion — and handing
 * `"45000"` to the driver is how a tuning knob becomes a runtime error. There
 * is no fallback number here on purpose; see the file header.
 */
export function optionalTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The subset of pool options that are env-gated. */
export interface OptionalPoolTimeouts {
  socketTimeoutMS?: number;
  waitQueueTimeoutMS?: number;
}

/**
 * Build the timeout options for a connection, given the raw env values.
 *
 * Returns an object carrying only the keys that were actually configured, so
 * spreading it into a connection's options is a no-op when nothing is set.
 */
export function buildPoolTimeouts(env: {
  socketTimeoutMS?: unknown;
  waitQueueTimeoutMS?: unknown;
}): OptionalPoolTimeouts {
  const socketTimeoutMS = optionalTimeoutMs(env.socketTimeoutMS);
  const waitQueueTimeoutMS = optionalTimeoutMs(env.waitQueueTimeoutMS);
  return {
    ...(socketTimeoutMS !== undefined ? { socketTimeoutMS } : {}),
    ...(waitQueueTimeoutMS !== undefined ? { waitQueueTimeoutMS } : {}),
  };
}
