import { Module } from '@nestjs/common';
import type { Readable } from 'stream';
import { AxiosService } from '../axios/axios.service';
import {
  HTTPS_PROBE_FETCH,
  ProbeFetch,
  UrlSecurityProbeService,
} from './url-security-probe.service';

/** Largest body the probe will read; it only wants the status and final address. */
const PROBE_MAX_BYTES = 65536;

/**
 * Binds the probe's network fetch behind the `HTTPS_PROBE_FETCH` token, over
 * the guarded direct instance: a published article link must not be able to
 * aim the probe at a private address. Tests inject a stub in its place.
 * `CACHE_MANAGER` comes from the globally-registered CacheModule.
 */
@Module({
  providers: [
    {
      provide: HTTPS_PROBE_FETCH,
      useFactory:
        (axiosService: AxiosService): ProbeFetch =>
        async (url, init) => {
          const response = await axiosService.callWithoutProxy<Readable>({
            url,
            method: init.method,
            headers: init.headers,
            signal: init.signal,
            responseType: 'stream',
            validateStatus: () => true,
            maxContentLength: PROBE_MAX_BYTES,
          });
          try {
            return {
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              // follow-redirects' address after the last hop.
              url:
                (response.request as { res?: { responseUrl?: string } })?.res
                  ?.responseUrl ?? url,
            };
          } finally {
            // maxContentLength is not enforced on a stream, so the body is
            // dropped here rather than read.
            response.data.destroy();
          }
        },
      inject: [AxiosService],
    },
    UrlSecurityProbeService,
  ],
  exports: [UrlSecurityProbeService],
})
export class UrlSecurityModule {}
