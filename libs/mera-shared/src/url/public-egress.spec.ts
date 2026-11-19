import { once } from 'events';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  EgressRefusedError,
  allowlistedAgents,
  assertPublicUrl,
  effectivePort,
  feedFetchUserAgent,
  isAllowedHost,
  isPublicAddress,
  parseAllowHosts,
  publicLookup,
  strictAgents,
} from './public-egress';

const config = (values: Record<string, string>) => ({
  get: <T = unknown>(key: string) => values[key] as T | undefined,
});
const allow = (entries: string) =>
  parseAllowHosts(config({ FEED_FETCH_ALLOW_HOSTS: entries }));

describe('isPublicAddress', () => {
  const blocked: Array<[string, string]> = [
    // IPv4, one probe inside each range (and one at the far edge where useful)
    ['0.0.0.1', '0/8'],
    ['0.0.0.0', '0/8'],
    ['10.1.2.3', '10/8'],
    ['100.64.0.1', '100.64/10'],
    ['100.100.100.200', '100.64/10 (cloud metadata)'],
    ['100.127.255.254', '100.64/10'],
    ['127.0.0.1', '127/8'],
    ['127.255.255.254', '127/8'],
    ['169.254.169.254', '169.254/16 (cloud metadata)'],
    ['172.16.0.1', '172.16/12'],
    ['172.31.255.254', '172.16/12'],
    ['192.0.0.192', '192.0.0/24 (cloud metadata)'],
    ['192.0.2.1', '192.0.2/24'],
    ['192.88.99.1', '192.88.99/24'],
    ['192.168.1.1', '192.168/16'],
    ['198.18.0.1', '198.18/15'],
    ['198.19.255.254', '198.18/15'],
    ['198.51.100.1', '198.51.100/24'],
    ['203.0.113.1', '203.0.113/24'],
    ['224.0.0.1', '224/4'],
    ['239.255.255.250', '224/4'],
    ['240.0.0.1', '240/4'],
    ['255.255.255.255', '240/4 (broadcast)'],
    ['168.63.129.16', '168.63.129.16/32 (Azure host endpoint)'],
    // IPv6
    ['::', '::/128'],
    ['::1', '::1/128'],
    ['::7f00:1', '::/96'],
    ['::2', '::/96'],
    ['100::1', '100::/64'],
    ['2001::1', '2001::/32 (Teredo)'],
    ['2001:db8::1', '2001:db8::/32'],
    ['2002:7f00:1::1', '2002::/16 (6to4)'],
    ['64:ff9b:1::1', '64:ff9b:1::/48'],
    ['fc00::1', 'fc00::/7'],
    ['fd00:ec2::254', 'fc00::/7 (cloud metadata)'],
    ['fec0::1', 'fec0::/10'],
    ['fe80::1', 'fe80::/10'],
    ['febf::1', 'fe80::/10'],
    ['ff02::1', 'ff00::/8'],
    // forms that must not slip through
    ['::ffff:127.0.0.1', 'IPv4-mapped, dotted'],
    ['::ffff:7f00:1', 'IPv4-mapped, hex'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['64:ff9b::7f00:1', 'NAT64 embedding 127.0.0.1'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 embedding 169.254.169.254'],
    ['64:ff9b::10.0.0.1', 'NAT64, dotted tail'],
    ['fe80::1%eth0', 'zone-scoped'],
    ['FE80::1', 'upper case'],
  ];

  it.each(blocked)('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  const open = [
    '8.8.8.8',
    '1.1.1.1',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.255.255',
    '169.255.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '192.167.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '168.63.129.15',
    '168.63.129.17',
    '2001:4860:4860::8888',
    '2606:4700::1111',
    '2620:fe::fe',
    '2a00:1450:4001::1',
    '64:ff9b::808:808',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
  ];
  it.each(open)('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'not-an-ip',
    'localhost',
    '1.2.3',
    '999.1.1.1',
    '8.8.8.8%eth0',
    '8.8.8.8/32',
    '[::1]',
    '2001:4860::8888%',
    'fe80::1%',
  ])(
    'treats %j, which does not parse as an address, as not public',
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );
});

describe('assertPublicUrl', () => {
  const refused = [
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0/',
    'http://[::]/',
    'http://255.255.255.255/',
    'http://169.254.169.254./',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[fe80::1%25eth0]/',
    'http://LOCALHOST./',
    'http://localhost/',
    'http://a.localhost/',
    'http://a.b.localhost./',
    'http://ⓛocalhost/',
    'http://１２７.０.０.１/',
    'http://public.example@127.0.0.1/',
    'http://127.0.0.1#@public.example/',
    'http://u:p@[::1]:8080/',
    'https://10.0.0.1/feed',
    'file:///etc/passwd',
    'data:text/plain;base64,aGk=',
    'ftp://public.example.test/',
    'gopher://public.example.test/',
    'javascript:alert(1)',
    'not a url',
    '',
  ];
  it.each(refused)('refuses %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(EgressRefusedError);
  });

  const accepted = [
    'https://feeds.example.test/rss.xml',
    'HTTP://feeds.example.test/rss.xml',
    'http://8.8.8.8/',
    'https://[2606:4700::1111]/',
    'http://localhost.example.test/',
    'http://notlocalhost/',
    'https://feeds.example.test:8443/rss',
    'http://[64:ff9b::808:808]/',
  ];
  it.each(accepted)('accepts %s', (url) => {
    expect(() => assertPublicUrl(url)).not.toThrow();
  });

  it('accepts a URL object as well as a string', () => {
    expect(() => assertPublicUrl(new URL('http://127.0.0.1/'))).toThrow(
      EgressRefusedError,
    );
    expect(() => assertPublicUrl(new URL('http://8.8.8.8/'))).not.toThrow();
  });

  it('carries a code and reason, and builds its message from the host only', () => {
    let error: EgressRefusedError | undefined;
    try {
      assertPublicUrl('http://user:pw@127.0.0.1/secret/path?token=abc#frag');
    } catch (caught) {
      error = caught as EgressRefusedError;
    }
    expect(error).toBeInstanceOf(EgressRefusedError);
    expect(error?.code).toBe('EGRESS_REFUSED');
    expect(error?.reason).toBe('is not a public address');
    expect(error?.message).toBe(
      'refused: 127.0.0.1 is not a public address; add it to FEED_FETCH_ALLOW_HOSTS',
    );
    for (const marker of ['pw', 'secret', 'token', 'abc', 'frag', 'user']) {
      expect(error?.message).not.toContain(marker);
    }
  });

  it('names the reason for a local name and for an unparseable address', () => {
    expect(() => assertPublicUrl('http://a.localhost/')).toThrow(
      'refused: a.localhost is a local name; add it to FEED_FETCH_ALLOW_HOSTS',
    );
    expect(() => assertPublicUrl('not a url')).toThrow(
      'refused: the address is not a valid web address',
    );
  });

  it('gives a scheme refusal no allowlist hint, even for a listed host', () => {
    const list = allow('nas.lan');
    let message = '';
    try {
      assertPublicUrl('ftp://nas.lan/', list);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'refused: nas.lan uses a scheme other than http or https',
    );
    expect(message).not.toContain('FEED_FETCH_ALLOW_HOSTS');
    expect(() => assertPublicUrl('data:text/plain,hi', list)).toThrow(
      EgressRefusedError,
    );
  });

  it('lifts the address checks for a listed host and port, and no other', () => {
    const list = allow('nas.lan,127.0.0.1:8080,[fd00::5]:8080,box.localhost');
    expect(() => assertPublicUrl('http://nas.lan/', list)).not.toThrow();
    expect(() => assertPublicUrl('https://nas.lan/', list)).not.toThrow();
    expect(() => assertPublicUrl('http://127.0.0.1:8080/', list)).not.toThrow();
    expect(() => assertPublicUrl('http://[fd00::5]:8080/', list)).not.toThrow();
    expect(() => assertPublicUrl('http://box.localhost/', list)).not.toThrow();
    // a listed literal does not open the other ports on the same host
    expect(() => assertPublicUrl('http://127.0.0.1:6379/', list)).toThrow(
      EgressRefusedError,
    );
    expect(() => assertPublicUrl('http://127.0.0.1/', list)).toThrow(
      EgressRefusedError,
    );
    expect(() => assertPublicUrl('http://[fd00::5]:80/', list)).toThrow(
      EgressRefusedError,
    );
    expect(() =>
      assertPublicUrl('http://nas.lan.evil.test/', list),
    ).not.toThrow();
    expect(() => assertPublicUrl('http://10.0.0.1/', list)).toThrow(
      EgressRefusedError,
    );
  });
});

