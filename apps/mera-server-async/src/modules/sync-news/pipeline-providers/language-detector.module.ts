import { Global, Module } from '@nestjs/common';
import { LANGUAGE_DETECTOR, type LanguageDetector } from '@mera/shared';
import { LanguageDetectionService } from '../../shared-utilities/language-detection/language-detection.service';
import { LanguageDetectionModule } from '../../shared-utilities/language-detection/language-detection.module';

/**
 * Binds the {@link LANGUAGE_DETECTOR} port to the existing CLD3-backed
 * {@link LanguageDetectionService}. The port lets the translate
 * processor depend on the interface, not the concrete CLD3 service. The CLD3
 * service itself is unchanged — this only adapts its `detectLanguage(text)`
 * method to the port's `detect(text)` shape.
 */
@Global()
@Module({
  imports: [LanguageDetectionModule],
  providers: [
    {
      provide: LANGUAGE_DETECTOR,
      useFactory: (svc: LanguageDetectionService): LanguageDetector => ({
        detect: (text: string) => svc.detectLanguage(text),
      }),
      inject: [LanguageDetectionService],
    },
  ],
  exports: [LANGUAGE_DETECTOR],
})
export class LanguageDetectorModule {}
