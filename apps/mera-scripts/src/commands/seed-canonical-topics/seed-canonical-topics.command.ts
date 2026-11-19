import { Command, CommandRunner, Option } from 'nest-commander';
import { SeedCanonicalTopicsService } from './seed-canonical-topics.service';

/**
 * `seed-canonical-topics`: upserts the first-level canonical category rows and
 * links recent articles to them. Dry run by default; `--execute` writes.
 * `--allow-db` must name the database `MONGODB_URI` points at, so a command
 * pointed at the wrong database refuses before it reads or writes anything.
 */
@Command({
  name: 'seed-canonical-topics',
  description:
    'Seed the canonical topic rows and link recent articles to them (dry run by default; --execute to write)',
})
export class SeedCanonicalTopicsCommand extends CommandRunner {
  constructor(private readonly service: SeedCanonicalTopicsService) {
    super();
  }

  @Option({ flags: '--execute', description: 'Write (default is a dry run)' })
  parseExecute(): boolean {
    return true;
  }

  @Option({
    flags: '--allow-db <name>',
    description:
      'The database MONGODB_URI points at (required; the command refuses any other)',
  })
  parseAllowDb(val: string): string {
    return val;
  }

  @Option({
    flags: '--backfill-window-hours <number>',
    description: 'Link articles from this many hours back (default 48)',
  })
  parseWindow(val: string): number {
    const n = parseInt(val, 10);
    if (isNaN(n) || n <= 0)
      throw new Error(`Invalid --backfill-window-hours value: ${val}`);
    return n;
  }

  async run(
    _args: string[],
    options?: {
      execute?: boolean;
      allowDb?: string;
      backfillWindowHours?: number;
    },
  ): Promise<void> {
    await this.service.run(options);
  }
}
