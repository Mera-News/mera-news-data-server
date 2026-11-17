import 'reflect-metadata';
import mongoose from 'mongoose';
import { NewsArticleSchema } from '@mera/models/models/news-article.model';

/**
 * The enrichment write goes through a STRICT bulkWrite, so any field (or
 * geo_tags subfield) the schema does not declare is dropped silently. These
 * assertions pin every enrichment field the pre-process worker writes.
 */
describe('NewsArticle schema: enrichment fields', () => {
  const Model = mongoose.model(
    'NewsArticleEnrichmentSchemaSpec',
    NewsArticleSchema,
  );

  afterAll(() => {
    mongoose.deleteModel('NewsArticleEnrichmentSchemaSpec');
  });

  it('keeps geo_tags[].geonameId through a cast', () => {
    const doc = new Model({
      geo_tags: [
        {
          city: 'porto',
          region: 'porto',
          countryCode: 'PT',
          geonameId: 2735943,
        },
        { countryCode: 'EU' },
      ],
    });
    const tags = doc.toObject().geo_tags as {
      geonameId?: number;
      countryCode: string;
    }[];
    expect(tags[0].geonameId).toBe(2735943);
    expect(tags[1].geonameId).toBeUndefined();
  });

  it('declares every enrichment v2 path', () => {
    for (const p of [
      'geo_scope',
      'content_categories',
      'genre',
      'tone',
      'significance',
    ]) {
      expect(NewsArticleSchema.path(p)).toBeDefined();
    }
    expect(NewsArticleSchema.path('significance').instance).toBe('Number');
    expect(NewsArticleSchema.path('content_categories').instance).toBe('Array');
  });

  it('casts the v2 scalars and the category array', () => {
    const doc = new Model({
      geo_scope: 'city',
      content_categories: ['/Sports/Team Sports/Soccer'],
      genre: 'news',
      tone: 'neutral',
      significance: 3,
    }).toObject();
    expect(doc).toMatchObject({
      geo_scope: 'city',
      content_categories: ['/Sports/Team Sports/Soccer'],
      genre: 'news',
      tone: 'neutral',
      significance: 3,
    });
  });
});
