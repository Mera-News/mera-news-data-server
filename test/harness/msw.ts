import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const unhandled: string[] = [];

// Last handler, kept across resetHandlers(). The code under test catches
// network errors (a feed fetch failure is an ordinary outcome), so a plain
// onUnhandledRequest: 'error' would not fail the test. Every unhandled request
// is answered with a network error AND recorded, and afterEach fails the test.
const refuseUnhandled = http.all('*', ({ request }) => {
  if (LOOPBACK.has(new URL(request.url).hostname)) return passthrough();
  unhandled.push(`${request.method} ${request.url}`);
  return HttpResponse.error();
});

export const server = setupServer(refuseUnhandled);

/** Unhandled requests seen since the last check; clears the list. */
export function takeUnhandled(): string[] {
  return unhandled.splice(0);
}

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

afterEach(() => {
  server.resetHandlers();
  const seen = takeUnhandled();
  if (seen.length > 0) {
    throw new Error(`Unhandled outbound request(s):\n${seen.join('\n')}`);
  }
});

afterAll(() => server.close());
