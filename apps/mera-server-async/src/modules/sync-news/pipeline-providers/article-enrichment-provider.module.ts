import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ARTICLE_ENRICHMENT_PROVIDER } from '@mera/shared';
import {
  buildArticleEnrichmentProvider,
  placeRowsLoader,
} from '@mera/shared/enrichment/build-enrichment-provider';
import {
  Place,
  PlaceDocument,
  PlaceSchema,
} from '@mera/models/models/place.model';

/**
 * Composition root for the pipeline ArticleEnrichmentProvider.
 * `ARTICLE_ENRICHMENT_PROVIDER=gemini` (default) binds the Gemini adapter,
 * `openrouter` the OpenAI-compatible LLM adapter, `fake` the offline
 * deterministic provider for local CLI/tests. The switch itself lives in
 * `buildArticleEnrichmentProvider`, shared with the backfill command.
 *
 * The openrouter adapter canonicalises places against the `places`
 * collection. The model is injected here but the collection is read LAZILY,
 * on the first enrichment batch, so booting the async app never reads it and
 * no other app ever does.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Place.name, schema: PlaceSchema }]),
  ],
  providers: [
    {
      provide: ARTICLE_ENRICHMENT_PROVIDER,
      useFactory: (config: ConfigService, placeModel: Model<PlaceDocument>) =>
        buildArticleEnrichmentProvider({
          config,
          job: 'pre-process-articles',
          loadPlaces: placeRowsLoader(placeModel, config),
        }),
      inject: [ConfigService, getModelToken(Place.name)],
    },
  ],
  exports: [ARTICLE_ENRICHMENT_PROVIDER],
})
export class ArticleEnrichmentProviderModule {}
