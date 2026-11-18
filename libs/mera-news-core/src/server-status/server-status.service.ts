import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { NewsServerStatus } from './server-status.dto';

/** Read-only and cheap enough for anyone to call: collection metadata and one indexed read per collection. */
@Injectable()
export class ServerStatusService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async status(): Promise<NewsServerStatus> {
    const db = this.connection.db!;
    // Newest by `_id`, which every collection indexes: one index step each.
    const newest = async (collection: string) =>
      (
        await db.collection(collection).findOne<{
          createdAt?: Date;
        }>({}, { sort: { _id: -1 }, projection: { createdAt: 1 } })
      )?.createdAt ?? null;

    const [places, editions, lastArticleAt, lastClusteringAt, lastTopicLinkAt] =
      await Promise.all([
        db.collection('places').estimatedDocumentCount(),
        db.collection('headline-edition').estimatedDocumentCount(),
        newest('news-article'),
        newest('news-cluster'),
        newest('state-machine-link-topics-to-clusters'),
      ]);

    return {
      placesSeeded: places > 0,
      lastArticleAt,
      lastClusteringAt,
      lastTopicLinkAt,
      headlineEditionsBuilt: editions > 0,
      // Filled in once the vector index state is recorded.
      vectorIndexState: null,
      embeddingModel: null,
    };
  }
}
