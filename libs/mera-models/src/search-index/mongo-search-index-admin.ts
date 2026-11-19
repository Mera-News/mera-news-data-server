import type { Connection } from 'mongoose';
import { NEWS_ARTICLE_COLLECTION } from './retrieval-index';
import type {
  ListedSearchIndex,
  SearchIndexAdmin,
  SearchIndexSpec,
} from './search-index-admin.port';

/** The cluster's own commands, through the connection's driver. */
export class MongoSearchIndexAdmin implements SearchIndexAdmin {
  constructor(private readonly connection: Connection) {}

  async list(): Promise<ListedSearchIndex[]> {
    return (await this.connection
      .db!.collection(NEWS_ARTICLE_COLLECTION)
      .listSearchIndexes()
      .toArray()) as ListedSearchIndex[];
  }

  async createCollection(name: string): Promise<void> {
    await this.connection.db!.createCollection(name);
  }

  async create(spec: SearchIndexSpec): Promise<void> {
    await this.connection
      .db!.collection(NEWS_ARTICLE_COLLECTION)
      .createSearchIndex({
        name: spec.name,
        type: spec.type,
        definition: spec.definition,
      });
  }
}