describe('effectivePort', () => {
  it('fills an empty port from the scheme', () => {
    expect(effectivePort(new URL('http://a.test/'))).toBe(80);
    expect(effectivePort(new URL('https://a.test/'))).toBe(443);
    expect(effectivePort(new URL('http://a.test:80/'))).toBe(80);
    expect(effectivePort(new URL('https://a.test:443/'))).toBe(443);
    expect(effectivePort(new URL('http://a.test:8080/'))).toBe(8080);
    expect(effectivePort(new URL('https://a.test:80/'))).toBe(80);
  });

  it('takes the protocol and port a redirect hop reports', () => {
    expect(effectivePort({ protocol: 'https:', port: '' })).toBe(443);
    expect(effectivePort({ protocol: 'http:', port: undefined })).toBe(80);
    expect(effectivePort({ protocol: 'http:', port: 8080 })).toBe(8080);
  });
});

describe('parseAllowHosts', () => {
  it('is empty when the key is unset or blank', () => {
    expect(parseAllowHosts(config({}))).toEqual([]);
    expect(allow('')).toEqual([]);
    expect(allow(' , ,')).toEqual([]);
  });

  it('normalises an entry the way a URL host is normalised', () => {
    const list = allow('NAS.LAN.');
    expect(isAllowedHost(list, 'nas.lan', 80)).toBe(true);
    expect(isAllowedHost(list, 'nas.lan.', 443)).toBe(true);
    expect(isAllowedHost(allow('0x7f.1:8080'), '127.0.0.1', 8080)).toBe(true);
    expect(
      isAllowedHost(
        allow('bücher.example.test'),
        'xn--bcher-kva.example.test',
        80,
      ),
    ).toBe(true);
  });

  it('matches an entry without a port on 80 and 443 only', () => {
    const list = allow('nas.lan');
    expect(isAllowedHost(list, 'nas.lan', 80)).toBe(true);
    expect(isAllowedHost(list, 'nas.lan', 443)).toBe(true);
    expect(isAllowedHost(list, 'nas.lan', 8080)).toBe(false);
    expect(isAllowedHost(list, 'nas.lan', 6379)).toBe(false);
  });

  it('matches an entry with a port on that port only, default ports included', () => {
    const list = allow('nas.lan:80');
    expect(
      isAllowedHost(list, 'nas.lan', effectivePort(new URL('http://nas.lan/'))),
    ).toBe(true);
    expect(
      isAllowedHost(
        list,
        'nas.lan',
        effectivePort(new URL('https://nas.lan/')),
      ),
    ).toBe(false);
    expect(
      isAllowedHost(
        list,
        'nas.lan',
        effectivePort(new URL('http://nas.lan:443/')),
      ),
    ).toBe(false);
    expect(
      isAllowedHost(
        list,
        'nas.lan',
        effectivePort(new URL('http://nas.lan:8080/')),
      ),
    ).toBe(false);
    expect(isAllowedHost(allow('nas.lan:443'), 'nas.lan', 443)).toBe(true);
    expect(isAllowedHost(allow('nas.lan:443'), 'nas.lan', 80)).toBe(false);
  });

  it('does not open other ports of a listed address', () => {
    const list = allow('127.0.0.1');
    expect(isAllowedHost(list, '127.0.0.1', 6379)).toBe(false);
    expect(isAllowedHost(list, '127.0.0.1', 27017)).toBe(false);
  });

  it('matches the host exactly: no suffix, wildcard or prefix match', () => {
    const list = allow('nas.lan');
    expect(isAllowedHost(list, 'nas.lan.evil.test', 80)).toBe(false);
    expect(isAllowedHost(list, 'evil-nas.lan', 80)).toBe(false);
    expect(isAllowedHost(list, 'sub.nas.lan', 80)).toBe(false);
    expect(() => allow('*.lan')).toThrow();
    expect(() => allow('10.0.0.0/8')).toThrow();
  });

  it('accepts several entries, with spaces, and merges nothing across hosts', () => {
    const list = allow(' nas.lan:8080 , other.lan ,127.0.0.1:9 ');
    expect(isAllowedHost(list, 'nas.lan', 8080)).toBe(true);
    expect(isAllowedHost(list, 'nas.lan', 80)).toBe(false);
    expect(isAllowedHost(list, 'other.lan', 443)).toBe(true);
    expect(isAllowedHost(list, '127.0.0.1', 9)).toBe(true);
  });

  it('parses a bracketed IPv6 entry and refuses an unbracketed one', () => {
    const list = allow('[FD00::5]:8080');
    expect(isAllowedHost(list, 'fd00::5', 8080)).toBe(true);
    expect(isAllowedHost(list, 'fd00::5', 80)).toBe(false);
    expect(isAllowedHost(allow('[fd00::5]'), 'fd00::5', 443)).toBe(true);
    expect(() => allow('fd00::5')).toThrow();
    expect(() => allow('fd00::5:8080')).toThrow();
  });

  it.each([
    'http://nas.lan',
    'https://nas.lan:8443',
    'nas.lan/feeds',
    'nas.lan/',
    'nas.lan?x=1',
    'nas.lan#frag',
    'user@nas.lan',
    'user:pw@nas.lan',
    'nas.lan:',
    'nas.lan:0',
    'nas.lan:65536',
    'nas.lan:http',
    'nas lan',
    '[fd00::zz]',
    '[fd00::5',
    ':80',
  ])('throws at boot for the entry %j', (entry) => {
    expect(() => allow(entry)).toThrow(/FEED_FETCH_ALLOW_HOSTS/);
  });

  it('does not echo a bad entry, which could carry a password', () => {
    expect(() => allow('user:hunter2@nas.lan')).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('hunter2'),
      }),
    );
  });
});

