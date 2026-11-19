import { lookup as dnsLookup } from 'dns';
import type { LookupAddress, LookupOptions } from 'dns';
import { Agent as HttpAgent } from 'http';
import { validateHeaderValue } from 'http';
import { Agent as HttpsAgent } from 'https';
import { BlockList, Socket, isIP } from 'net';
import type { ConfigReader } from '../config/env-choice';
import { readText } from '../config/env-choice';
import { DEFAULT_FEED_USER_AGENT } from './crawler-identity';

/**
 * Decides whether an outbound web address is safe for the feed fetcher to
 * connect to, so a mistaken or hostile feed address cannot reach the
 * operator's private network or a cloud metadata service. Anything that cannot
 * be classified is treated as not public.
 */

type Reason =
  | 'is not a public address'
  | 'resolves to a private address'
  | 'is a local name'
  | 'uses a scheme other than http or https'
  | 'is not a valid web address';

// The allowlist can lift an address refusal. It can never lift a scheme or a
// malformed address.
const LIFTABLE: readonly Reason[] = [
  'is not a public address',
  'resolves to a private address',
  'is a local name',
];

/**
 * A refused connection. The message is built from the host and the reason
 * only, never from the URL, so no path, query or userinfo can reach a message.
 */
export class EgressRefusedError extends Error {
  readonly code = 'EGRESS_REFUSED' as const;

  constructor(
    readonly host: string,
    readonly reason: Reason,
  ) {
    super(
      LIFTABLE.includes(reason)
        ? `refused: ${host} ${reason}; add it to FEED_FETCH_ALLOW_HOSTS`
        : `refused: ${host} ${reason}`,
    );
    this.name = 'EgressRefusedError';
  }
}

/**
 * The refusal behind an error, if there is one. An HTTP client wraps the
 * errors its sockets and redirect hooks raise, so the refusal can sit several
 * causes down.
 */
