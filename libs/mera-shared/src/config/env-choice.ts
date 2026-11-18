/** The one method these readers need, so a plain object can stand in. */
export interface ConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

/** A key's value as trimmed text; unset, empty or a non-scalar reads as ''. */
export function readText(config: ConfigReader, key: string): string {
  const value = config.get<unknown>(key);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * One value from a closed list. Unset or empty returns `fallback`, so a
 * deployment that never set the key keeps today's behaviour. Any other value
 * outside `allowed` throws at boot, naming the allowed values, instead of
 * silently binding a default.
 */
export function readChoice<T extends string>(
  config: ConfigReader,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readText(config, key).toLowerCase();
  if (value === '') return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key}="${value}" is not one of: ${allowed.join(', ')}`);
}

/** `true` or `false` only. Unset or empty returns `fallback`. */
export function readBool(
  config: ConfigReader,
  key: string,
  fallback: boolean,
): boolean {
  const value = readText(config, key).toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key}="${value}" must be true or false`);
}

/**
 * Test-only fake providers are refused under `NODE_ENV=production` unless
 * `ALLOW_FAKE_PROVIDERS=true`, so a deployment cannot run on fake vectors or
 * untranslated text by accident.
 */
export function assertFakeAllowed(config: ConfigReader, key: string): void {
  if (readText(config, 'NODE_ENV') !== 'production') return;
  if (readBool(config, 'ALLOW_FAKE_PROVIDERS', false)) return;
  throw new Error(
    `${key}=fake is for tests only. Set ALLOW_FAKE_PROVIDERS=true to use it with NODE_ENV=production.`,
  );
}
