import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readBool } from '@mera/shared/config/env-choice';
import { embeddingDims } from '@mera/shared/embedding-provider/embedding-config';
import type {
  IndexState,
  IndexStatus,
  SearchIndexState,
} from '@mera/shared/health/search-index-state';
import {
  assertBootIndexState,
  readIndexState,
  type IndexReading,
} from './read-index-state';
import {
  NEWS_ARTICLE_COLLECTION,
  retrievalIndexDefinition,
  textIndexDefinition,
  type VectorIndexSpec,
} from './retrieval-index';
import {
  SEARCH_INDEX_ADMIN,
  type SearchIndexAdmin,
} from './search-index-admin.port';

/** How long a read of the cluster is reused. */
const CACHE_MS = 30_000;

/** Namespace exists, index exists: the other process got there first. */
const NAMESPACE_EXISTS = 48;
const INDEX_ALREADY_EXISTS = 68;

export const SEARCH_INDEX_OPTIONS = 'SEARCH_INDEX_OPTIONS';

export interface SearchIndexOptions {
  /** Whether this process may build a missing index (the async worker). `SEARCH_INDEX_CREATE=false` overrides it. */
  create: boolean;
}

interface Readings {
  at: number;
  vector: IndexReading;
  text: IndexReading;
}

const codeOf = (error: unknown) => (error as { code?: number }).code;

/**
 * The state of the two search indexes. The async worker builds a missing one at
 * boot; nothing here ever drops, updates or rebuilds an index. Every state is
 * reported and none takes a service out of rotation.
 */
@Injectable()
export class SearchIndexService implements SearchIndexState, OnModuleInit {
  private readonly logger = new Logger(SearchIndexService.name);
  private readonly dims: number;
  /** Whether the deployment lets the worker build indexes at all. */
  private readonly creationOn: boolean;
  private readonly vectorSpec: VectorIndexSpec;
  private readonly textSpec = textIndexDefinition();
  private cache?: Readings;

  constructor(
    @Inject(SEARCH_INDEX_ADMIN) private readonly admin: SearchIndexAdmin,
    @Inject(SEARCH_INDEX_OPTIONS) private readonly options: SearchIndexOptions,
    config: ConfigService,
  ) {
    this.dims = embeddingDims(config);
    this.creationOn = readBool(config, 'SEARCH_INDEX_CREATE', true);
    this.vectorSpec = retrievalIndexDefinition(this.dims);
  }

  async onModuleInit(): Promise<void> {
    if (this.options.create && this.creationOn) await this.createMissing();
    const { vector, text } = await this.read();
    this.logBoot(this.vectorSpec.name, vector);
    this.logBoot(this.textSpec.name, text);
    assertBootIndexState(vector, this.dims);
  }

  async vector(): Promise<IndexState> {
    return (await this.read()).vector.state;
  }

  async text(): Promise<IndexState> {
    return (await this.read()).text.state;
  }

  async report(): Promise<{
    vectorIndex: IndexStatus;
    textIndex: IndexStatus;
  }> {
    const { vector, text } = await this.read();
    return {
      vectorIndex: this.status(vector),
      textIndex: this.status(text),
    };
  }

  private async read(): Promise<Readings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    // One list answer serves both indexes.
    let listed: ReturnType<SearchIndexAdmin['list']> | undefined;
    const once = { list: () => (listed ??= this.admin.list()) };
    const [vector, text] = await Promise.all([
      readIndexState(once, this.vectorSpec.name, this.vectorSpec.definition),
      readIndexState(once, this.textSpec.name),
    ]);
    this.cache = { at: Date.now(), vector, text };
    return this.cache;
  }

  /** Only an index that is `missing` is built; an unreadable list builds nothing. */
  private async createMissing(): Promise<void> {
    const { vector, text } = await this.read();
    const missing = [
      { spec: this.vectorSpec, reading: vector },
      { spec: this.textSpec, reading: text },
    ]
      .filter(({ reading }) => reading.state === 'missing')
      .map(({ spec }) => spec);
    if (missing.length === 0) return;

    try {
      await this.admin.createCollection(NEWS_ARTICLE_COLLECTION);
    } catch (error) {
      if (codeOf(error) !== NAMESPACE_EXISTS) {
        this.logCreateFailure(NEWS_ARTICLE_COLLECTION, error);
      }
    }
    for (const spec of missing) {
      try {
        await this.admin.create(spec);
      } catch (error) {
        if (codeOf(error) !== INDEX_ALREADY_EXISTS) {
          this.logCreateFailure(spec.name, error);
        }
      }
    }
    // A create, or "already exists", changed what the cluster answers.
    this.cache = undefined;
  }

  private logCreateFailure(what: string, error: unknown) {
    this.logger.error(
      `Could not create "${what}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private logBoot(name: string, reading: IndexReading) {
    if (reading.state === 'ready') return;
    const line = `Search index "${name}" is ${reading.state}. ${this.detail(reading)}`;
    // Creation off and nothing there: said once per index, so it is not missed.
    if (reading.state === 'missing' && this.creationOn) this.logger.log(line);
    else this.logger.warn(line);
  }

  private status(reading: IndexReading): IndexStatus {
    return { state: reading.state, detail: this.detail(reading) };
  }

  private detail(reading: IndexReading): string {
    const by = this.creationOn
      ? 'drop it and restart the worker so it is built again, or recreate it by hand'
      : 'drop it and create it again by hand';
    switch (reading.state) {
      case 'ready':
        return 'Ready.';
      case 'missing':
        return this.creationOn
          ? 'Not found. The worker creates it at its next boot.'
          : 'Not found, and SEARCH_INDEX_CREATE=false, so it is never created for you: create it by hand (see CREATE_VECTOR_INDEX.md).';
      case 'building':
        return 'Still building. It answers once the build finishes.';
      case 'failed':
        return `Its build failed, or it stopped taking new articles: ${by}.`;
      case 'outdated':
        return `It lacks a field this release queries: ${by}.`;
      case 'dims_mismatch':
        return `It holds ${reading.actualDims} dimensions, but EMBEDDING_DIMS is ${this.dims}. Change model or start over.`;
      case 'unreadable':
        return 'The list of search indexes could not be read, so this server cannot tell. Searches run as if it were ready.';
    }
  }
}
