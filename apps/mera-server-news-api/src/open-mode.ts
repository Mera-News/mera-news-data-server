import type { ConfigService } from '@nestjs/config';
import { readBool, readText } from '@mera/shared/config/env-choice';

const DEFAULT_OPEN_RATE_LIMIT = 60;

/** `NEWS_API_OPEN`: serve without a key. `true` or `false` only. */
export function newsApiOpen(config: Pick<ConfigService, 'get'>): boolean {
  return readBool(config, 'NEWS_API_OPEN', false);
}

/** `NEWS_API_OPEN_RATE_LIMIT`: requests a minute per address in open mode. */
export function openRateLimit(config: Pick<ConfigService, 'get'>): number {
  const text = readText(config, 'NEWS_API_OPEN_RATE_LIMIT');
  if (text === '') return DEFAULT_OPEN_RATE_LIMIT;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('NEWS_API_OPEN_RATE_LIMIT must be a positive whole number');
  }
  return n;
}
