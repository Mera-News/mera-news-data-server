/**
 * Declarative retention rules consumed by the `data-retention-sweep` BullMQ
 * processor. Replaces blind Mongo TTL indexes — defining `cascade` here is the
 * one place to wire "when parent expires, also delete these dependents".
 *
 * Model names match the mongoose model names registered in `ModelsNewsModule`
 * (i.e. the `<Class>.name` strings).
 */
export interface RetentionCascade {
  model: string;
  foreignKey: string;
}

export interface RetentionRule {
  model: string;
  ageField: string;
  maxAgeMs: number;
  cascade?: RetentionCascade[];
  /**
   * OPTIONAL PREDICATE narrowing WHICH rows this age applies to. Absent ⇒ the
   * rule is a plain age sweep over the whole collection, byte-identical to
   * before this field existed.
   *
   * It exists so one collection can carry TWO lifetimes that depend on the
   * CONTENT of the row rather than only on its age (the `UserTopic` rule below
   * uses it to exempt canonical rows). The alternative was a
   * bespoke second sweeper for one collection; a predicate on the generic rule
   * keeps the sweeper a single query and keeps the policy declarative, in the
   * one file that is meant to answer "what is deleted, and when".
   *
   * ⚠️ The sweeper applies this filter TWICE — once to select and once again on
   * the `deleteMany` — because it is read-then-delete and a row can change in
   * between. See `data-retention-sweep.service.ts`.
   *
   * ⚠️ Two rules on the SAME model are legal (that is the point) but they share
   * the job's `overrideMaxAgeMs`, which overrides EVERY rule in the run. So a
   * manual `{onlyModels: [model], overrideMaxAgeMs: X}` applies X to every rule
   * on that model, including an unfiltered one. Manual overrides were always
   * blunt; with two rules on one model they are blunter.
   */
  filter?: Record<string, unknown>;
  /**
   * OPTIONAL CAP on how many expired rows ONE run deletes for this rule.
   * Absent ⇒ unbounded, exactly as before this field existed.
   *
   * For a rule added to a collection that already holds a large backlog: the
   * sweep loads every expired `_id` into memory before deleting, and one
   * failing rule aborts the whole run (every later rule and the orphan phase
   * with it). A cap makes the first backlog drain over several hourly runs
   * instead of one giant pass, and keeps the steady state unchanged because a
   * day's expiry is far below it.
   */
  maxPerRun?: number;
}

const HOURS = 3600_000;
const DAYS = 24 * HOURS;

export const RETENTION_RULES: RetentionRule[] = [
  {
    model: 'NewsArticle',
    ageField: 'createdAt',
    maxAgeMs: 48 * HOURS,
    cascade: [
      { model: 'ClusterArticleLink', foreignKey: 'articleId' },
      { model: 'TopicArticleLink', foreignKey: 'articleId' },
    ],
  },
  {
    model: 'NewsCluster',
    ageField: 'createdAt',
    maxAgeMs: 48 * HOURS,
    cascade: [
      { model: 'TopicClusterLink', foreignKey: 'clusterId' },
      { model: 'ClusterArticleLink', foreignKey: 'clusterId' },
    ],
  },
  {
    model: 'ArticleFingerprint',
    ageField: 'createdAt',
    maxAgeMs: 90 * DAYS,
  },
  // Transient job-tracking records — only the latest-per-source is ever read
  // (change detection); historic rows are an audit trail that grows unbounded.
  {
    model: 'StateMachineFetchPublication',
    ageField: 'createdAt',
    maxAgeMs: 14 * DAYS,
  },
  {
    model: 'StateMachineLinkTopicsToClusters',
    ageField: 'createdAt',
    maxAgeMs: 7 * DAYS,
  },
  // ===========================================================================
  // The ANONYMOUS topic cache. `UserTopic` is keyed by `news_topic_text` and
  // shared across all clients. Nothing links a topic
  // to a user, so it can no longer be kept alive by a persona reference and
  // needs its own age-based lifecycle.
  //
  // 14 days is a deliberate product decision: a topic nobody has asked for in
  // two weeks is dropped, and it regenerates transparently through the cold
  // path (embed + $vectorSearch) the next time someone requests it. The
  // `lastRequestedAt` clock is refreshed (throttled) on every feed request in
  // `articles-for-topics.service.ts`.
  //
  // NOTE: `sweepRule` matches `{ [ageField]: { $lt: cutoff } }`, so documents
  // MISSING `lastRequestedAt` are never swept — pre-existing rows are
  // backfilled separately.
  {
    model: 'UserTopic',
    ageField: 'lastRequestedAt',
    maxAgeMs: 14 * DAYS,
    // Canonical category rows are seeded, not requested: never swept.
    filter: { is_canonical: { $ne: true } },
    cascade: [
      { model: 'TopicArticleLink', foreignKey: 'topicId' },
      { model: 'TopicClusterLink', foreignKey: 'topicId' },
    ],
  },
];
