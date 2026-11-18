import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import {
  TopicClusterLink,
  TopicClusterLinkDocument,
} from '@mera/models/models/topic-cluster-link.model';
import {
  TopicArticleLink,
  TopicArticleLinkDocument,
} from '@mera/models/models/topic-article-link.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkDocument,
} from '@mera/models/models/cluster-article-link.model';
import { ArticleSearchService } from '../../shared-utilities/article-search/article-search.service';
import {
  TOPIC_LINKING_LIMIT,
  TOPIC_LINKING_NUM_CANDIDATES,
} from '../../../constants';

export interface LinkTopicToClusterResult {
  success: boolean;
  topicId: string;
  topicText: string;
  articlesLinked: number;
  clustersLinked: number;
  processedAt: string;
}

@Injectable()
export class LinkTopicToClusterService {
  private readonly logger = new Logger(LinkTopicToClusterService.name);

  constructor(
    @InjectModel(UserTopic.name)
    private readonly userTopicModel: Model<UserTopicDocument>,
    @InjectModel(TopicClusterLink.name)
    private readonly topicClusterLinkModel: Model<TopicClusterLinkDocument>,
    @InjectModel(TopicArticleLink.name)
    private readonly topicArticleLinkModel: Model<TopicArticleLinkDocument>,
    @InjectModel(ClusterArticleLink.name)
    private readonly clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
    private readonly articleSearchService: ArticleSearchService,
  ) {}

  async linkTopicToClusters(
    topicId: string,
  ): Promise<LinkTopicToClusterResult> {
    const topicObjectId = new Types.ObjectId(topicId);

    // Fetch the topic document
    const topic = await this.userTopicModel.findById(topicObjectId).exec();

    if (!topic) {
      this.logger.warn(`Topic ${topicId} not found, may have been deleted`);
      return {
        success: true,
        topicId,
        topicText: 'DELETED',
        articlesLinked: 0,
        clustersLinked: 0,
        processedAt: new Date().toISOString(),
      };
    }

    try {
      // Vector search: find articles semantically similar to this topic
      const searchResults =
        await this.articleSearchService.searchArticlesForTopic(
          topic.news_topic_embed,
          {
            vectorSearchLimit: TOPIC_LINKING_LIMIT,
            vectorSearchNumCandidates: TOPIC_LINKING_NUM_CANDIDATES,
          },
        );

      if (searchResults.length === 0) {
        return {
          success: true,
          topicId,
          topicText: topic.news_topic_text,
          articlesLinked: 0,
          clustersLinked: 0,
          processedAt: new Date().toISOString(),
        };
      }

      // Build articleId -> score map from search results
      const articleScoreMap = new Map<string, number>();
      for (const r of searchResults) {
        articleScoreMap.set(r.articleId, r.score);
      }

      // Extract unique article IDs
      const articleIds = searchResults.map(
        (r) => new Types.ObjectId(r.articleId),
      );

      // Create TopicArticleLink documents via bulkWrite (upsert for idempotency)
      if (articleIds.length > 0) {
        const articleLinkOps = articleIds.map((articleId) => ({
          updateOne: {
            filter: { topicId: topicObjectId, articleId },
            update: {
              $setOnInsert: {
                topicId: topicObjectId,
                articleId,
                confidence: articleScoreMap.get(articleId.toString()) ?? 0,
              },
            },
            upsert: true,
          },
        }));
        await this.topicArticleLinkModel.bulkWrite(articleLinkOps);
      }

      // Get clusters that contain these articles via ClusterArticleLink
      const clusterArticleLinks = await this.clusterArticleLinkModel
        .find({ articleId: { $in: articleIds } })
        .select('clusterId articleId')
        .lean()
        .exec();

      // Compute per-cluster max confidence from article scores
      const clusterIds: Types.ObjectId[] = [];
      const clusterMaxScores = new Map<string, number>();
      for (const link of clusterArticleLinks) {
        const clusterId = link.clusterId.toString();
        const score = articleScoreMap.get(link.articleId.toString());

        if (!clusterMaxScores.has(clusterId)) {
          clusterIds.push(new Types.ObjectId(clusterId));
          clusterMaxScores.set(clusterId, 0);
        }

        if (
          score !== undefined &&
          score > (clusterMaxScores.get(clusterId) ?? 0)
        ) {
          clusterMaxScores.set(clusterId, score);
        }
      }

      // Create TopicClusterLink documents via bulkWrite (upsert for idempotency)
      if (clusterIds.length > 0) {
        const clusterLinkOps = clusterIds.map((clusterId) => ({
          updateOne: {
            filter: { topicId: topicObjectId, clusterId },
            update: {
              $setOnInsert: {
                topicId: topicObjectId,
                clusterId,
                confidence: clusterMaxScores.get(clusterId.toString()) ?? 0,
              },
            },
            upsert: true,
          },
        }));
        await this.topicClusterLinkModel.bulkWrite(clusterLinkOps);
      }

      this.logger.debug(
        `Topic ${topicId}: linked ${articleIds.length} articles → ${clusterIds.length} clusters`,
      );

      return {
        success: true,
        topicId,
        topicText: topic.news_topic_text,
        articlesLinked: articleIds.length,
        clustersLinked: clusterIds.length,
        processedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to link topic ${topicId}: ${errorMessage}`);
      throw error;
    }
  }
}
