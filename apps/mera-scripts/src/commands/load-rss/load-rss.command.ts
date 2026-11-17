import { Command, CommandRunner, Option } from 'nest-commander';
import { NewsFeedListOfCountriesService } from './news-feed-list-of-countries/news-feed-list-of-countries.service';

interface LoadRssCommandOptions {
  syncDelete?: boolean;
  only?: string[];
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
    flags: '--only <feedUrl>',
    description:
      'Upsert only this feed URL from the seed JSON (repeat for several). Skips the delete-sync and refuses --sync-delete.',
  })
  parseOnly(feedUrl: string, previous: string[] = []): string[] {
    return [...previous, feedUrl];
  }

  async run(_args: string[], options?: LoadRssCommandOptions): Promise<void> {
    await this.newsFeedListOfCountriesService.loadFeeds(
      options?.syncDelete ?? false,
      options?.only,
    );
  }
}
