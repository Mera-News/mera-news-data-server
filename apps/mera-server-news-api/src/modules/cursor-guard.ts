import { GraphQLError } from 'graphql';

const MAX_CURSOR_LENGTH = 512;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Any cursor: at most 512 characters, named in the refusal, never echoed. */
export function assertCursorLength(after: string | null | undefined): void {
  if (after && after.length > MAX_CURSOR_LENGTH) {
    throw new GraphQLError(
      `after exceeds the maximum length of ${MAX_CURSOR_LENGTH} characters`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
}

/**
 * An offset cursor (`{ offset }`, used by the headline editions, plus
 * `builtAt` on a per-headline cursor). The services read a malformed one as
 * the first page, so it is refused here instead.
 */
export function assertOffsetCursor(after: string | null | undefined): void {
  if (!after) return;
  assertCursorLength(after);
  let payload: { offset?: unknown; builtAt?: unknown } | null = null;
  try {
    payload = JSON.parse(Buffer.from(after, 'base64').toString('utf-8')) as {
      offset?: unknown;
      builtAt?: unknown;
    };
  } catch {
    refuseCursor();
  }
  const offset = payload?.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    refuseCursor();
  }
  const builtAt = payload?.builtAt;
  if (
    builtAt !== undefined &&
    (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt)))
  ) {
    refuseCursor();
  }
}

export function refuseCursor(): never {
  throw new GraphQLError('after is not a valid cursor', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * A keyset cursor is caller input that the services turn into ObjectIds and
 * dates, so it is checked here first: base64 JSON, at most 512 characters, an
 * `_id` of 24 hex characters and a `createdAt` that parses, when present. A
 * cursor that fails answers a bad request, never a server error.
 */
export function assertKeysetCursor(after: string | null | undefined): void {
  if (!after) return;
  assertCursorLength(after);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(after, 'base64').toString('utf-8'));
  } catch {
    refuseCursor();
  }
  if (typeof payload !== 'object' || payload === null) refuseCursor();
  const { _id, createdAt } = payload as { _id?: unknown; createdAt?: unknown };
  if (
    _id !== undefined &&
    (typeof _id !== 'string' || !OBJECT_ID_HEX.test(_id))
  ) {
    refuseCursor();
  }
  if (
    createdAt !== undefined &&
    (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)))
  ) {
    refuseCursor();
  }
}
