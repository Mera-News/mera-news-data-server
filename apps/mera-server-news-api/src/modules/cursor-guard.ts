import { BadRequestException } from '@nestjs/common';

const MAX_CURSOR_LENGTH = 512;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Any cursor: at most 512 characters, named in the refusal, never echoed. */
export function assertCursorLength(after: string | null | undefined): void {
  if (after && after.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException(
      `after exceeds the maximum length of ${MAX_CURSOR_LENGTH} characters`,
    );
  }
}

/**
 * An offset cursor (`{ offset }`, used by the headline editions). The services
 * read a malformed one as the first page, so it is refused here instead.
 */
export function assertOffsetCursor(after: string | null | undefined): void {
  if (!after) return;
  assertCursorLength(after);
  let offset: unknown;
  try {
    offset = (
      JSON.parse(Buffer.from(after, 'base64').toString('utf-8')) as {
        offset?: unknown;
      }
    ).offset;
  } catch {
    refuse();
  }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    refuse();
  }
}

function refuse(): never {
  throw new BadRequestException('after is not a valid cursor');
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
    refuse();
  }
  if (typeof payload !== 'object' || payload === null) refuse();
  const { _id, createdAt } = payload as { _id?: unknown; createdAt?: unknown };
  if (
    _id !== undefined &&
    (typeof _id !== 'string' || !OBJECT_ID_HEX.test(_id))
  ) {
    refuse();
  }
  if (
    createdAt !== undefined &&
    (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)))
  ) {
    refuse();
  }
}
