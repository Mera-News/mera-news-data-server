import { Module } from '@nestjs/common';
import { EmbeddingProviderModule } from '@mera/news-core';
import { ModelsNewsModule } from '@mera/models/models/models-news.module';
import { TopicScoresCommand } from './topic-scores.command';

@Module({
  imports: [ModelsNewsModule, EmbeddingProviderModule],
  providers: [TopicScoresCommand],
})
export class TopicScoresModule {}
