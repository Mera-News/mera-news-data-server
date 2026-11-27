import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  HeadlineEdition,
  HeadlineEditionDocument,
} from '@mera/models/models/headline-edition.model';
import {
  TopicArticleLink,
  TopicArticleLinkDocument,
} from '@mera/models/models/topic-article-link.model';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import { toHeadlineScopeKey } from '../headline-scope/headline-scope-key';
import {
  DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  editionProjectionForWindow,
  pickEditionEntries,
} from '../headline-scope/headline-window';
import { TopHeadlinesService } from '../top-headlines/top-headlines.service';
import { WorldHeadlinesResponse } from './world-headlines.dto';
import { orderEditionForLanguage } from './reading-rank';

// Same offset cursor as TopHeadlinesService (its codec is private there).
const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), 'utf-8').toString('base64');
function decodeCursor(cursor: string): number {
  try {
    const { offset } = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf-8'),
    ) as { offset?: unknown };
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0
      ? offset
      : 0;
  } catch {
    return 0;
  }
}

// Deliberately no Logger and no cache here: the topic filter must never reach a key or a log line.
@Injectable()
export class WorldHeadlinesService {
  constructor(
    @InjectModel(HeadlineEdition.name)
    private readonly editionModel: Model<HeadlineEditionDocument>,
    @InjectModel(TopicArticleLink.name)
    private readonly linkModel: Model<TopicArticleLinkDocument>,
    private readonly topHeadlines: TopHeadlinesService,
    @InjectModel(UserTopic.name)
    private readonly userTopicModel: Model<UserTopicDocument>,
  ) {}

  /** Every canonical row, read fresh: the seeded category tree, never user-derived. */
  private async canonicalRows(): Promise<{ id: string; path: string }[]> {
    const rows = await this.userTopicModel
      .find({ is_canonical: true })
      .select('canonical_path canonical_level')
      .lean()
      .exec();
    return rows
      .filter((r) => !!r.canonical_path)
      .map((r) => ({ id: r._id.toString(), path: r.canonical_path as string }));
  }

  async worldHeadlines(
    countryCode: string | null | undefined,
    first: number,
    after: string | undefined,
    windowHours: number = DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
    canonicalTopicIds: string[] = [],
    language: string | null = null,
  ): Promise<WorldHeadlinesResponse> {
    const edition = await this.editionModel
      .findOne({ scopeKey: toHeadlineScopeKey(countryCode) })
      .select(editionProjectionForWindow(windowHours))
      .lean()
      .exec();
    if (!edition) {
      // No edition yet: a filter has nothing to match; otherwise serve what
      // topHeadlinesForCountry serves (the live fallback, editionBuiltAt null).
      if (canonicalTopicIds.length > 0) {
        return {
          headlines: [],
          facets: [],
          editionBuiltAt: null,
          pageInfo: { endCursor: null, hasNextPage: false, pageSize: first },
          unavailableReason: 'NO_EDITION',
        };
      }
      const live = await this.topHeadlines.topHeadlinesForCountry(
        countryCode,
        first,
        after,
        windowHours,
      );
      return {
        headlines: live.headlines,
        pageInfo: live.pageInfo,
        editionBuiltAt: live.editionBuiltAt ?? null,
        facets: [],
        unavailableReason: null,
      };
    }

    const entries = pickEditionEntries(edition, windowHours);
    const topics = await this.canonicalRows();
    const byPath = new Map(topics.map((t) => [t.path, t.id]));
    const knownIds = new Set(topics.map((t) => t.id));

    // articleId -> the topics it is linked to, each plus its ancestors (so a parent rolls up its children).
    const topicsByArticle = new Map<string, Set<string>>();
    if (entries.length > 0 && topics.length > 0) {
      const pathById = new Map(topics.map((t) => [t.id, t.path]));
      const links = await this.linkModel
        .find({
          articleId: { $in: entries.map((e) => e.articleId) },
          topicId: { $in: topics.map((t) => new Types.ObjectId(t.id)) },
        })
        .select('articleId topicId')
        .lean()
        .exec();
      for (const link of links) {
        const path = pathById.get(link.topicId.toString());
        if (!path) continue;
        const set =
          topicsByArticle.get(link.articleId.toString()) ?? new Set<string>();
        const segments = path.split('/');
        for (let i = 2; i <= segments.length; i++) {
          const id = byPath.get(segments.slice(0, i).join('/'));
          if (id) set.add(id);
        }
        topicsByArticle.set(link.articleId.toString(), set);
      }
    }

    const counts = new Map<string, number>();
    for (const set of topicsByArticle.values()) {
      for (const id of set) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const facets = [...counts].map(([topicId, count]) => ({ topicId, count }));

    // An unknown id matches nothing; a non-empty filter of only unknown ids yields no headlines.
    const wanted = canonicalTopicIds.filter((id) => knownIds.has(id));
    const filtered =
      canonicalTopicIds.length === 0
        ? entries
        : entries.filter((e) => {
            const set = topicsByArticle.get(e.articleId.toString());
            return !!set && wanted.some((id) => set.has(id));
          });

    // A filter that cannot apply matches nothing above and says why here.
    let unavailableReason: string | null = null;
    if (canonicalTopicIds.length > 0) {
      if (topics.length === 0) unavailableReason = 'NO_CANONICAL_TOPICS';
      else if (topicsByArticle.size === 0) unavailableReason = 'NO_TOPIC_LINKS';
    }

    // Topic filter and facets above stay keyed on the stored article id; only the shown card and order follow the language.
    const ordered = orderEditionForLanguage(filtered, language);
    const offset = after ? decodeCursor(after) : 0;
    const hasNextPage = offset + first < ordered.length;
    return {
      headlines: await this.topHeadlines.hydrate(
        ordered.slice(offset, offset + first),
        { offset },
      ),
      facets,
      editionBuiltAt: edition.builtAt ?? null,
      unavailableReason,
      pageInfo: {
        endCursor: hasNextPage ? encodeCursor(offset + first) : null,
        hasNextPage,
        pageSize: first,
      },
    };
  }
}
