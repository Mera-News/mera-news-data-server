import * as dotenv from 'dotenv';
dotenv.config({ path: 'apps/mera-scripts/.env' });

import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

async function bootstrap() {
  await CommandFactory.run(AppModule, {
    logger: ['error', 'warn', 'log'],
    // A failed command must exit non-zero, so a script or scheduler sees it.
    serviceErrorHandler: (err) => {
      console.error(err);
      process.exit(1);
    },
  });
}

void bootstrap();
