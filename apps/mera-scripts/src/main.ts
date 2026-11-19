import * as dotenv from 'dotenv';
dotenv.config({ path: 'apps/mera-scripts/.env' });

import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';
import { SelfhostCheckModule } from './commands/selfhost-check/selfhost-check.module';

async function bootstrap() {
  const root =
    process.argv[2] === 'selfhost:check' ? SelfhostCheckModule : AppModule;
  await CommandFactory.run(root, {
    // The check's own lines are the output; Nest's start-up lines would bury them.
    logger: root === AppModule ? ['error', 'warn', 'log'] : ['error', 'warn'],
    // A failed command must exit non-zero, so a script or scheduler sees it.
    serviceErrorHandler: (err) => {
      console.error(err);
      process.exit(1);
    },
  });
}

void bootstrap();
