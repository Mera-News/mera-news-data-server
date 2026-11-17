import { Module } from '@nestjs/common';
import {
  HTTPS_PROBE_FETCH,
  ProbeFetch,
  UrlSecurityProbeService,
} from './url-security-probe.service';

/**
 * Binds the real network fetch behind the `HTTPS_PROBE_FETCH` token so the
 * probe's only I/O is injectable and tests can stub it without touching globals.
 * `CACHE_MANAGER` comes from the globally-registered CacheModule.
 */
@Module({
  providers: [
    {
      provide: HTTPS_PROBE_FETCH,
      useValue: globalThis.fetch.bind(globalThis) as unknown as ProbeFetch,
    },
    UrlSecurityProbeService,
  ],
  exports: [UrlSecurityProbeService],
})
export class UrlSecurityModule {}
