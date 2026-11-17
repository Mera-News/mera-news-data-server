import 'reflect-metadata';
import mongoose from 'mongoose';
import { NewsArticleSchema } from './news-article.model';

/**
 * Story-dedup fields. `story_key` must be a real String path (a bson
 * `Types.ObjectId` type makes a Mixed path, and the projector's pipeline write
 * is never cast), and none of the three may carry an index: autoIndex would
 * build it on deploy over the largest collection.
 */
describe('NewsArticle story-dedup fields', () => {
  it('declares story_key as a String path', () => {
    expect(NewsArticleSchema.path('story_key').instance).toBe('String');
  });

  it('declares copy_keys as an array of strings with no default', () => {
    const p = NewsArticleSchema.path('copy_keys');
    expect(p.instance).toBe('Array');
    expect(
      (p as unknown as { embeddedSchemaType: { instance: string } })
        .embeddedSchemaType.instance,
    ).toBe('String');
    const Model = mongoose.model(
      'NewsArticleStoryDedupSpec',
      NewsArticleSchema,
    );
    expect(new Model({}).copy_keys).toBeUndefined();
  });

  it('declares vector_sidecar_tm_packed as a Buffer hidden from ordinary reads', () => {
    const p = NewsArticleSchema.path('vector_sidecar_tm_packed');
    expect(p.instance).toBe('Buffer');
    expect(
      (p as unknown as { options: { select: boolean } }).options.select,
    ).toBe(false);
  });

  it('indexes none of them', () => {
    const fields = ['story_key', 'copy_keys', 'vector_sidecar_tm_packed'];
    // Schema.indexes() includes path-level `index: true` entries too.
    for (const [spec] of NewsArticleSchema.indexes()) {
      for (const f of fields) expect(Object.keys(spec)).not.toContain(f);
    }
    for (const f of fields) {
      const opts = (
        NewsArticleSchema.path(f) as unknown as {
          options: Record<string, unknown>;
        }
      ).options;
      expect(opts.index).toBeUndefined();
      expect(opts.unique).toBeUndefined();
    }
  });
});