export function findEgressRefusal(error: unknown): Error | undefined {
  let current: unknown = error;
  // Bounded so a cyclic cause chain cannot loop forever.
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if ((current as Error & { code?: string }).code === 'EGRESS_REFUSED') {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  // Azure's host endpoint, which sits in public space.
  ['168.63.129.16', 32],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
// IPv4-mapped addresses (::ffff:a.b.c.d and ::ffff:7f00:1) match the IPv4
// rules above without any unwrapping.

const nat64 = new BlockList();
nat64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The last 32 bits of an IPv6 address, as dotted IPv4. */
function lastFourBytes(address: string): string {
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? front
      : [
          ...front,
          ...Array<string>(8 - front.length - back.length).fill('0'),
          ...back,
        ];
  const high = parseInt(groups[6], 16);
  const low = parseInt(groups[7], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True only for an address that parses and is outside every blocked range. */
export function isPublicAddress(ip: string): boolean {
  // Node versions differ on whether BlockList accepts a zone id, so drop it first.
  const address = ip.includes(':') ? ip.replace(/%[^%]+$/, '') : ip;
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (blocked.check(address, type)) return false;
  if (family === 6 && nat64.check(address, 'ipv6')) {
    // The well-known NAT64 prefix is only as public as the address it carries.
    try {
      return isPublicAddress(lastFourBytes(address));
    } catch {
      return false;
    }
  }
  return true;
}

/** A host as URLs spell it: lowercase, no IPv6 brackets, no trailing dot. */
function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

const isLocalName = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost');

export interface AllowEntry {
  readonly host: string;
  /** The ports this entry opens: its own, or both scheme defaults. */
  readonly ports: readonly number[];
}
export type AllowList = readonly AllowEntry[];

/** The port a request connects to: its own, or its scheme's default. */
export function effectivePort(url: {
  protocol: string;
  port?: string | number | null;
}): number {
  if (url.port !== undefined && url.port !== null && url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

const ENTRY = /^(\[[^\]\s]*\]|[^:[\]/?#@\\\s]+)(?::(\d{1,5}))?$/;

/** Reads `FEED_FETCH_ALLOW_HOSTS`: comma-separated `host[:port]`. Throws on a bad entry. */
export function parseAllowHosts(config: ConfigReader): AllowList {
  const entries = readText(config, 'FEED_FETCH_ALLOW_HOSTS')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.map((entry, index) => {
    // The entry is never echoed: a mistyped one may carry a password.
    const bad = () =>
      new Error(
        `FEED_FETCH_ALLOW_HOSTS entry ${index + 1} must be a host or host:port, ` +
          'such as nas.lan, nas.lan:8080 or [fd00::5]:8080, with no scheme, path or credentials',
      );
    const match = ENTRY.exec(entry);
    if (!match) throw bad();
    let host: string;
    try {
      host = normaliseHost(new URL(`http://${match[1]}/`).hostname);
    } catch {
      throw bad();
    }
    // No wildcards or other characters a host name cannot hold.
    if (!isIP(host) && !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host)) throw bad();
    if (match[2] === undefined) return { host, ports: [80, 443] };
    const port = Number(match[2]);
    if (port < 1 || port > 65535) throw bad();
    return { host, ports: [port] };
  });
}

/** Exact host match, and the port must be one the entry opens. */
export function isAllowedHost(
  list: AllowList,
  host: string,
  port: number,
): boolean {
  const name = normaliseHost(host);
  return list.some((e) => e.host === name && e.ports.includes(port));
}

/**
 * Refuses a URL that is not plain http or https, or whose host is a
 * non-public literal or a local name, unless the host and port are listed.
 * Synchronous; no DNS.
 */
export function assertPublicUrl(
  input: string | URL,
  allow: AllowList = [],
): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressRefusedError('the address', 'is not a valid web address');
  }
  const host = normaliseHost(url.hostname);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressRefusedError(
      host || 'the address',
      'uses a scheme other than http or https',
    );
  }
  if (!host) {
    throw new EgressRefusedError('the address', 'is not a valid web address');
  }
  if (isAllowedHost(allow, host, effectivePort(url))) return;
  if (isIP(host) && !isPublicAddress(host)) {
    throw new EgressRefusedError(host, 'is not a public address');
  }
  if (isLocalName(host)) {
    throw new EgressRefusedError(host, 'is a local name');
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export type LookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/** A `lookup` hook that refuses when any answer is not public. */
export function publicLookup(resolve: LookupFn = dnsLookup as LookupFn) {
  return (
    hostname: string,
    optionsOrCallback: LookupOptions | number | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void => {
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback!;
    const options: LookupOptions =
      typeof optionsOrCallback === 'function'
        ? {}
        : typeof optionsOrCallback === 'number'
          ? { family: optionsOrCallback }
          : optionsOrCallback;
    resolve(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const answers = Array.isArray(address) ? address : [{ address }];
      if (
        answers.length === 0 ||
        !answers.every((answer) => isPublicAddress(answer.address))
      ) {
        return callback(
          new EgressRefusedError(
            normaliseHost(hostname),
            'resolves to a private address',
          ),
          address,
        );
      }
      callback(null, address, family);
    });
  };
}

interface ConnectionOptions {
  host?: string;
  hostname?: string;
  port?: number | string | null;
  lookup?: unknown;
}

/** Throws the refusal, or returns the options with a per-connection lookup. */
function guardConnection(
  options: ConnectionOptions,
  allow: AllowList,
  resolve: LookupFn,
  defaultPort: number,
): ConnectionOptions {
  const host = normaliseHost(options.host ?? options.hostname ?? 'localhost');
  const port = effectivePort({
    protocol: '',
    port: options.port ?? defaultPort,
  });
  const listed = isAllowedHost(allow, host, port);
  // net.connect never calls lookup for an IP literal, so it is checked here.
  if (isIP(host)) {
    if (!listed && !isPublicAddress(host)) {
      throw new EgressRefusedError(host, 'is not a public address');
    }
    return options;
  }
  // A lookup hook receives only the name, so it is built per connection to
  // know which port this connection is for.
  return { ...options, lookup: listed ? resolve : publicLookup(resolve) };
}

type Callback = (error: Error | null, socket?: Socket) => void;

/** Delivers a refusal through the error path, never as a synchronous throw. */
function connectGuarded(
  open: (options: ConnectionOptions, callback?: Callback) => Socket,
  options: ConnectionOptions,
  callback: Callback | undefined,
  guard: (options: ConnectionOptions) => ConnectionOptions,
): Socket {
  let guarded: ConnectionOptions;
  try {
    guarded = guard(options);
  } catch (error) {
    if (callback) {
      process.nextTick(callback, error as Error);
      return undefined as never;
    }
    const socket = new Socket();
    // Later than the request's own listener setup, which runs on nextTick.
    setImmediate(() => socket.destroy(error as Error));
    return socket;
  }
  return open(guarded, callback);
}

export interface EgressAgents {
  readonly http: HttpAgent;
  readonly https: HttpsAgent;
}

function buildAgents(allow: AllowList, resolve: LookupFn): EgressAgents {
  class GuardedHttpAgent extends HttpAgent {
    createConnection(options: never, callback?: never) {
      return connectGuarded(
        (o, cb) => super.createConnection(o as never, cb as never) as Socket,
        options,
        callback,
        (o) => guardConnection(o, allow, resolve, 80),
      );
    }
  }
  class GuardedHttpsAgent extends HttpsAgent {
    createConnection(options: never, callback?: never) {
      return connectGuarded(
        (o, cb) => super.createConnection(o as never, cb as never) as Socket,
        options,
        callback,
        (o) => guardConnection(o, allow, resolve, 443),
      );
    }
  }
  return { http: new GuardedHttpAgent(), https: new GuardedHttpsAgent() };
}

/** Agents that connect to public addresses only. */
export const strictAgents: EgressAgents = buildAgents(
  [],
  dnsLookup as LookupFn,
);

/** Agents that also connect to the listed hosts on their listed ports. */
export function allowlistedAgents(
  list: AllowList,
  resolve: LookupFn = dnsLookup as LookupFn,
): EgressAgents {
  return buildAgents(list, resolve);
}

/** The User-Agent for feed fetches: `FEED_FETCH_USER_AGENT`, or the self-hosted default. */
export function feedFetchUserAgent(config: ConfigReader): string {
  const value =
    readText(config, 'FEED_FETCH_USER_AGENT') || DEFAULT_FEED_USER_AGENT;
  try {
    validateHeaderValue('User-Agent', value);
  } catch {
    throw new Error(
      'FEED_FETCH_USER_AGENT is not a valid header value: remove line breaks and control characters',
    );
  }
  return value;
}
