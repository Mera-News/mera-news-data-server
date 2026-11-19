import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  SEARCH_INDEX_STATE,
  type SearchIndexState,
} from '@mera/shared/health/search-index-state';
import { NewsServerStatus } from './server-status.dto';

/** Read-only and cheap enough for anyone to call: collection metadata and one indexed read per collection. */
@Injectable()
export class ServerStatusService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional()
    @Inject(SEARCH_INDEX_STATE)
    private readonly indexes?: SearchIndexState,
  ) {}

  async status(): Promise<NewsServerStatus> {
    const db = this.connection.db!;
    // Newest by `_id`, which every collection indexes: one index step each.
    const newest = async (collection: string) =>
      (
        await db.collection(collection).findOne<{
          createdAt?: Date;
        }>({}, { sort: { _id: -1 }, projection: { createdAt: 1 } })
      )?.createdAt ?? null;

    const [
      places,
      editions,
      lastArticleAt,
      lastClusteringAt,
      lastTopicLinkAt,
      embeddingModel,
      vectorIndexState,
      textIndexState,
    ] = await Promise.all([
      db.collection('places').estimatedDocumentCount(),
      db.collection('headline-edition').estimatedDocumentCount(),
      newest('news-article'),
      newest('news-cluster'),
      newest('state-machine-link-topics-to-clusters'),
      // What the stored vectors were made with, not what is configured now.
      db
        .collection<{ _id: string; model?: string }>('deployment-meta')
        .findOne({ _id: 'embedding' }, { projection: { model: 1 } }),
      this.indexes?.vector() ?? null,
      this.indexes?.text() ?? null,
    ]);

    return {
      placesSeeded: places > 0,
      lastArticleAt,
      lastClusteringAt,
      lastTopicLinkAt,
      headlineEditionsBuilt: editions > 0,
      vectorIndexState,
      textIndexState,
      embeddingModel: embeddingModel?.model ?? null,
    };
  }
}
