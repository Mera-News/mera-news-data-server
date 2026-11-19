import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * Five RSS feeds on a loopback port, with the items in fixtures/stories.json:
 * three stories reported by several publishers and two stories nobody else
 * covers. Item dates are set when the publisher starts, so they are always
 * recent. Every request path is recorded and listed at /__hits.
 */

const { feeds, items } = JSON.parse(
  readFileSync(new URL('fixtures/stories.json', import.meta.url), 'utf8'),
);

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderFeed(feed, startedAt) {
  const entries = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.feed === feed.slug)
    .map(({ item, index }) => {
      const link = `https://${feed.slug}.example.test/${item.slug}`;
      const date = new Date(startedAt - (index + 1) * 10 * 60 * 1000);
      return `<item><title>${escapeXml(item.title)}</title><link>${link}</link><guid>${link}</guid><pubDate>${date.toUTCString()}</pubDate><description>${escapeXml(item.description)}</description></item>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(feed.publication_name)}</title><link>https://${feed.slug}.example.test</link><description>${escapeXml(feed.publication_name)}</description><language>${feed.language}</language>${entries.join('')}</channel></rss>`;
}

export function startFixturePublisher({
  port = 8765,
  host = '127.0.0.1',
} = {}) {
  const startedAt = Date.now();
  const hits = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/__hits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(hits));
    }
    hits.push(path);
    const feed = feeds.find((f) => path === `/feeds/${f.slug}.xml`);
    if (!feed) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(renderFeed(feed, startedAt));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        hits,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startFixturePublisher();
  console.log(`fixture publisher listening on 127.0.0.1:${port}`);
}
