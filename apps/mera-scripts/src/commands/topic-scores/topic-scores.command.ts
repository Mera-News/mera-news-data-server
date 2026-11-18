import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Command, CommandRunner } from 'nest-commander';
import type { Model } from 'mongoose';
import { EMBEDDING_PROVIDER } from '@mera/news-core/embedding-provider/embedding-provider.port';
import type { EmbeddingProvider } from '@mera/news-core/embedding-provider/embedding-provider.port';
import { topicEmbedText } from '@mera/news-core/embedding-provider/topic-embed-text';
import { vectorMinScore } from '@mera/shared/embedding-provider/embedding-config';
import { NewsArticle } from '@mera/models/models/news-article.model';

const TOP = 10;
const NUM_CANDIDATES = 200;
const CUTOFF_HOURS = 24;

@Command({
  name: 'topic-scores',
  arguments: '<topic...>',
  description:
    'Print the best vector-search scores of each topic over the last 24 hours, to help pick VECTOR_MIN_SCORE. Writes nothing.',
})
export class TopicScoresCommand extends CommandRunner {
  constructor(
    @InjectModel(NewsArticle.name)
    private readonly articles: Model<NewsArticle>,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async run(topics: string[]): Promise<void> {
    const floor = vectorMinScore(this.config);
    const cutoff = new Date(Date.now() - CUTOFF_HOURS * 60 * 60 * 1000);
    for (const topic of topics) {
      const [queryVector] = await this.embedder.embed([topicEmbedText(topic)]);
      // Its own query, not the retrieval service: that service caches answers
      // and stores the topic, and this command must write nothing.
      const found = await this.articles
        .aggregate<{ score: number }>([
          {
            $vectorSearch: {
              index: 'embedding_article_data_retrieval_index',
              path: 'embedding_article_data_retrieval',
              queryVector,
              numCandidates: NUM_CANDIDATES,
              limit: TOP,
              // The retrieval path's window, inside the search so the top 10
              // are in-window articles.
              filter: { createdAt: { $gte: cutoff } },
            },
          },
          { $addFields: { score: { $meta: 'vectorSearchScore' } } },
          { $project: { _id: 0, score: 1 } },
        ])
        .exec();
      const scores = found.map((r) => r.score);
      const atFloor = scores.filter((s) => s >= floor).length;
      console.log(
        `"${topic}": top scores ${scores.map((s) => s.toFixed(3)).join(' ') || 'none'} ; ${atFloor} of ${TOP} at or above VECTOR_MIN_SCORE ${floor}`,
      );
    }
    console.log(
      'Pick VECTOR_MIN_SCORE between the scores of a topic you follow and a topic that should match nothing.',
    );
  }
}
