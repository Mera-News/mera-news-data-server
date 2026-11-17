import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { RETENTION_RULES, RetentionRule } from '@mera/shared';
import {
  JobReporter,
  NOOP_JOB_REPORTER,
} from '../../shared-utilities/mera-worker-host';

export interface DataRetentionSweepJobData {
  // Optional override of the per-rule max age (ms). Mostly for one-off
  // backfills / manual runs; leave undefined in scheduled execution.
  overrideMaxAgeMs?: number;
  // Optional restriction to a subset of rules by parent model name.
  onlyModels?: string[];
  // Skip the second-phase orphan cleanup. The hourly schedule sets this so the
  // cheap parent-rule deletes run every hour, while the expensive orphan
  // anti-join aggregations only run on a separate daily schedule.
  skipOrphans?: boolean;
}

export interface RuleSweepResult {
  model: string;
  cutoff: string;
  expiredParents: number;
  parentsDeleted: number;
  cascadeDeleted: Record<string, number>;
}

export interface OrphanCleanupResult {
  // ALWAYS 0: topics are not referenced by users. Kept in the shape so the reporter, Bull
  // Board job results and any historical job-result consumer keep working —
  // topic expiry is now governed by the age-based `UserTopic` retention rule
  // (`lastRequestedAt`), not by an orphan anti-join.
  orphanTopicsDeleted: number;
  orphanTopicArticleLinksDeleted: number;
  orphanTopicClusterLinksDeleted: number;
  orphanTopicClusterLinksByClusterDeleted: number;
  // Set when the orphan phase is skipped (hourly schedule).
  skipped?: boolean;
}

const ZERO_ORPHAN_RESULT: OrphanCleanupResult = {
  orphanTopicsDeleted: 0,
  orphanTopicArticleLinksDeleted: 0,
  orphanTopicClusterLinksDeleted: 0,
  orphanTopicClusterLinksByClusterDeleted: 0,
  skipped: true,
};

export interface DataRetentionSweepResult {
  success: true;
  rules: RuleSweepResult[];
  orphans: OrphanCleanupResult;
}

// Cap each $in batch so a backlog can't blow up the BSON document size or
// stall the loop. 10k ObjectIds per deleteMany is well within Mongo's
// 16MB doc limit.
const ID_BATCH_SIZE = 10_000;

