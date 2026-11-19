import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AxiosService } from '@mera/async/modules/shared-utilities/axios/axios.service';
import { UrlSecurityModule } from '@mera/async/modules/shared-utilities/url-security/url-security.module';
import type { ProbeFetch } from '@mera/async/modules/shared-utilities/url-security/url-security-probe.service';
import { findEgressRefusal } from '@mera/shared/url/public-egress';

/**
 * The fetcher's socket-level refusals, against real servers that count what
 * reaches them. The CI job maps private-feed.example.test and
 * lan-feed.example.test to 127.0.0.1 in /etc/hosts, and trusts the certificate
 * in E2E_TLS_DIR through NODE_EXTRA_CA_CERTS. Every refusal asserts zero hits.
 */

interface Target {
  server: Server;
  port: number;
  /** Requests that reached the handler. */
  hits: string[];
  /** TCP connections, which count even when no request is ever sent. */
  connections: { count: number };
}

async function listen(
  server: Server,
  address: string,
  hits: string[],
): Promise<Target> {
  const connections = { count: 0 };
  server.on('connection', () => connections.count++);
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, address, ok);
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    hits,
    connections,
  };
}

/** Answers /feed with 200 and /redirect?to=<url> with a 302. */
function handler(hits: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss version="2.0"><channel><title>x</title></channel></rss>');
  };
}

async function httpTarget(address: string): Promise<Target> {
  const hits: string[] = [];
  return listen(createHttpServer(handler(hits)), address, hits);
}

async function httpsTarget(address: string): Promise<Target> {
  const dir = process.env.E2E_TLS_DIR;
  if (!dir) throw new Error('E2E_TLS_DIR must point at cert.pem and key.pem');
  const hits: string[] = [];
  const server = createHttpsServer(
    {
      cert: readFileSync(join(dir, 'cert.pem')),
      key: readFileSync(join(dir, 'key.pem')),
    },
    handler(hits),
  );
  return listen(server as unknown as Server, address, hits);
}

const config = (values: Record<string, string>) =>
  new ConfigService<Record<string, string>>(values);

const redirectTo = (base: string, to: string) =>
  `${base}/redirect?to=${encodeURIComponent(to)}`;

/** The probe's fetch, as the module binds it over the guarded direct instance. */
function probeFor(axios: AxiosService): ProbeFetch {
  const providers = Reflect.getMetadata('providers', UrlSecurityModule) as {
    provide?: string;
    useFactory?: (axios: AxiosService) => ProbeFetch;
  }[];
  const bound = providers.find((p) => p.provide === 'HTTPS_PROBE_FETCH');
  return bound!.useFactory!(axios);
}

const probeInit = () => ({
  method: 'HEAD',
  redirect: 'follow' as const,
  signal: AbortSignal.timeout(15_000),
});

