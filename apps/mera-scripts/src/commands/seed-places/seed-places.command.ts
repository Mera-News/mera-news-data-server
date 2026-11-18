import { Command, CommandRunner, Option } from 'nest-commander';
import { SeedPlacesOptions, SeedPlacesService } from './seed-places.service';

/**
 * `seed-places`: upsert searchable places from a GeoNames `cities15000` file
 * (tab-separated). The data file is NOT bundled: pass it with `--file`. Optional
 * `--admin1-file` (GeoNames `admin1CodesASCII.txt`) maps admin1 codes to human
 * region names; without it, region = the raw admin1 code. Use `--dry-run` to
 * parse + count only, and `--limit` to cap rows processed.
 */
@Command({
  name: 'seed-places',
  description: 'Seed the `places` collection from a GeoNames cities file',
})
export class SeedPlacesCommand extends CommandRunner {
  constructor(private readonly service: SeedPlacesService) {
    super();
  }

  @Option({
    flags: '--file <path>',
    description:
      'Path to the GeoNames cities15000 tab-separated file (required). Download cities15000.zip from https://download.geonames.org/export/dump/',
  })
  parseFile(val: string): string {
    return val;
  }

  @Option({
    flags: '--admin1-file <path>',
    description:
      'Optional path to GeoNames admin1CodesASCII.txt for human region names',
  })
  parseAdmin1File(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Parse and count without writing anything',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--limit <number>',
    description: 'Cap the number of rows processed this run',
  })
  parseLimit(val: string): number {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid --limit value: ${val}`);
    }
    return parsed;
  }

  async run(
    _args: string[],
    options?: Partial<SeedPlacesOptions>,
  ): Promise<void> {
    if (!options?.file) {
      throw new Error('--file <path> is required (GeoNames cities15000 file)');
    }
    await this.service.run({
      file: options.file,
      admin1File: options.admin1File,
      dryRun: options.dryRun ?? false,
      limit: options.limit,
    });
  }
}
