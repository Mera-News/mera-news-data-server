import { Types } from 'mongoose';
import {
  buildPublicationNameCursorFilter,
  buildPublisherNameCursorFilter,
  buildCreatedAtCursorFilter,
} from './mongo-cursor-filter';
import type {
  PublicationNameCursor,
  PublisherNameCursor,
  CreatedAtCursor,
} from './cursor.utils';

const VALID_OBJECT_ID = '507f1f77bcf86cd799439011';

describe('buildPublicationNameCursorFilter', () => {
  it('returns $or filter with $gt on publication_name and compound tie-break on _id', () => {
    const cursor: PublicationNameCursor = {
      _id: VALID_OBJECT_ID,
      publication_name: 'TechCrunch',
    };
    const filter = buildPublicationNameCursorFilter(cursor);

    expect(filter).toHaveProperty('$or');
    const [nameGt, tieBreak] = filter.$or as any[];

    expect(nameGt).toEqual({ publication_name: { $gt: 'TechCrunch' } });
    expect(tieBreak.publication_name).toBe('TechCrunch');
    expect(tieBreak._id.$gt).toBeInstanceOf(Types.ObjectId);
    expect(tieBreak._id.$gt.toString()).toBe(VALID_OBJECT_ID);
  });

  it('constructs a valid ObjectId from cursor._id', () => {
    const cursor: PublicationNameCursor = {
      _id: VALID_OBJECT_ID,
      publication_name: 'BBC',
    };
    const filter = buildPublicationNameCursorFilter(cursor);
    const tieBreak = (filter.$or as any[])[1];
    expect(tieBreak._id.$gt.equals(new Types.ObjectId(VALID_OBJECT_ID))).toBe(
      true,
    );
  });
});

describe('buildPublisherNameCursorFilter', () => {
  it('returns $or filter with $gt on name and compound tie-break on _id', () => {
    const cursor: PublisherNameCursor = {
      _id: VALID_OBJECT_ID,
      name: 'Reuters',
    };
    const filter = buildPublisherNameCursorFilter(cursor);

    expect(filter).toHaveProperty('$or');
    const [nameGt, tieBreak] = filter.$or as any[];

    expect(nameGt).toEqual({ name: { $gt: 'Reuters' } });
    expect(tieBreak.name).toBe('Reuters');
    expect(tieBreak._id.$gt).toBeInstanceOf(Types.ObjectId);
    expect(tieBreak._id.$gt.toString()).toBe(VALID_OBJECT_ID);
  });

  it('constructs a valid ObjectId from cursor._id', () => {
    const cursor: PublisherNameCursor = {
      _id: VALID_OBJECT_ID,
      name: 'Guardian',
    };
    const filter = buildPublisherNameCursorFilter(cursor);
    const tieBreak = (filter.$or as any[])[1];
    expect(tieBreak._id.$gt.equals(new Types.ObjectId(VALID_OBJECT_ID))).toBe(
      true,
    );
  });
});

describe('buildCreatedAtCursorFilter', () => {
  const ISO_DATE = '2024-06-01T10:00:00.000Z';

  it('returns $or filter with $lt on createdAt and compound tie-break on _id', () => {
    const cursor: CreatedAtCursor = {
      _id: VALID_OBJECT_ID,
      createdAt: ISO_DATE,
    };
    const filter = buildCreatedAtCursorFilter(cursor);

    expect(filter).toHaveProperty('$or');
    const [dateGt, tieBreak] = filter.$or as any[];

    expect(dateGt.createdAt.$lt).toBeInstanceOf(Date);
    expect(dateGt.createdAt.$lt.toISOString()).toBe(ISO_DATE);

    expect(tieBreak.createdAt).toBeInstanceOf(Date);
    expect(tieBreak._id.$lt).toBeInstanceOf(Types.ObjectId);
    expect(tieBreak._id.$lt.toString()).toBe(VALID_OBJECT_ID);
  });

  it('converts cursor.createdAt ISO string to Date objects', () => {
    const cursor: CreatedAtCursor = {
      _id: VALID_OBJECT_ID,
      createdAt: ISO_DATE,
    };
    const filter = buildCreatedAtCursorFilter(cursor);
    const [ltClause] = filter.$or as any[];
    expect(ltClause.createdAt.$lt.getTime()).toBe(new Date(ISO_DATE).getTime());
  });

  it('constructs a valid ObjectId from cursor._id', () => {
    const cursor: CreatedAtCursor = {
      _id: VALID_OBJECT_ID,
      createdAt: ISO_DATE,
    };
    const filter = buildCreatedAtCursorFilter(cursor);
    const tieBreak = (filter.$or as any[])[1];
    expect(tieBreak._id.$lt.equals(new Types.ObjectId(VALID_OBJECT_ID))).toBe(
      true,
    );
  });
});
