import { Module } from '@nestjs/common';
import { LoadRssCommand } from './load-rss.command';
import { NewsFeedListOfCountriesModule } from './news-feed-list-of-countries/news-feed-list-of-countries.module';

@Module({
  imports: [NewsFeedListOfCountriesModule],
  providers: [LoadRssCommand],
})
export class LoadRssModule {}
