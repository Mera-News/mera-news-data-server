import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * A stand-in for an OpenAI-compatible embeddings server (what Ollama offers
 * at http://127.0.0.1:11434/v1), so the self-hosting guide can be followed
 * without a model. A text that mentions a story keyword gets that story's
 * fixed direction plus a little noise (about 0.99 related to its siblings);
 * any other text gets a direction of its own (about 0.5 related to anything).
 */

const MODEL = 'nomic-embed-text';
const DIMS = 768;
const NOISE = 0.1;
const { stories } = JSON.parse(
  readFileSync(new URL('fixtures/stories.json', import.meta.url), 'utf8'),
);

function hashDirection(text) {
  let seed = createHash('sha256').update(text).digest().readUInt32LE(0);
  const next = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  return Array.from({ length: DIMS }, next);
}

const unit = (v) => {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

export function embed(text) {
  const lower = text.toLowerCase();
  const story = stories.findIndex((s) =>
    s.keywords.some((k) => lower.includes(k)),
  );
  if (story < 0) return unit(hashDirection(text));
  const noise = unit(hashDirection(text));
  return unit(noise.map((x, i) => (i === story ? 1 : 0) + NOISE * x));
}

export function startFakeEmbeddings({ port = 11434, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      return reply(404, { error: 'not found' });
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'body is not JSON' });
      }
      if (body.model !== MODEL) {
        return reply(404, { error: `model "${body.model}" not found` });
      }
      const input = typeof body.input === 'string' ? [body.input] : body.input;
      if (!Array.isArray(input) || !input.every((t) => typeof t === 'string')) {
        return reply(400, {
          error: 'input must be a string or an array of strings',
        });
      }
      reply(200, {
        object: 'list',
        model: MODEL,
        data: input.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: embed(text),
        })),
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startFakeEmbeddings();
  console.log(`fake embeddings listening on 127.0.0.1:${port}`);
}