@Injectable()
export class DataRetentionSweepService {
  private readonly logger = new Logger(DataRetentionSweepService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async sweep(
    data: DataRetentionSweepJobData,
    signal: AbortSignal,
    reporter: JobReporter = NOOP_JOB_REPORTER,
  ): Promise<DataRetentionSweepResult> {
    const onlyModels = data.onlyModels && new Set(data.onlyModels);
    const results: RuleSweepResult[] = [];

    const totalRules = RETENTION_RULES.length;
    for (let idx = 0; idx < totalRules; idx++) {
      const rule = RETENTION_RULES[idx];
      this.throwIfAborted(signal);
      if (onlyModels && !onlyModels.has(rule.model)) continue;

      const maxAgeMs = data.overrideMaxAgeMs ?? rule.maxAgeMs;
      const cutoff = new Date(Date.now() - maxAgeMs);

      try {
        const result = await this.sweepRule(rule, cutoff, signal);
        results.push(result);
        // Reserve the final 15% of the bar for the orphan-cleanup phase.
        await reporter.progress(
          Math.round(((idx + 1) / totalRules) * 85),
          `Swept ${rule.model}: deleted ${result.parentsDeleted}/${result.expiredParents} expired`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Sweep failed for ${rule.model}: ${message}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw err;
      }
    }

    let orphans: OrphanCleanupResult;
    if (data.skipOrphans) {
      orphans = ZERO_ORPHAN_RESULT;
      await reporter.progress(100, 'Skipped orphan cleanup (hourly run)');
    } else {
      await reporter.progress(85, 'Running orphan cleanup');
      orphans = await this.cleanupOrphans(signal);
      await reporter.log(`Orphan cleanup: ${JSON.stringify(orphans)}`);
    }

    return { success: true, rules: results, orphans };
  }

  /**
   * Second-phase cleanup that catches orphans the age-based cascade can't —
   * link rows whose parent was deleted via a non-sweep path (a manual delete, a
   * migration, or an interrupted cascade). Runs after the per-rule loop so we
   * only look at the residual state.
   *
   * TOPIC SEMANTICS: `UserTopic` is an ANONYMOUS,
   * text-keyed cache shared by all clients; NOTHING references a topic from a
   * user. Topic
   * lifetime is therefore governed purely by the age-based `UserTopic` rule in
   * RETENTION_RULES (`lastRequestedAt`, 14 days), which cascades to both link
   * tables. This phase no longer deletes topics at all; it only reaps link rows
   * whose parent `user-topic` document no longer exists.
   *
   * IMPORTANT: ArticleFingerprint references PublicationSource via an OPTIONAL
   * `publicationSourceId`. The fingerprint is the dedup ledger (URL is what
   * matters) and is still valid without the FK — that pass was removed
   * entirely; we NEVER delete the fingerprint row.
   *
   * All `distinct()` calls have been replaced with `$lookup` anti-join
   * aggregations. MongoDB's `distinct` command has a hard 16 MB response cap
   * that trips once the referenced-ID set grows large enough; `$lookup`
   * pipelines have no such limit and stop as soon as one match is found.
   */
  private async cleanupOrphans(
    signal: AbortSignal,
  ): Promise<OrphanCleanupResult> {
    const UserTopic = this.connection.model('UserTopic');
    const TopicArticleLink = this.connection.model('TopicArticleLink');
    const TopicClusterLink = this.connection.model('TopicClusterLink');
    const NewsCluster = this.connection.model('NewsCluster');

    // Shared sub-pipeline: "does a user-topic document with this _id still
    // exist?" $limit: 1 makes it a semi-join — stops on first hit, no full scan.
    const topicExists = (topicIdVar: string) => ({
      from: UserTopic.collection.name,
      let: { topicId: topicIdVar },
      pipeline: [
        { $match: { $expr: { $eq: ['$_id', '$$topicId'] } } },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      as: '_refs',
    });

    // 1. (removed) Orphan UserTopics. Topics are no longer reference-counted —
    // there is no user↔topic link to anti-join against. Expiry is the
    // age-based `UserTopic` retention rule; see the doc comment above.
    const orphanTopicsDeleted = 0;

    // 2. Orphan link tables — rows whose parent topic no longer exists. The
    // retention cascade already removes links for topics IT deletes, so this is
    // a safety net for topics that vanished by some other path.
    // Each table is aggregated independently so topicIds unique to one table
    // aren't missed (e.g. a TopicClusterLink whose topic was deleted externally
    // but has no corresponding TopicArticleLink row).
    this.throwIfAborted(signal);
    const [orphanArticleLinkTopicIds, orphanClusterLinkTopicIds] =
      await Promise.all([
        TopicArticleLink.aggregate<{ _id: Types.ObjectId }>([
          { $group: { _id: '$topicId' } },
          { $lookup: topicExists('$_id') },
          { $match: { _refs: { $size: 0 } } },
        ]).allowDiskUse(true),
        TopicClusterLink.aggregate<{ _id: Types.ObjectId }>([
          { $group: { _id: '$topicId' } },
          { $lookup: topicExists('$_id') },
          { $match: { _refs: { $size: 0 } } },
        ]).allowDiskUse(true),
      ]);

    let orphanTopicArticleLinksDeleted = 0;
    for (let i = 0; i < orphanArticleLinkTopicIds.length; i += ID_BATCH_SIZE) {
      this.throwIfAborted(signal);
      const batch = orphanArticleLinkTopicIds
        .slice(i, i + ID_BATCH_SIZE)
        .map((d) => d._id);
      const res = await TopicArticleLink.deleteMany({
        topicId: { $in: batch },
      });
      orphanTopicArticleLinksDeleted += res.deletedCount ?? 0;
    }

    let orphanTopicClusterLinksDeleted = 0;
    for (let i = 0; i < orphanClusterLinkTopicIds.length; i += ID_BATCH_SIZE) {
      this.throwIfAborted(signal);
      const batch = orphanClusterLinkTopicIds
        .slice(i, i + ID_BATCH_SIZE)
        .map((d) => d._id);
      const res = await TopicClusterLink.deleteMany({
        topicId: { $in: batch },
      });
      orphanTopicClusterLinksDeleted += res.deletedCount ?? 0;
    }

    // 2b. TopicClusterLink whose clusterId no longer points at a live cluster.
    // The NewsCluster TTL cascade is supposed to clean these, but rows leak when
    // a cluster is deleted via a non-sweep path or the cascade is interrupted.
    // Without this pass, `cluster_count` over-reports because countDocuments on
    // TopicClusterLink doesn't validate the clusterId target.
    // Anti-join replaces: NewsCluster.distinct('_id') + $nin.
    this.throwIfAborted(signal);
    const orphanClusterLinkDocs = await TopicClusterLink.aggregate<{
      _id: Types.ObjectId;
    }>([
      {
        $lookup: {
          from: NewsCluster.collection.name,
          let: { clusterId: '$clusterId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$clusterId'] } } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: '_refs',
        },
      },
      { $match: { _refs: { $size: 0 } } },
      { $project: { _id: 1 } },
    ]).allowDiskUse(true);
    const orphanClusterLinkIds = orphanClusterLinkDocs.map((d) => d._id);

    let orphanTopicClusterLinksByClusterDeleted = 0;
    for (let i = 0; i < orphanClusterLinkIds.length; i += ID_BATCH_SIZE) {
      this.throwIfAborted(signal);
      const batch = orphanClusterLinkIds.slice(i, i + ID_BATCH_SIZE);
      const res = await TopicClusterLink.deleteMany({ _id: { $in: batch } });
      orphanTopicClusterLinksByClusterDeleted += res.deletedCount ?? 0;
    }

    // NOTE: the previous "ArticleFingerprint with dangling publicationSourceId
    // → $unset" pass was removed. It scanned the entire (1M+ row) fingerprint
    // collection against publication-source every run (the single heaviest DB
    // query: ~175M docs examined), and a dangling optional FK is harmless — the
    // fingerprint is a URL-keyed dedup ledger that's valid without it.

    const result: OrphanCleanupResult = {
      orphanTopicsDeleted,
      orphanTopicArticleLinksDeleted,
      orphanTopicClusterLinksDeleted,
      orphanTopicClusterLinksByClusterDeleted,
    };

    this.logger.log(`Orphan cleanup: ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * One rule: select what has expired, cascade, delete.
   *
   * `rule.filter` (optional) narrows WHICH rows the age applies to — see
   * `retention.config.ts`. It is spread FIRST so the age predicate always wins a
   * key collision, and it is applied to BOTH statements:
   *
   * ⚠️ THE FILTER MUST BE RE-APPLIED ON THE `deleteMany`. This is read-then-
   * delete, and the two halves are separated by the cascade round-trips, so a
   * row can stop matching the predicate in between — for `FactCheck` that means
   * the hourly re-check sweep populating `checkedBy` on a row we selected as
   * empty, and deleting it anyway would destroy exactly the attributed answer
   * the rule exists to preserve. Re-filtering makes "a populated row is never
   * deleted by the 7-day rule" a guarantee rather than a probability. Rules with
   * no filter spread nothing and are byte-identical to before.
   *
   * ⚠️ The CASCADE is NOT re-guarded — it runs before the parent delete and
   * keys on the ids selected. A filtered rule that also cascaded could therefore
   * delete dependents of a parent that then survives the re-filter. No filtered
   * rule has a cascade today; if one ever does, the cascade needs the same
   * treatment (or the parent delete has to move first).
   */
  private async sweepRule(
    rule: RetentionRule,
    cutoff: Date,
    signal: AbortSignal,
  ): Promise<RuleSweepResult> {
    const parentModel = this.connection.model(rule.model);
    const ageFilter = {
      ...(rule.filter ?? {}),
      [rule.ageField]: { $lt: cutoff },
    };

    // `maxPerRun` bounds a rule that met a large backlog; the rest waits for
    // the next run. Absent, the query is exactly what it always was.
    const selection = parentModel.find(ageFilter, { _id: 1 });
    const expiredDocs = await (
      rule.maxPerRun !== undefined ? selection.limit(rule.maxPerRun) : selection
    ).lean<{ _id: Types.ObjectId }[]>();

    const expiredIds = expiredDocs.map((d) => d._id);
    const cascadeDeleted: Record<string, number> = {};
    let parentsDeleted = 0;

    if (expiredIds.length === 0) {
      this.logger.log(
        `Sweep ${rule.model}: no expired docs (cutoff ${cutoff.toISOString()})`,
      );
      return {
        model: rule.model,
        cutoff: cutoff.toISOString(),
        expiredParents: 0,
        parentsDeleted: 0,
        cascadeDeleted,
      };
    }

    for (let i = 0; i < expiredIds.length; i += ID_BATCH_SIZE) {
      this.throwIfAborted(signal);
      const batch = expiredIds.slice(i, i + ID_BATCH_SIZE);

      // 1. Cascade deletes before the parent so dependents never outlive parents.
      for (const c of rule.cascade ?? []) {
        const depModel = this.connection.model(c.model);
        const res = await depModel.deleteMany({
          [c.foreignKey]: { $in: batch },
        });
        cascadeDeleted[c.model] =
          (cascadeDeleted[c.model] ?? 0) + (res.deletedCount ?? 0);
      }

      // 2. Delete parents — re-applying the rule's predicate, never the ids
      // alone. See the doc comment: a row that stopped matching since the
      // `find` must survive.
      const parentRes = await parentModel.deleteMany({
        ...(rule.filter ?? {}),
        _id: { $in: batch },
      });
      parentsDeleted += parentRes.deletedCount ?? 0;
    }

    this.logger.log(
      `Sweep ${rule.model}: expired=${expiredIds.length} parentsDeleted=${parentsDeleted} cascade=${JSON.stringify(cascadeDeleted)} cutoff=${cutoff.toISOString()}`,
    );

    return {
      model: rule.model,
      cutoff: cutoff.toISOString(),
      expiredParents: expiredIds.length,
      parentsDeleted,
      cascadeDeleted,
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw Object.assign(new Error('Operation aborted due to timeout'), {
        name: 'AbortError',
      });
    }
  }
}
