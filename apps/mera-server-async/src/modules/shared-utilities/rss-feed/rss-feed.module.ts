import { Module } from '@nestjs/common';
import { RSSFeedService } from './rss-feed.service';
import {
  SOURCE_CONNECTOR,
  type SourceConnector,
} from '../source-connector/source-connector.port';

@Module({
  providers: [
    RSSFeedService,
    {
      provide: SOURCE_CONNECTOR,
      useFactory: (rss: RSSFeedService): SourceConnector => ({
        fetchSource: (s) => rss.fetchRSSFeed(s),
      }),
      inject: [RSSFeedService],
    },
  ],
  exports: [RSSFeedService, SOURCE_CONNECTOR],
})
export class RSSFeedModule {}
