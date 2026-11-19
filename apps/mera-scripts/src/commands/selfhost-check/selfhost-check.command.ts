import { ConfigService } from '@nestjs/config';
import { Command, CommandRunner } from 'nest-commander';
import { formatLines, hasProblems, runChecks } from './selfhost-check';

@Command({
  name: 'selfhost:check',
  description:
    'Check your setup before you start the services: settings, keys, MongoDB, search indexes, embedding model and Redis. Changes nothing.',
})
export class SelfhostCheckCommand extends CommandRunner {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async run(): Promise<void> {
    const lines = await runChecks(this.config);
    for (const line of formatLines(lines)) console.log(line);
    if (hasProblems(lines)) process.exitCode = 1;
  }
}
