import { Module } from '@nestjs/common';
import { RSSFeedService } from './rss-feed.service';

@Module({
  providers: [RSSFeedService],
  exports: [RSSFeedService],
})
export class RSSFeedModule {}
