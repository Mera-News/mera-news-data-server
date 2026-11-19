import { type DynamicModule, Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { SEARCH_INDEX_STATE } from '@mera/shared/health/search-index-state';
import { MongoSearchIndexAdmin } from './mongo-search-index-admin';
import { SEARCH_INDEX_ADMIN } from './search-index-admin.port';
import {
  SEARCH_INDEX_OPTIONS,
  SearchIndexService,
  type SearchIndexOptions,
} from './search-index.service';

@Module({})
export class SearchIndexModule {
  /**
   * Global, so the health controller and the status answer find
   * `SEARCH_INDEX_STATE` without importing this module. `create: true` is for
   * the async worker alone.
   */
  static forRoot(options: SearchIndexOptions): DynamicModule {
    return {
      module: SearchIndexModule,
      global: true,
      providers: [
        { provide: SEARCH_INDEX_OPTIONS, useValue: options },
        {
          provide: SEARCH_INDEX_ADMIN,
          inject: [getConnectionToken()],
          useFactory: (connection: Connection) =>
            new MongoSearchIndexAdmin(connection),
        },
        SearchIndexService,
        { provide: SEARCH_INDEX_STATE, useExisting: SearchIndexService },
      ],
      exports: [SEARCH_INDEX_STATE, SEARCH_INDEX_ADMIN],
    };
  }
}
