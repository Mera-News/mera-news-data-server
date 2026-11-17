import { EVENT_TYPES } from './gemini-enrichment.service';
import {
  ArticleEnrichment,
  EnrichmentInput,
  EnrichmentOutput,
  ArticleEnrichmentProvider,
} from './article-enrichment-provider.port';

/** Small deterministic country/city pool so fake output looks plausible offline. */
const FAKE_PLACES = [
  { city: 'mumbai', region: 'maharashtra', countryCode: 'IN' },
  { city: 'amsterdam', region: 'noord-holland', countryCode: 'NL' },
  { city: 'london', region: 'england', countryCode: 'GB' },
  { city: 'new york', region: 'new york', countryCode: 'US' },
  { city: 'munich', region: 'bavaria', countryCode: 'DE' },
] as const;

/** djb2 string hash → non-negative int, so tags are stable across runs. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

/**
 * Offline deterministic {@link ArticleEnrichmentProvider} bound via `ARTICLE_ENRICHMENT_PROVIDER=fake`
 * for local CLI verification and unit tests (no real Gemini credits). Tags are a
 * pure function of the input id, so pipeline specs are reproducible offline.
 */
export class FakeEnrichmentProvider implements ArticleEnrichmentProvider {
  enrichBatch(items: EnrichmentInput[]): Promise<EnrichmentOutput[]> {
    return Promise.resolve(
      items.map((i) => ({ id: i.id, ...this.tagsFor(i.id) })),
    );
  }

  private tagsFor(id: string): ArticleEnrichment {
    const h = hash(id);
    const place = FAKE_PLACES[h % FAKE_PLACES.length];
    const eventType = EVENT_TYPES[h % EVENT_TYPES.length];
    return {
      geo_tags: [{ ...place }],
      entities: [`Entity-${h % 1000}`],
      event_type: eventType,
    };
  }
}
