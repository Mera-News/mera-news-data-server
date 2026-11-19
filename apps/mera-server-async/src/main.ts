import * as dotenv from 'dotenv';
dotenv.config({ path: 'apps/mera-server-async/.env' });

import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { HttpExceptionFilter } from '@mera/shared';
import { readText } from '@mera/shared/config/env-choice';
import { MeraServerAsyncModule } from './async.module';

async function bootstrap() {
  const app = await NestFactory.create(MeraServerAsyncModule, {
    bufferLogs: true,
  });

  // Use Pino logger for all NestJS logging
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Enable graceful shutdown hooks (onModuleDestroy, beforeApplicationShutdown)
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  // Security headers (internal service — still good practice)
  app.use(helmet());

  // Validate incoming DTOs (e.g. /invoke endpoint)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Global exception filter strips stack traces in production
  app.useGlobalFilters(new HttpExceptionFilter(isProduction));

  // Log uncaught exceptions and exit — leaving the process running after an
  // uncaught exception risks undefined state. The orchestrator (Cloud Run/GKE)
  // will restart the process.
  process.on('uncaughtException', (error: Error) => {
    logger.error(
      { err: error, context: 'UncaughtException' },
      'Uncaught Exception - process will terminate',
    );
    // Allow time for log flush before exiting
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      { err: reason, context: 'UnhandledRejection' },
      'Unhandled Promise Rejection',
    );
  });

  process.on('SIGTERM', () => {
    logger.warn('SIGTERM received — starting graceful shutdown');
  });

  const port =
    configService.get<number>('PORT') ??
    configService.get<number>('ASYNC_PORT', 8080);

  // Unset listens on every address; 127.0.0.1 keeps /invoke on the machine.
  const host = readText(configService, 'ASYNC_HOST');
  await (host ? app.listen(port, host) : app.listen(port));
  logger.log(`Async service is running on port ${port}`);
}

void bootstrap();
