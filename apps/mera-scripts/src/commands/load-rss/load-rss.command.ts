import { Command, CommandRunner, Option } from 'nest-commander';
import { NewsFeedListOfCountriesService } from './news-feed-list-of-countries/news-feed-list-of-countries.service';

interface LoadRssCommandOptions {
  syncDelete?: boolean;
  only?: string[];
  file?: string;
}

@Command({
  name: 'load-rss',
  description: 'Load RSS feeds from JSON file into MongoDB',
})
export class LoadRssCommand extends CommandRunner {
  constructor(
    private readonly newsFeedListOfCountriesService: NewsFeedListOfCountriesService,
  ) {
    super();
  }

  @Option({
    flags: '--sync-delete',
    description:
      'Delete publication-source rows (type rss-feed only) absent from the seed JSON, and any news-publisher left with zero sources. Without this flag, load-rss only logs what would be deleted.',
  })
  parseSyncDelete(): boolean {
    return true;
  }

  @Option({
    flags: '--only <selector>',
    description:
      'Upsert only the feeds this selector matches (repeat for several): a feed URL, country:<ALPHA3>, language:<code> (en also matches en-GB) or all. Skips the delete-sync and refuses --sync-delete.',
  })
  parseOnly(selector: string, previous: string[] = []): string[] {
    return [...previous, selector];
  }

  @Option({
    flags: '--file <path>',
    description:
      'Read the feed list from this JSON file, relative to the current directory. Defaults to the bundled list.',
  })
  parseFile(path: string): string {
    return path;
  }

  async run(_args: string[], options?: LoadRssCommandOptions): Promise<void> {
    await this.newsFeedListOfCountriesService.loadFeeds({
      syncDelete: options?.syncDelete ?? false,
      only: options?.only,
      file: options?.file,
    });
  }
}
