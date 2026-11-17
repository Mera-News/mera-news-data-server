import { FakeEnrichmentProvider } from './fake-enrichment.provider';
import { EVENT_TYPES } from './gemini-enrichment.service';
import { type EnrichmentInput } from './article-enrichment-provider.port';

const items: EnrichmentInput[] = [
  { id: 'id-1', title_en: 'a', description_en: 'b' },
  { id: 'id-2', title_en: 'c', description_en: 'd' },
];

describe('FakeEnrichmentProvider', () => {
  it('returns exactly one aligned output per input id', async () => {
    const out = await new FakeEnrichmentProvider().enrichBatch(items);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.id)).toEqual(['id-1', 'id-2']);
  });

  it('produces well-formed, deterministic tags', async () => {
    const provider = new FakeEnrichmentProvider();
    const a = await provider.enrichBatch([items[0]]);
    const b = await provider.enrichBatch([items[0]]);
    expect(a).toEqual(b); // stable across calls
    expect(a[0].geo_tags[0].countryCode).toMatch(/^[A-Z]{2}$/);
    expect(a[0].entities.length).toBeGreaterThan(0);
    expect(EVENT_TYPES).toContain(
      a[0].event_type as (typeof EVENT_TYPES)[number],
    );
  });

  it('handles an empty batch', async () => {
    expect(await new FakeEnrichmentProvider().enrichBatch([])).toEqual([]);
  });
});
