// One feed request, with the full server's guard: public addresses only
// (checked on the address, at connection and on every redirect hop), a cap on
// redirects, on bytes and on time, and conditional requests.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { allowlistedAgents, assertPublicUrl, strictAgents, type AllowList } from './shared.ts';

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;

export interface FetchOptions {
  userAgent: string;
  etag?: string | null;
  lastModified?: string | null;
  /** Hosts on the person's own network that may be fetched anyway. */
  allowHosts?: AllowList;
  timeoutMs?: number;
  maxBytes?: number;
}

export type FetchResult =
  | { status: 'ok'; body: Uint8Array; contentType: string | null; etag: string | null; lastModified: string | null; finalUrl: string }
  | { status: 'not_modified' };

export type FetchErrorCode = 'refused' | 'timeout' | 'too_large' | 'too_many_redirects' | 'http_status' | 'network';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status?: number;
  constructor(code: FetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

function once(url: URL, options: FetchOptions, signal: AbortSignal, agents: typeof strictAgents): Promise<Answer> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent,
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  };
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const agent = url.protocol === 'https:' ? agents.https : agents.http;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'GET', headers, agent, signal }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (declared > maxBytes) {
        res.destroy();
        reject(new FetchError('too_large', `The feed is larger than ${maxBytes} bytes.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new FetchError('too_large', `The feed is larger than ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const header = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] : value) ?? null;

/** Fetches one feed, following at most MAX_REDIRECTS redirects, each hop checked. */
export async function fetchFeed(address: string, options: FetchOptions): Promise<FetchResult> {
  const allow = options.allowHosts ?? [];
  const agents = allow.length > 0 ? allowlistedAgents(allow) : strictAgents;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  let url = new URL(address);
  for (let hop = 0; ; hop++) {
    try {
      assertPublicUrl(url, allow);
    } catch (error) {
      throw new FetchError('refused', (error as Error).message);
    }
    let answer: Answer;
    try {
      answer = await once(url, options, signal, agents);
    } catch (error) {
      if (error instanceof FetchError) throw error;
      if (signal.aborted) throw new FetchError('timeout', `The feed did not answer within ${(options.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} seconds.`);
      const refusal = (error as { code?: string }).code === 'EGRESS_REFUSED' || (error as { cause?: { code?: string } }).cause?.code === 'EGRESS_REFUSED';
      if (refusal) throw new FetchError('refused', (error as Error).message);
      throw new FetchError('network', (error as Error).message);
    }
    if (answer.status >= 300 && answer.status < 400 && answer.status !== 304) {
      const location = header(answer.headers.location);
      if (!location) throw new FetchError('http_status', `HTTP ${answer.status} without a location.`, answer.status);
      if (hop >= MAX_REDIRECTS) throw new FetchError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects.`);
      url = new URL(location, url);
      continue;
    }
    if (answer.status === 304) return { status: 'not_modified' };
    if (answer.status < 200 || answer.status >= 300) throw new FetchError('http_status', `HTTP ${answer.status}.`, answer.status);
    return {
      status: 'ok',
      body: answer.body,
      contentType: header(answer.headers['content-type']),
      etag: header(answer.headers.etag),
      lastModified: header(answer.headers['last-modified']),
      finalUrl: url.href,
    };
  }
}
