import { buildEnrichmentUpdate } from './enrichment-write';

describe('buildEnrichmentUpdate', () => {
  it('is exactly the pre-v2 update for a Gemini-shaped result', () => {
    expect(
      buildEnrichmentUpdate({
        geo_tags: [{ countryCode: 'IN', city: 'mumbai' }],
        entities: ['BMC'],
        event_type: 'disaster',
      }),
    ).toEqual({
      $set: {
        geo_tags: [{ countryCode: 'IN', city: 'mumbai' }],
        entities: ['BMC'],
        event_type: 'disaster',
        tags_status: 'TAGGING_SUCCESSFUL',
      },
      $unset: { tagsError: '' },
    });
  });

  it('writes every v2 field that is present', () => {
    const { $set } = buildEnrichmentUpdate({
      geo_tags: [{ countryCode: 'UA', city: 'kyiv', geonameId: 703448 }],
      entities: [],
      event_type: 'conflict',
      content_category: '/News/Politics',
      content_categories: ['/News/Politics'],
      geo_scope: 'city',
      genre: 'news',
      tone: 'distressing',
      significance: 5,
    });
    expect($set).toMatchObject({
      content_category: '/News/Politics',
      content_categories: ['/News/Politics'],
      geo_scope: 'city',
      genre: 'news',
      tone: 'distressing',
      significance: 5,
    });
  });

  it('never writes an undefined key (no driver-dependent nulls)', () => {
    const { $set } = buildEnrichmentUpdate({
      geo_tags: [],
      entities: [],
      event_type: 'other',
      content_categories: [],
    });
    expect(Object.keys($set).sort()).toEqual(
      [
        'content_categories',
        'entities',
        'event_type',
        'geo_tags',
        'tags_status',
      ].sort(),
    );
  });
});
