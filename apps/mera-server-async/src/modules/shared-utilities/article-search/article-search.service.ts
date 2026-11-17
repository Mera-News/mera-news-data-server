import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  VECTOR_SEARCH_DATA_RETRIEVAL_MIN_SCORE,
  VECTOR_SEARCH_DATA_RETRIEVAL_RESULT_LIMIT,
  VECTOR_SEARCH_DATA_RETRIEVAL_NUM_CANDIDATES,
} from '../../../constants';
import { Model } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';

export interface ArticleSearchResult {
  articleId: string;
  score: number;
}

export interface SearchConfig {
  vectorSearchLimit?: number;
  vectorSearchNumCandidates?: number;
}

@Injectable()
export class ArticleSearchService {
  private readonly logger = new Logger(ArticleSearchService.name);

  constructor(
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
  ) {}

  /**
   * Vector search on embedding_article_data_retrieval using cosine similarity.
   * Used for topic-to-article linking in the personalization pipeline.
   *
   * Requires MongoDB Atlas vector index: embedding_article_data_retrieval_index
   */
  async searchArticlesForTopic(
    topicEmbedding: number[],
    config: SearchConfig = {},
  ): Promise<ArticleSearchResult[]> {
    const {
      vectorSearchLimit = VECTOR_SEARCH_DATA_RETRIEVAL_RESULT_LIMIT,
      vectorSearchNumCandidates = VECTOR_SEARCH_DATA_RETRIEVAL_NUM_CANDIDATES,
    } = config;

    // Processing window: match only articles from the last 24h even though
    // the model TTL retains them for 48h. The 2nd day is a read buffer for
    // user access, not a reprocessing window — linking topics to 25-48h-old
    // articles would surface stale news in personalized suggestions.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      const pipeline: any[] = [
        {
          $vectorSearch: {
            index: 'embedding_article_data_retrieval_index',
            path: 'embedding_article_data_retrieval',
            queryVector: topicEmbedding,
            numCandidates: vectorSearchNumCandidates,
            limit: vectorSearchLimit,
            // Push the recency window into the ANN search itself (the index
            // declares `createdAt` as a filter field). This stops candidates
            // being "spent" on 25-48h-old articles that a post-$match would
            // then discard.
            filter: { createdAt: { $gte: twentyFourHoursAgo } },
          },
        },
        {
          $addFields: {
            score: { $meta: 'vectorSearchScore' },
          },
        },
        {
          $match: {
            score: { $gte: VECTOR_SEARCH_DATA_RETRIEVAL_MIN_SCORE },
          },
        },
        { $limit: vectorSearchLimit },
        // Only what callers use; $$ROOT would drag both 768-dim embeddings back.
        { $project: { _id: 1, score: 1 } },
      ];

      const results = await this.newsArticleModel.aggregate(pipeline).exec();

      return results.map((r: Record<string, unknown>) => ({
        articleId: (r._id as string).toString(),
        score: r.score as number,
      }));
    } catch (error) {
      this.logger.error(
        `Vector search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