describe('publicLookup', () => {
  type Resolver = Parameters<typeof publicLookup>[0];
  const answering =
    (answer: string | Array<{ address: string; family: number }>): Resolver =>
    (_host, _options, callback) =>
      callback(null, answer as never, 4);

  const lookup = (resolver: Resolver, options: object = {}) =>
    new Promise<{ error: Error | null; address?: unknown }>((resolve) => {
      publicLookup(resolver)('feed.example.test', options, (error, address) =>
        resolve({ error, address }),
      );
    });

  it('passes a public single answer', async () => {
    const { error, address } = await lookup(answering('8.8.8.8'));
    expect(error).toBeNull();
    expect(address).toBe('8.8.8.8');
  });

  it('refuses a private single answer', async () => {
    const { error } = await lookup(answering('10.0.0.5'));
    expect(error).toBeInstanceOf(EgressRefusedError);
    expect((error as EgressRefusedError).reason).toBe(
      'resolves to a private address',
    );
  });

  it('refuses a mixed all:true array, and passes a public one', async () => {
    const mixed = await lookup(
      answering([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      { all: true },
    );
    expect(mixed.error).toBeInstanceOf(EgressRefusedError);
    const open = await lookup(
      answering([
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ]),
      { all: true },
    );
    expect(open.error).toBeNull();
    expect(open.address).toHaveLength(2);
  });

  it('refuses an empty answer and an unparseable one', async () => {
    expect((await lookup(answering([]), { all: true })).error).toBeInstanceOf(
      EgressRefusedError,
    );
    expect((await lookup(answering('not-an-ip'))).error).toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it.each([
    ['metadata.google.internal', '169.254.169.254'],
    ['127.0.0.1.nip.io', '127.0.0.1'],
    ['redis', '172.18.0.2'],
    ['fd-name.example.test', 'fd00:ec2::254'],
  ])('refuses %s answering %s', async (host, answer) => {
    const resolver: Resolver = (name, _options, callback) => {
      expect(name).toBe(host);
      callback(null, answer as never, 4);
    };
    const error = await new Promise<Error | null>((resolve) =>
      publicLookup(resolver)(host, {}, (e) => resolve(e)),
    );
    expect(error).toBeInstanceOf(EgressRefusedError);
    expect((error as Error).message).toContain(host);
  });

  it('accepts the options argument as a callback or a family number', async () => {
    const seen: unknown[] = [];
    const resolver: Resolver = (_host, options, callback) => {
      seen.push(options);
      callback(null, '8.8.8.8' as never, 4);
    };
    await new Promise<void>((resolve) =>
      (publicLookup(resolver) as (h: string, cb: () => void) => void)(
        'a.test',
        () => resolve(),
      ),
    );
    await new Promise<void>((resolve) =>
      (
        publicLookup(resolver) as (h: string, f: number, cb: () => void) => void
      )('a.test', 6, () => resolve()),
    );
    expect(seen).toEqual([{}, { family: 6 }]);
  });

  it('passes a resolver error through unchanged', async () => {
    const failure = Object.assign(new Error('boom'), { code: 'ENOTFOUND' });
    const resolver: Resolver = (_host, _options, callback) =>
      callback(failure, undefined as never);
    expect((await lookup(resolver)).error).toBe(failure);
  });
});

describe('agents', () => {
  const refusal = (host: string, port: number, agent: http.Agent) =>
    new Promise<Error | null>((resolve) => {
      let threw = false;
      try {
        agent.createConnection({ host, port }, (error) => resolve(error));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

  it.each([
    ['127.0.0.1', 80],
    ['10.0.0.1', 443],
    ['169.254.169.254', 80],
    ['::1', 80],
    ['::ffff:127.0.0.1', 80],
    ['fe80::1%eth0', 80],
  ])(
    'refuses the literal %s:%d through the callback, never by throwing',
    async (host, port) => {
      for (const agents of [
        strictAgents,
        allowlistedAgents(allow('nas.lan')),
      ]) {
        for (const agent of [agents.http, agents.https]) {
          const error = await refusal(host, port, agent);
          expect(error).toBeInstanceOf(EgressRefusedError);
          expect((error as EgressRefusedError).code).toBe('EGRESS_REFUSED');
        }
      }
    },
  );

  it('refuses a literal through an error event on the returned socket', async () => {
    for (const agent of [strictAgents.http, strictAgents.https]) {
      let socket: ReturnType<http.Agent['createConnection']> | undefined;
      expect(() => {
        socket = agent.createConnection({ host: '127.0.0.1', port: 80 });
      }).not.toThrow();
      const [error] = await once(socket as NodeJS.EventEmitter, 'error');
      expect(error).toBeInstanceOf(EgressRefusedError);
    }
  });

  it('delivers a literal refusal to http.get as an error on the request', async () => {
    const error = await new Promise<Error>((resolve) => {
      http
        .get({ host: '127.0.0.1', port: 9, agent: strictAgents.http })
        .on('error', resolve);
    });
    expect(error).toBeInstanceOf(EgressRefusedError);
  });

  describe('against local servers', () => {
    const servers: http.Server[] = [];
    const hits = new Map<number, number>();
    const listen = async () => {
      const server = http.createServer((req, res) => {
        const port = (server.address() as AddressInfo).port;
        hits.set(port, (hits.get(port) ?? 0) + 1);
        res.end('ok');
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return (server.address() as AddressInfo).port;
    };
    afterEach(async () => {
      hits.clear();
      await Promise.all(
        servers.splice(0).map((s) => new Promise((r) => s.close(r))),
      );
    });

    const get = (host: string, port: number, agent: http.Agent) =>
      new Promise<{ status?: number; error?: Error }>((resolve) => {
        http
          .get({ host, port, agent, path: '/' }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode }));
          })
          .on('error', (error) => resolve({ error }));
      });

    it('refuses a loopback server with an empty allowlist and sends nothing', async () => {
      const port = await listen();
      const result = await get('127.0.0.1', port, strictAgents.http);
      expect(result.error).toBeInstanceOf(EgressRefusedError);
      expect(hits.get(port)).toBeUndefined();
    });

    it('connects to a listed literal on its listed port only', async () => {
      const a = await listen();
      const b = await listen();
      const agents = allowlistedAgents(allow(`127.0.0.1:${a}`));
      expect((await get('127.0.0.1', a, agents.http)).status).toBe(200);
      expect((await get('127.0.0.1', b, agents.http)).error).toBeInstanceOf(
        EgressRefusedError,
      );
      expect(hits.get(a)).toBe(1);
      expect(hits.get(b)).toBeUndefined();
    });

    it('lets a listed name resolve to a private address on its port only', async () => {
      const a = await listen();
      const b = await listen();
      const resolver: Parameters<typeof publicLookup>[0] = (_h, options, cb) =>
        options.all
          ? cb(null, [{ address: '127.0.0.1', family: 4 }])
          : cb(null, '127.0.0.1', 4);
      const agents = allowlistedAgents(allow(`nas.lan:${a}`), resolver);
      expect((await get('nas.lan', a, agents.http)).status).toBe(200);
      const refused = await get('nas.lan', b, agents.http);
      expect(refused.error).toBeInstanceOf(EgressRefusedError);
      expect((refused.error as EgressRefusedError).reason).toBe(
        'resolves to a private address',
      );
      expect(hits.get(a)).toBe(1);
      expect(hits.get(b)).toBeUndefined();
    });

    it('refuses an unlisted name that resolves to a private address', async () => {
      const port = await listen();
      const resolver: Parameters<typeof publicLookup>[0] = (_h, options, cb) =>
        options.all
          ? cb(null, [{ address: '127.0.0.1', family: 4 }])
          : cb(null, '127.0.0.1', 4);
      const agents = allowlistedAgents(allow(`nas.lan:${port}`), resolver);
      const result = await get('nas.lan.evil.test', port, agents.http);
      expect(result.error).toBeInstanceOf(EgressRefusedError);
      expect(hits.get(port)).toBeUndefined();
    });
  });
});

describe('feedFetchUserAgent', () => {
  it('defaults to a value that names the software and says it is self-hosted', () => {
    expect(feedFetchUserAgent(config({}))).toBe(
      'mera-news-data-server (self-hosted)',
    );
    expect(feedFetchUserAgent(config({ FEED_FETCH_USER_AGENT: '  ' }))).toBe(
      'mera-news-data-server (self-hosted)',
    );
  });

  it('uses the configured value, trimmed', () => {
    expect(
      feedFetchUserAgent(
        config({
          FEED_FETCH_USER_AGENT: ' MeraNewsBot/1.0 (+https://mera.news/bot) ',
        }),
      ),
    ).toBe('MeraNewsBot/1.0 (+https://mera.news/bot)');
  });

  it.each(['bot\nX-Injected: 1', 'bot\r\nX: y', 'bot\u0000', 'bot\u0007'])(
    'throws for the value %j, which is not a valid header value',
    (value) => {
      expect(() =>
        feedFetchUserAgent(config({ FEED_FETCH_USER_AGENT: value })),
      ).toThrow(/FEED_FETCH_USER_AGENT/);
    },
  );
});
