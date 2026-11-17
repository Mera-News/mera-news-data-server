import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkDocument,
} from '@mera/models/models/cluster-article-link.model';

@Injectable()
export class TitleSelectorService {
  constructor(
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(ClusterArticleLink.name)
    private clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
  ) {}

  /**
   * Select an English-canonical title and description for a cluster.
   *
   * Policy (applied once, title and description projected from the same chosen article):
   * 1. An article whose original_language_code starts with "en" — use its title/description
   * 2. Any article with a translated English copy — use title_en_internal_only/description_en_internal_only
   * 3. First article — use its title/description (last-resort non-English fallback)
   */
  async selectEnglishTitleAndDescription(
    clusterId: string,
  ): Promise<{ title_en: string; description_en: string }> {
    const clusterArticleLinks = await this.clusterArticleLinkModel
      .find({ clusterId: new Types.ObjectId(clusterId) })
      .select('articleId')
      .lean()
      .exec();

    if (clusterArticleLinks.length === 0) {
      return { title_en: '', description_en: '' };
    }

    const articleIds = clusterArticleLinks.map(
      (l) => new Types.ObjectId(l.articleId.toString()),
    );

    const articles = await this.newsArticleModel
      .find({ _id: { $in: articleIds } })
      .select(
        'title title_en_internal_only description description_en_internal_only original_language_code',
      )
      .lean()
      .exec();

    if (articles.length === 0) {
      return { title_en: '', description_en: '' };
    }

    const englishOriginal = articles.find((a) =>
      a.original_language_code?.toLowerCase().startsWith('en'),
    );
    if (englishOriginal) {
      return {
        title_en: englishOriginal.title ?? '',
        description_en: englishOriginal.description ?? '',
      };
    }

    const translated = articles.find(
      (a) => a.title_en_internal_only || a.description_en_internal_only,
    );
    if (translated) {
      return {
        title_en: translated.title_en_internal_only ?? translated.title ?? '',
        description_en:
          translated.description_en_internal_only ??
          translated.description ??
          '',
      };
    }

    const first = articles[0];
    return {
      title_en: first.title ?? '',
      description_en: first.description ?? '',
    };
  }
}
