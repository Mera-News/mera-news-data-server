import { Types, QueryFilter } from 'mongoose';
import {
  PublicationNameCursor,
  PublisherNameCursor,
  CreatedAtCursor,
} from './cursor.utils';

/**
 * Build MongoDB filter for cursor-based pagination with ascending publication_name sort.
 *
 * For sorting by (publication_name: 1, _id: 1), we need:
 * (publication_name > cursorPublicationName) OR
 * (publication_name = cursorPublicationName AND _id > cursorId)
 */
export function buildPublicationNameCursorFilter(
  cursor: PublicationNameCursor,
): QueryFilter<any> {
  return {
    $or: [
      { publication_name: { $gt: cursor.publication_name } },
      {
        publication_name: cursor.publication_name,
        _id: { $gt: new Types.ObjectId(cursor._id) },
      },
    ],
  };
}

/**
 * Build MongoDB filter for cursor-based pagination with ascending name sort.
 *
 * For sorting by (name: 1, _id: 1), we need:
 * (name > cursorName) OR
 * (name = cursorName AND _id > cursorId)
 */
export function buildPublisherNameCursorFilter(
  cursor: PublisherNameCursor,
): QueryFilter<any> {
  return {
    $or: [
      { name: { $gt: cursor.name } },
      {
        name: cursor.name,
        _id: { $gt: new Types.ObjectId(cursor._id) },
      },
    ],
  };
}

/**
 * Build MongoDB filter for cursor-based pagination with descending createdAt sort.
 *
 * For sorting by (createdAt: -1, _id: -1), we need:
 * (createdAt < cursorCreatedAt) OR
 * (createdAt = cursorCreatedAt AND _id < cursorId)
 */
export function buildCreatedAtCursorFilter(
  cursor: CreatedAtCursor,
): QueryFilter<any> {
  return {
    $or: [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      {
        createdAt: new Date(cursor.createdAt),
        _id: { $lt: new Types.ObjectId(cursor._id) },
      },
    ],
  };
}
