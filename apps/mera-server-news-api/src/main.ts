import * as dotenv from 'dotenv';
dotenv.config({ path: 'apps/mera-server-news-api/.env' });

import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Internal news API bootstrap.
 *
 * Two deliberate differences from the app-facing service:
 *
 *  - NO CORS. Nothing browser-based calls this; the only client is another
 *    Cloud Run service. Enabling CORS would advertise it to page scripts.
 *  - The API key is validated at BOOT, not merely per request. A deployment
 *    missing its credential otherwise starts healthy, passes its startup probe
 *    and then 401s every call — a failure that looks like the caller's fault.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  if (!configService.get<string>('MERA_NEWS_API_KEY')) {
    throw new Error(
      'MERA_NEWS_API_KEY is not set — refusing to start. This service has no ' +
        'other authentication, so booting without it would serve the news ' +
        'corpus unauthenticated.',
    );
  }

  app.use(helmet({ contentSecurityPolicy: isProduction }));

  const port =
    configService.get<number>('PORT') ??
    configService.get<number>('NEWS_API_PORT', 3002);

  await app.listen(port);
  logger.log(`Internal news API is running on port ${port}`);
}
void bootstrap();
