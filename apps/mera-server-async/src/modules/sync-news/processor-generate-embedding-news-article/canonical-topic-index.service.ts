import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import {
  CANONICAL_TOPIC_LEVELS,
  type CanonicalIndexEntry,
} from '@mera/shared/enrichment/category-tree';

const RELOAD_MS = 60 * 60 * 1000;

/**
 * In-memory copy of the canonical L1 rows (`topicId` + `canonical_embed`) the
 * embed stage classifies against. Reloaded at most hourly; a failed load keeps
 * the previous index. Never throws into a job: no index just means no links.
 */
@Injectable()
export class CanonicalTopicIndex {
  private readonly logger = new Logger(CanonicalTopicIndex.name);
  private index: CanonicalIndexEntry[] = [];
  private loadedAt = 0;
  private emptyLogged = false;
  private loading?: Promise<void>;

  constructor(
    @InjectModel(UserTopic.name)
    private readonly topicModel: Model<UserTopicDocument>,
  ) {}

  async get(): Promise<readonly CanonicalIndexEntry[]> {
    if (Date.now() - this.loadedAt >= RELOAD_MS) {
      this.loading ??= this.load().finally(() => (this.loading = undefined));
      await this.loading;
    }
    return this.index;
  }

  private async load(): Promise<void> {
    // Stamp first so a failing Mongo is retried hourly, not on every job.
    this.loadedAt = Date.now();
    try {
      const rows = await this.topicModel
        .find({
          is_canonical: true,
          canonical_level: { $in: [...CANONICAL_TOPIC_LEVELS] },
        })
        .select('_id canonical_embed')
        .lean();
      this.index = rows
        .filter((r) => r.canonical_embed?.length)
        .map((r) => ({
          topicId: r._id.toString(),
          vector: r.canonical_embed as number[],
        }));
      if (this.index.length === 0 && !this.emptyLogged) {
        this.emptyLogged = true;
        this.logger.warn('canonical_index_empty');
      }
    } catch (err) {
      this.logger.warn(
        `canonical_index_load_failed (keeping previous index): ${(err as Error).message}`,
      );
    }
  }
}
