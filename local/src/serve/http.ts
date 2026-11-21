// The GraphQL endpoint on 127.0.0.1. It has no key, so it refuses what a web
// page in a browser could send: another Host, any Origin, a method other than
// POST, a body that is not JSON. It sends no CORS headers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildLocalSchema, runQuery, type Context } from './graphql.ts';

export const DEFAULT_PORT = 3002;
export const MAX_REQUEST_BYTES = 1024 * 1024;

const send = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const refuse = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { errors: [{ message, extensions: { code } }] });

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest is read and dropped, so the refusal still reaches the caller.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_REQUEST_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startServer(context: Context, port = DEFAULT_PORT): Promise<RunningServer> {
  const schema = buildLocalSchema();
  let bound = port;
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return refuse(res, 403, 'FORBIDDEN', 'Only 127.0.0.1 and localhost are answered.');
    if (req.headers.origin !== undefined) return refuse(res, 403, 'FORBIDDEN', 'Requests from web pages are refused.');
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health/ready') {
      return send(res, 200, { status: 'ok', articles: context.store.articleCount(), lastIngestAt: context.store.lastIngestAt() });
    }
    if (path !== '/graphql') return refuse(res, 404, 'NOT_FOUND', 'The endpoint is /graphql.');
    if (req.method !== 'POST') return refuse(res, 405, 'METHOD_NOT_ALLOWED', 'Send GraphQL as a POST.');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return refuse(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request as application/json.');
    const raw = await readBody(req);
    if (raw === null) return refuse(res, 413, 'PAYLOAD_TOO_LARGE', `The request is larger than ${MAX_REQUEST_BYTES} bytes.`);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return refuse(res, 400, 'BAD_REQUEST', 'The request body is not JSON.');
    }
    try {
      const { status, result } = await runQuery(schema, context, body);
      send(res, status, result);
    } catch {
      refuse(res, 500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  bound = (server.address() as AddressInfo).port;
  return { server, port: bound, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
