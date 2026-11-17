/**
 * Generic cursor encoding/decoding utilities for cursor-based pagination.
 * Cursors are opaque base64-encoded JSON payloads.
 */

export interface BaseCursorPayload {
  _id: string;
}

/**
 * Cursor payload for publication_name ascending sorting
 */
export interface PublicationNameCursor extends BaseCursorPayload {
  publication_name: string;
}

/**
 * Cursor payload for publisher name ascending sorting
 */
export interface PublisherNameCursor extends BaseCursorPayload {
  name: string;
}

/**
 * Cursor payload for createdAt descending sorting
 */
export interface CreatedAtCursor extends BaseCursorPayload {
  createdAt: string; // ISO 8601
}

/**
 * Encode a cursor payload to a base64 string
 */
export function encodeCursor<T extends BaseCursorPayload>(payload: T): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf-8').toString('base64');
}

/**
 * Decode a base64 cursor string to its payload
 * Returns null if decoding fails
 */
export function decodeCursor<T extends BaseCursorPayload>(
  cursor: string,
): T | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf-8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
