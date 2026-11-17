import 'reflect-metadata';
import { PlaceSchema } from './place.model';

describe('Place model', () => {
  it('exposes search_keys as a string array path', () => {
    const path = PlaceSchema.path('search_keys');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Array');
    // Element type is String.
    expect(
      (path as { embeddedSchemaType?: { instance?: string } })
        .embeddedSchemaType?.instance,
    ).toBe('String');
  });

  it('declares a multikey btree index on search_keys', () => {
    const hasIndex = PlaceSchema.indexes().some(
      ([def]) => (def as Record<string, unknown>).search_keys === 1,
    );
    expect(hasIndex).toBe(true);
  });

  it('keeps the existing normalized index', () => {
    const hasIndex = PlaceSchema.indexes().some(
      ([def]) => (def as Record<string, unknown>).normalized === 1,
    );
    expect(hasIndex).toBe(true);
  });
});
