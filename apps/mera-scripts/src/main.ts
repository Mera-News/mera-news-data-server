import * as dotenv from 'dotenv';
dotenv.config({ path: 'apps/mera-scripts/.env' });

import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';

async function bootstrap() {
  await CommandFactory.run(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
}

void bootstrap();
