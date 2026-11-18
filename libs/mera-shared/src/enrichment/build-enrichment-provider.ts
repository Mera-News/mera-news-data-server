import type { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { assertFakeAllowed, readChoice } from '../config/env-choice';
import { JobLogger } from '../job-logger/job-logger';
import type { ArticleEnrichmentProvider } from './article-enrichment-provider.port';
import { FakeEnrichmentProvider } from './fake-enrichment.provider';
import { GeminiEnrichmentService } from './gemini-enrichment.service';
import { OpenRouterEnrichmentService } from './openrouter-enrichment.service';
import { LazyPlaceGazetteer, type PlaceRow } from './place-gazetteer';

/**
 * The one provider switch (`ARTICLE_ENRICHMENT_PROVIDER=gemini|openrouter|fake`,
 * default gemini), shared by the async worker's composition root and the
 * backfill command so the two can never bind different adapters for the same
 * env. Any other value fails at boot.
 */
export function buildArticleEnrichmentProvider(opts: {
  config: ConfigService;
  job: string;
  /** Only called by the openrouter adapter, lazily, on its first batch. */
  loadPlaces: () => Promise<PlaceRow[]>;
}): ArticleEnrichmentProvider {
  const { config } = opts;
  const kind = readChoice(
    config,
    'ARTICLE_ENRICHMENT_PROVIDER',
    ['gemini', 'openrouter', 'fake'],
    'gemini',
  );
  if (kind === 'fake') {
    assertFakeAllowed(config, 'ARTICLE_ENRICHMENT_PROVIDER');
    return new FakeEnrichmentProvider();
  }
  const logger = new JobLogger({
    job: opts.job,
    level: JobLogger.parseLevel(config.get<string>('LOG_LEVEL')),
  });
  if (kind === 'openrouter') {
    return new OpenRouterEnrichmentService(
      config,
      logger,
      new LazyPlaceGazetteer(opts.loadPlaces),
    );
  }
  return new GeminiEnrichmentService(config, logger);
}

/**
 * Loader for the gazetteer: the minimal `places` projection, cities at or
 * above `ENRICHMENT_PLACES_MIN_POPULATION` (default 15000, the cities15000
 * cut). Nothing runs until the returned function is called.
 */
export function placeRowsLoader(
  placeModel: Model<any>,
  config: ConfigService,
): () => Promise<PlaceRow[]> {
  return async () => {
    const raw = config.get<string | number>('ENRICHMENT_PLACES_MIN_POPULATION');
    const n = Number(raw);
    const minPopulation =
      raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0
        ? n
        : 15000;
    return placeModel
      .find(
        { population: { $gte: minPopulation } },
        {
          _id: 0,
          city: 1,
          normalized: 1,
          region: 1,
          countryCode: 1,
          population: 1,
          geonameId: 1,
          alt_names: 1,
        },
      )
      .lean<PlaceRow[]>()
      .exec();
  };
}
