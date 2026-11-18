import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertFakeAllowed, readChoice } from '@mera/shared/config/env-choice';
import {
  TRANSLATION_PROVIDER,
  GeminiTranslationService,
  FakeTranslationProvider,
  JobLogger,
  OpenRouterTranslationService,
  RoutingTranslationProvider,
  resolveRoutedTranslationConfig,
} from '@mera/shared';

/**
 * Composition root for the pipeline TranslationProvider. `TRANSLATION_PROVIDER`:
 *  - `gemini` (default when unset): the Gemini adapter;
 *  - `routed`: OpenRouter for `TRANSLATION_OPENROUTER_LANGS`, Gemini for the
 *    rest and as automatic fallback (rollback is setting `gemini` again);
 *  - `none`: no translation; articles stay in their own language;
 *  - `fake`: the offline pass-through for local CLI/tests, no credits spent.
 * Any other value fails at boot.
 *
 * The adapters log through a Kafka-free {@link JobLogger} (level from
 * `LOG_LEVEL`), job `translate-article`, so their event names key the
 * monitoring log filters.
 */
export function buildTranslationProvider(config: ConfigService) {
  const mode = readChoice(
    config,
    'TRANSLATION_PROVIDER',
    ['gemini', 'routed', 'none', 'fake'],
    'gemini',
  );
  if (mode === 'fake') {
    assertFakeAllowed(config, 'TRANSLATION_PROVIDER');
    return new FakeTranslationProvider();
  }
  // none: articles stay in their own language and are embedded as they are.
  if (mode === 'none') return new FakeTranslationProvider();
  const logger = new JobLogger({
    job: 'translate-article',
    level: JobLogger.parseLevel(config.get<string>('LOG_LEVEL')),
  });
  const gemini = new GeminiTranslationService(config, logger);
  if (mode !== 'routed') return gemini;
  const cfg = resolveRoutedTranslationConfig(config, logger);
  return new RoutingTranslationProvider(
    cfg,
    logger,
    new OpenRouterTranslationService(cfg, config, logger),
    gemini,
  );
}

@Global()
@Module({
  providers: [
    {
      provide: TRANSLATION_PROVIDER,
      useFactory: buildTranslationProvider,
      inject: [ConfigService],
    },
  ],
  exports: [TRANSLATION_PROVIDER],
})
export class TranslationProviderModule {}
