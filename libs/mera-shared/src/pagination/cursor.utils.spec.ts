import { encodeCursor, decodeCursor } from './cursor.utils';
import type {
  BaseCursorPayload,
  CreatedAtCursor,
  PublicationNameCursor,
  PublisherNameCursor,
} from './cursor.utils';

describe('encodeCursor', () => {
  it('encodes a base cursor payload to base64', () => {
    const payload: BaseCursorPayload = { _id: 'abc123' };
    const encoded = encodeCursor(payload);
    expect(typeof encoded).toBe('string');
    expect(encoded).toBe(
      Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64'),
    );
  });

  it('encodes a PublicationNameCursor with extra fields', () => {
    const payload: PublicationNameCursor = {
      _id: 'id1',
      publication_name: 'TechCrunch',
    };
    const encoded = encodeCursor(payload);
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf-8'),
    );
    expect(decoded).toEqual(payload);
  });

  it('encodes a PublisherNameCursor', () => {
    const payload: PublisherNameCursor = { _id: 'id2', name: 'BBC' };
    const encoded = encodeCursor(payload);
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf-8'),
    );
    expect(decoded).toEqual(payload);
  });

  it('encodes a CreatedAtCursor', () => {
    const payload: CreatedAtCursor = {
      _id: 'id3',
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    const encoded = encodeCursor(payload);
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf-8'),
    );
    expect(decoded).toEqual(payload);
  });
});

describe('decodeCursor', () => {
  it('round-trips a cursor through encode → decode', () => {
    const payload: PublicationNameCursor = {
      _id: 'xyz',
      publication_name: 'Reuters',
    };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor<PublicationNameCursor>(encoded);
    expect(decoded).toEqual(payload);
  });

  it('returns null for an invalid base64 string that is not valid JSON', () => {
    // Encode garbage bytes then mutate; easier to just use an invalid payload
    const result = decodeCursor<BaseCursorPayload>('!!!not-valid-base64!!!');
    expect(result).toBeNull();
  });

  it('returns null for valid base64 that is not JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf-8').toString('base64');
    const result = decodeCursor<BaseCursorPayload>(notJson);
    expect(result).toBeNull();
  });

  it('decodes a CreatedAtCursor correctly', () => {
    const payload: CreatedAtCursor = {
      _id: 'abc',
      createdAt: '2025-03-15T12:00:00.000Z',
    };
    const decoded = decodeCursor<CreatedAtCursor>(encodeCursor(payload));
    expect(decoded?._id).toBe('abc');
    expect(decoded?.createdAt).toBe('2025-03-15T12:00:00.000Z');
  });

  it('returns null for an empty string', () => {
    const result = decodeCursor<BaseCursorPayload>('');
    // Buffer.from('', 'base64').toString('utf-8') is '' which JSON.parse throws on
    expect(result).toBeNull();
  });
});
