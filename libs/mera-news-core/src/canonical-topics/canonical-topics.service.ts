import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import { categoryLabel } from '@mera/shared/enrichment/category-tree';
import { CanonicalTopic } from './canonical-topic.dto';

const MEMO_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class CanonicalTopicsService {
  private memo: { at: number; topics: CanonicalTopic[] } | null = null;

  constructor(
    @InjectModel(UserTopic.name)
    private readonly userTopicModel: Model<UserTopicDocument>,
  ) {}

  /**
   * Every canonical row, memoized in-process for an hour: the tree is seeded,
   * never derived from what readers ask for. An empty answer is not memoized,
   * so a server that is seeded after its first request serves the tree at once.
   */
  async all(): Promise<CanonicalTopic[]> {
    if (this.memo && Date.now() - this.memo.at < MEMO_TTL_MS) {
      return this.memo.topics;
    }
    const rows = await this.userTopicModel
      .find({ is_canonical: true })
      .select('canonical_path canonical_level')
      .sort({ canonical_path: 1 })
      .lean()
      .exec();
    const topics = rows
      .filter((r) => !!r.canonical_path)
      .map((r) => ({
        id: r._id.toString(),
        path: r.canonical_path as string,
        label: categoryLabel(r.canonical_path as string),
        level: r.canonical_level ?? 1,
        parentId: null, // shortcut: only the first level is seeded; resolve from the path when a second one is.
      }));
    if (topics.length > 0) this.memo = { at: Date.now(), topics };
    return topics;
  }

  async list(level?: number | null): Promise<CanonicalTopic[]> {
    const topics = await this.all();
    return level == null ? topics : topics.filter((t) => t.level === level);
  }
}