describe('feed fetch egress guard', () => {
  let feed: Target; // 127.0.0.1, listed
  let other: Target; // 127.0.0.2, never listed
  let lanB: Target; // 127.0.0.1, a second port of the listed name
  let tls: Target; // 127.0.0.1, https, listed
  let proxy: Target; // a fake CONNECT proxy, and a fake HTTP_PROXY target
  let connects: string[];
  let axios: AxiosService;
  let proxied: AxiosService;

  beforeAll(async () => {
    feed = await httpTarget('127.0.0.1');
    other = await httpTarget('127.0.0.2');
    lanB = await httpTarget('127.0.0.1');
    tls = await httpsTarget('127.0.0.1');
    proxy = await httpTarget('127.0.0.1');
    connects = [];
    proxy.server.on('connect', (req, socket) => {
      connects.push(req.url ?? '');
      socket.destroy();
    });

    axios = new AxiosService(
      config({
        FEED_FETCH_ALLOW_HOSTS: [
          `127.0.0.1:${feed.port}`,
          `lan-feed.example.test:${feed.port}`,
          `127.0.0.1:${tls.port}`,
        ].join(','),
      }),
    );
    proxied = new AxiosService(
      config({ PROXY_URLS: `http://127.0.0.1:${proxy.port}` }),
    );
  });

  afterAll(async () => {
    for (const t of [feed, other, lanB, tls, proxy]) {
      t?.server.closeAllConnections();
      await new Promise((done) => t?.server.close(done));
    }
  });

  beforeEach(() => {
    for (const t of [feed, other, lanB, tls, proxy]) {
      t.hits.length = 0;
      t.connections.count = 0;
    }
    connects.length = 0;
  });

  it('refuses a name that resolves to loopback and is not listed, before any connection', async () => {
    const error = await axios
      .callWithoutProxy({
        url: `http://private-feed.example.test:${feed.port}/feed`,
      })
      .catch((e: unknown) => e);

    expect(findEgressRefusal(error)).toBeDefined();
    expect(feed.hits).toEqual([]);
    expect(feed.connections.count).toBe(0);
  });

  it('fetches a listed 127.0.0.1 feed and refuses its redirect to an unlisted 127.0.0.2 server', async () => {
    const ok = await axios.callWithoutProxy({
      url: `http://127.0.0.1:${feed.port}/feed`,
    });
    expect(ok.status).toBe(200);
    expect(feed.hits).toEqual(['/feed']);

    const error = await axios
      .callWithoutProxy({
        url: redirectTo(
          `http://127.0.0.1:${feed.port}`,
          `http://127.0.0.2:${other.port}/feed`,
        ),
      })
      .catch((e: unknown) => e);

    expect(findEgressRefusal(error)).toBeDefined();
    expect(other.hits).toEqual([]);
    expect(other.connections.count).toBe(0);
  });

  it('checks the port as well as the name: a listed name on another port is refused', async () => {
    const ok = await axios.callWithoutProxy({
      url: `http://lan-feed.example.test:${feed.port}/feed`,
    });
    expect(ok.status).toBe(200);
    expect(feed.hits).toEqual(['/feed']);

    const redirected = await axios
      .callWithoutProxy({
        url: redirectTo(
          `http://lan-feed.example.test:${feed.port}`,
          `http://lan-feed.example.test:${lanB.port}/feed`,
        ),
      })
      .catch((e: unknown) => e);
    expect(findEgressRefusal(redirected)).toBeDefined();

    // The same name and port B as a source of its own reaches the socket's
    // lookup, which is per connection and knows the port.
    const direct = await axios
      .callWithoutProxy({
        url: `http://lan-feed.example.test:${lanB.port}/feed`,
      })
      .catch((e: unknown) => e);
    expect(findEgressRefusal(direct)).toBeDefined();

    expect(lanB.hits).toEqual([]);
    expect(lanB.connections.count).toBe(0);
  });

  describe('https probe', () => {
    it('reaches a listed https target', async () => {
      const response = await probeFor(axios)(
        `https://127.0.0.1:${tls.port}/article`,
        probeInit(),
      );
      expect(response).toMatchObject({ ok: true, status: 200 });
      expect(tls.hits).toEqual(['/article']);
    });

    it('refuses its redirect to an unlisted 127.0.0.2 server', async () => {
      const error = await probeFor(axios)(
        redirectTo(
          `https://127.0.0.1:${tls.port}`,
          `http://127.0.0.2:${other.port}/article`,
        ),
        probeInit(),
      ).catch((e: unknown) => e);

      expect(findEgressRefusal(error)).toBeDefined();
      expect(other.hits).toEqual([]);
      expect(other.connections.count).toBe(0);
    });

    it('refuses an unlisted name before the TLS handshake, so the cause is the refusal', async () => {
      const error = await probeFor(axios)(
        `https://private-feed.example.test:${tls.port}/article`,
        probeInit(),
      ).catch((e: unknown) => e);

      expect(findEgressRefusal(error)).toBeDefined();
      expect(tls.hits).toEqual([]);
      expect(tls.connections.count).toBe(0);
    });
  });

  describe('proxy instance', () => {
    it('refuses an https feed at a private literal and sends the pool no CONNECT', async () => {
      const error = await proxied
        .callUsingProxy({ url: 'https://10.0.0.1/feed' })
        .catch((e: unknown) => e);

      expect(findEgressRefusal(error)).toBeDefined();
      expect(connects).toEqual([]);
      expect(proxy.connections.count).toBe(0);
    });

    it('refuses an http feed at an unlisted private name through the strict agent', async () => {
      const error = await proxied
        .callUsingProxy({
          url: `http://private-feed.example.test:${feed.port}/feed`,
        })
        .catch((e: unknown) => e);

      expect(findEgressRefusal(error)).toBeDefined();
      expect(feed.hits).toEqual([]);
      expect(feed.connections.count).toBe(0);
      expect(proxy.connections.count).toBe(0);
    });
  });

  it('ignores HTTP_PROXY: an http feed goes straight to its server', async () => {
    const saved = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.http_proxy = process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      const response = await axios.callWithoutProxy({
        url: `http://127.0.0.1:${feed.port}/feed`,
      });
      expect(response.status).toBe(200);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(feed.hits).toEqual(['/feed']);
    expect(proxy.hits).toEqual([]);
    expect(proxy.connections.count).toBe(0);
  });
});
