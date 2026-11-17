import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID } from '@nestjs/graphql';

export type PublicationSourceDocument = PublicationSource & Document;

@ObjectType()
@Schema({ collection: 'publication-source', timestamps: true })
export class PublicationSource {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field()
  @Prop({ required: true })
  publication_name!: string;

  @Field({ nullable: true })
  @Prop()
  publication_url?: string;

  @Field()
  @Prop({ required: true, unique: true })
  feed_url!: string;

  @Field()
  @Prop({
    required: true,
    enum: ['news-api', 'rss-feed'],
    index: true,
  })
  type!: 'news-api' | 'rss-feed';

  /**
   * Language code declared in the RSS feed's <language> tag.
   * May be missing or incorrectly set to 'en' for non-English feeds.
   */
  @Field({ nullable: true })
  @Prop()
  feed_language_code?: string;

  /**
   * Language code detected from article content using CLD3.
   * Only populated when feed_language_code is missing or 'en'.
   */
  @Field({ nullable: true })
  @Prop()
  detected_language_code?: string;

  @Field()
  @Prop({ required: true })
  country_code!: string;

  @Field({ nullable: true })
  @Prop()
  country_name?: string;

  @Field()
  @Prop({ required: true, index: true })
  category!: string;

  /**
   * What KIND of outlet this is — closed vocabulary, see PUBLICATION_TYPES in
   * @mera/models/constants/publication-taxonomy. Distinct from `category`, which
   * is free text AND an embedding input (article-data.ts) and so cannot be
   * re-keyed without re-embedding the corpus.
   *
   * The single stored trust/kind axis. There is deliberately no second stored
   * column derived from `category`: measured against the live corpus, a
   * keyword derivation agreed with this field on the badge decision for
   * 148/148 regulators and produced zero badges for non-authorities, so it
   * added no information — and it independently mislabelled outlets whose
   * category merely contains the word "authority". The derivation has since
   * been deleted outright rather than kept as a fallback: it was wrong in both
   * directions, and a guess that only ever fires where curation is missing is a
   * guess nobody is watching.
   *
   * So this field is the ONLY input to the badge. Absent means "not classified
   * yet" and renders nothing — never "ordinary press". The mapping is exactly
   * `government` -> GOVERNMENT, `regulator` -> AGENCY, everything else nothing.
   *
   * Populated from the RSS taxonomy JSON by `load-rss` (both the insert and the
   * update branch). Until that runs after a taxonomy patch, this is null for
   * every row and no badge renders anywhere — which is the correct failure
   * mode, and worth knowing before concluding the badge is broken.
   */
  @Field({ nullable: true })
  @Prop({ index: true })
  publication_type?: string;

  /**
   * What the outlet is ABOUT — closed vocabulary, see PUBLICATION_CATEGORIES.
   * Multi-valued (a paper can be news_politics + business). NOT an embedding
   * input, so unlike `category` this is safe to update in place on re-runs.
   */
  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], index: true })
  categories?: string[];

  @Field(() => ID, { nullable: true })
  @Prop({
    type: Types.ObjectId,
    ref: 'NewsPublisher',
    required: false,
    index: true,
  })
  newsPublisherId?: Types.ObjectId;

  @Field({ defaultValue: true })
  @Prop({ default: true })
  is_active!: boolean;

  @Field()
  @Prop({ default: Date.now })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;

  /**
   * Timestamp of the most recent feed fetch attempt (success or failure).
   * Written by news-ingest-job-v3 per feeds.fetched message, staleness-guarded.
   */
  @Field({ nullable: true })
  @Prop()
  last_fetched_at?: Date;

  /**
   * Outcome of the most recent feed fetch attempt.
   * 'ok' | http_status | timeout | network | oversized | parse_error | empty_feed
   * | 'shed'
   * (A future proxy-vs-direct probe will also emit 'gated'.)
   *
   * 'shed' is NOT a fetch outcome: it means our own proxy egress was
   * unavailable and the feed was never attempted. It is recorded here anyway so
   * an egress fault that never recovers is visible in feed-health reporting
   * instead of leaving the last good value in place forever. Nothing selects
   * fetchable feeds on this field, and adding such a filter would drop every
   * shed feed out of the catalogue during an outage.
   */
  @Field({ nullable: true })
  @Prop()
  last_fetch_status?: string;

  @Field({ nullable: true })
  @Prop()
  last_fetch_http_status?: number;

  /**
   * Consecutive failed fetch CYCLES ($inc once per fanout cycle via
   * `fetch_failure_cycle_id`, reset to 0 on a successful fetch). Feeds the
   * backoff schedule and the permanent-status threshold in FeedFailurePolicy;
   * on its own it no longer deactivates anything — see `deactivation_reason`.
   */
  @Field({ nullable: true })
  @Prop()
  consecutive_fetch_failures?: number;

  /** Human-readable last fetch error (categorized message). Cleared on success. */
  @Field({ nullable: true })
  @Prop()
  last_fetch_error?: string;

  /**
   * Feed is reachable directly but blocked via the datacenter proxy pool.
   * The fetch pipeline may route gated feeds around the proxy.
   */
  @Field({ defaultValue: false })
  @Prop({ default: false })
  gated?: boolean;

  /**
   * Codegen's latest DIRECT-fetch verdict (rss-parser, no proxy). One of two
   * provenance flags. Fetched when EITHER this or `is_active_user` is not false
   * (see news-sync-fanout) — so a proxy-reachable-but-direct-failed feed is still
   * tried. Refreshed by load-rss on every run.
   */
  @Field({ nullable: true })
  @Prop({ default: true })
  is_active_codegen?: boolean;

  /**
   * Crawler/manual PROXY-validated verdict ("checked by me"). The second
   * provenance flag; human-owned — load-rss never overwrites it on re-runs.
   * Defaults true for audit-added feeds (they passed proxy validation at merge).
   */
  @Field({ nullable: true })
  @Prop({ default: true })
  is_active_user?: boolean;

  /** Informational codegen verdict: 'valid' | 'invalid' | 'bot_protected'. */
  @Field({ nullable: true })
  @Prop()
  codegen_status?: string;

  /** When codegen last validated this feed. */
  @Field({ nullable: true })
  @Prop()
  codegen_checked_at?: Date;

  // ---------------------------------------------------------------------
  // Feed-health scheduling / quarantine (Mongoose-only — deliberately NOT
  // exposed via @Field, so schema.gql and the app codegen are untouched).
  // ---------------------------------------------------------------------

  /**
   * Earliest time this feed should be fetched again. Absent or in the past =
   * due now. Set by the failure backoff (quarantine) and by the probe cadence
   * for auto-deactivated feeds. This is how a broken feed is slowed down
   * WITHOUT being switched off.
   */
  @Prop()
  fetch_next_attempt_at?: Date;

  /**
   * Start of the current continuous failure run (stamped on the 0->1
   * transition, cleared on success). Anchors the time-based "chronically
   * dead" evaluation so it measures elapsed days, not attempt count.
   */
  @Prop()
  fetch_failing_since?: Date;

  /**
   * Fanout cycle that last incremented `consecutive_fetch_failures`. Makes the
   * counter idempotent across BullMQ retries / stall re-deliveries.
   */
  @Prop()
  fetch_failure_cycle_id?: string;

  /**
   * Consecutive fetches that parsed fine but contained zero items. Purely
   * informational — a quiet publisher is not a broken feed, so this never
   * counts toward deactivation.
   */
  @Prop()
  consecutive_empty_fetches?: number;

  /** When `is_active` was last set false. */
  @Prop()
  deactivated_at?: Date;

  /**
   * Why the feed was deactivated. Only `'auto_fetch_failures'` is eligible for
   * the auto-reactivation probe — a human-set `is_active:false` has no reason
   * stamped and is therefore never resurrected automatically.
   */
  @Prop()
  deactivation_reason?: string;

  /** FeedFailureSeverity that triggered deactivation ('permanent' | 'dead'). */
  @Prop()
  deactivation_severity?: string;

  /** When a probe fetch last brought this feed back to life. */
  @Prop()
  reactivated_at?: Date;

  // ---------------------------------------------------------------------
  // Conditional GET / egress provenance (Mongoose-only — same precedent as
  // the feed-health block above: operational, not client-facing, so no @Field
  // and no schema.gql / app-codegen churn).
  // ---------------------------------------------------------------------

  /**
   * Last `ETag` served for this feed, stored RAW.
   *
   * Never normalise, re-quote or strip the weak-validator `W/` prefix. The
   * value is opaque: its only job is to be echoed back in `If-None-Match`
   * byte-for-byte, and an origin comparing strings will miss on anything else,
   * silently costing a full body download instead of a 304.
   */
  @Prop()
  http_etag?: string;

  /**
   * Last `Last-Modified` served for this feed, stored RAW as a STRING.
   *
   * A `Date` here would be a bug, not a tidy-up. Round-tripping through Date
   * and back re-serialises to a canonical RFC-1123 form, and origins that
   * string-compare `If-Modified-Since` then miss on any origin whose own
   * formatting differs (day padding, timezone spelling, extra whitespace).
   * Same rule as `http_etag`: echo exactly what was received.
   */
  @Prop()
  http_last_modified?: string;

  /**
   * Which egress actually served the last successful fetch.
   *
   * Derived from what the request DID, never from the `gated` flag. Deriving it
   * from the flag is how `fetchMeta.via` came to report 'proxy' for feeds the
   * direct fallback had rescued, which would have made every promotion decision
   * downstream read fabricated evidence.
   */
  @Prop()
  last_fetch_via?: 'proxy' | 'direct';

  /**
   * Consecutive successful fetches served by the DIRECT egress. The evidence
   * `promote-direct-feeds` reads. Reset to 0 by any proxy-served success, so it
   * measures a current run rather than a lifetime total.
   */
  @Prop()
  consecutive_direct_successes?: number;

  /**
   * Final URL after a redirect chain in which EVERY hop was 301 or 308.
   *
   * OBSERVATION ONLY. Deliberately not written to `feed_url`, which is the
   * identity of this row: mis-writing it orphans a source, and "the origin
   * stated a fact" is not a high enough bar for that. A single 302 or 307
   * anywhere in the chain leaves this unset, because a temporary redirect says
   * nothing about where the feed lives. Promotion into `feed_url` belongs to
   * audit tooling behind a dry run, the same way `gated` is handled.
   */
  @Prop()
  resolved_feed_url?: string;

  /**
   * Consecutive fanout cycles in which this feed was SHED rather than fetched,
   * because our own proxy egress was unavailable.
   *
   * A shed deliberately writes no fetch-history row and never touches
   * `consecutive_fetch_failures` — our outage is not the feed's fault. But
   * "writes nothing" is right for a transient event and wrong forever: one bad
   * credential in a PROXY_URLS rotation would shed indefinitely while
   * `feed_health.byStatus` stayed clean and no counter could ever trip. This is
   * the DB-level evidence that a shed is not transient, and it exists precisely
   * because a Cloud Monitoring alert would need a terraform apply to ship.
   *
   * Reset to 0 by any recorded fetch outcome, success or failure.
   */
  @Prop()
  consecutive_shed_cycles?: number;

  /** When this feed was last shed. Not a fetch attempt, so not `last_fetched_at`. */
  @Prop()
  last_shed_at?: Date;

  /**
   * Fanout cycle that last incremented `consecutive_shed_cycles`. Same job as
   * `fetch_failure_cycle_id` and kept separate from it on purpose: a feed is
   * either shed or fetched in a given cycle, never both, and sharing one field
   * would make the two counters silently interfere across a cycle boundary.
   */
  @Prop()
  shed_cycle_id?: string;

  // ---------------------------------------------------------------------
  // Insecure-link escalation (Mongoose-only — same precedent as the
  // feed-health block above: operational, not client-facing, so no @Field
  // and no schema.gql / app-codegen churn).
  //
  // DELIBERATELY SEPARATE from the fetch-failure counters. A feed can be
  // perfectly reachable and publish nothing but http links, and a feed can be
  // down for a week having only ever published https. Both ladders advance on
  // their own evidence and whichever trips first deactivates; nothing in this
  // block reads or writes `fetch_next_attempt_at`, `consecutive_fetch_failures`
  // or `fetch_failing_since`.
  //
  // NOTE the asymmetry: a feed is NEVER counted for being FETCHED over http
  // (~9% of active feeds are). That is our connection to the publisher, not the
  // reader's connection to the article. Only an article whose `article_url`
  // lands `url_security_state: 'insecure'` counts.
  //
  // Policy lives in `@mera/shared/url/url-security` (decideHttpLinksEscalation).
  // ---------------------------------------------------------------------

  /** First UTC day this feed was counted for emitting insecure links. */
  @Prop()
  http_links_first_seen_at?: Date;

  /**
   * Most recent UTC day counted. Doubles as the same-day idempotency guard —
   * an hourly feed costs at most one day, so the threshold is days of patience
   * rather than hours, and BullMQ retries cannot double-count.
   */
  @Prop()
  http_links_last_seen_at?: Date;

  /**
   * Distinct UTC days on which this feed produced an `insecure` article.
   * CLEARED (with both timestamps) by the first fetch whose articles are all
   * secure/upgraded — that is "try again next day if they fixed it". At
   * `HTTP_LINKS_BLOCK_AFTER_DAYS` (default 7) the feed is deactivated with
   * `deactivation_reason: 'http_links_permanent'`, which — because it is NOT
   * `'auto_fetch_failures'` — the auto-reactivation probe skips by construction.
   */
  @Prop()
  http_links_day_count?: number;

  // ---------------------------------------------------------------------
  // Fact-check credibility signal (Mongoose-only — same precedent as the
  // feed-health block above: internal, not client-facing, so no @Field and
  // no schema.gql / app-codegen churn — see "INTERNAL ONLY" below).
  //
  // Written EXCLUSIVELY by a scheduled read-only aggregator
  // (apps/mera-server-async/src/modules/publication-credibility) that reads
  // the `fact-check` collection and joins it to this collection via
  // `article-fingerprint.publicationSourceId`. It is NOT written by the
  // fact-check pipeline itself — that separation is deliberate: an
  // aggregator can be re-run to rebuild these three fields from scratch, and
  // a bug in it cannot corrupt a fact-check row. Every run is a full
  // recompute: a publication whose flagged evidence has since aged out of
  // the `fact-check` collection (30-day retention) is reset to 0, not left
  // holding a stale accusation.
  //
  // ⚠️ THIS IS A RATIO OVER *ASSESSED* ARTICLES ONLY — NEVER OVER EVERYTHING
  // THE PUBLICATION PUBLISHED, and not even over every article that was
  // fact-checked. A publication with 3 assessed articles and 2 flagged is
  // NOT "67% false" — it is 2-of-3 *assessed*, statistically meaningless at
  // that sample size (a 95% Wilson interval on 2/3 spans roughly 9%-91%).
  // ALWAYS read `fact_check_flagged_count` together with
  // `fact_check_assessed_count` (the denominator) and treat the pair as
  // having no signal below `MIN_FACT_CHECK_DENOMINATOR` (10, see
  // publication-credibility-aggregate.service.ts — even at n=10 the interval
  // is wide, but it no longer spans nearly the whole [0,1] range the way
  // n=3 does). There is deliberately NO precomputed ratio field here: a bare
  // percentage is exactly what gets copied out of a database without its
  // denominator, so it is not stored at all.
  //
  // ⚠️ THE SIGNAL IS NOT PUBLISHER-BLIND. The per-article `verdict` this
  // aggregates is produced by a model call that is TOLD the publication's
  // name (`FactCheckRequest.publicationName`, see
  // `libs/mera-shared/src/fact-check/fact-check-provider.port.ts`). A
  // per-publication rate built on that field partly measures the model's
  // own prior about the publisher, not an independent signal. This — more
  // than the small-denominator problem above — is why this stays internal:
  // it is not merely "not enough data yet", it is "the measurement
  // instrument already knows the answer it's grading."
  //
  // ⚠️ INTERNAL ONLY. No resolver, no DTO, no GraphQL field. A
  // public per-publication falsity score is a defamation surface and a
  // product decision that has not been made — do not add a @Field to these
  // three props without that decision being made explicitly.
  // ---------------------------------------------------------------------

  /**
   * Denominator: `fact-check` rows attributed to this publication (via
   * article-fingerprint) whose status is `complete` AND whose `verdict` is a
   * CONCLUSIVE one — i.e. present and not `unverifiable`. Both `blocked`
   * rows (no evidence at all) and `complete` rows with verdict
   * `unverifiable` are excluded for the same reason: neither carries
   * information that could ever land in `fact_check_flagged_count`, so
   * counting them in the denominator would only ever dilute the ratio
   * downward without being wrong — but "assessed" should mean an assessment
   * actually happened.
   */
  @Prop()
  fact_check_assessed_count?: number;

  /**
   * Numerator, always <= `fact_check_assessed_count`. Count of the assessed
   * rows above whose row-level `verdict` is `disputed` or `unsupported` —
   * the two values in the closed `FACT_CHECK_VERDICTS` set (see the port
   * file referenced above) that correspond to "false or misleading" in this
   * closed vocabulary. `mixed` (partially true) is deliberately NOT
   * counted here even though it is in the assessed denominator: it contains
   * true elements and flagging it would misreport a nuanced finding as
   * straightforwardly false.
   */
  @Prop()
  fact_check_flagged_count?: number;

  /**
   * When the aggregator last touched this row — including a run that reset
   * both counts to 0 because no supporting `fact-check` evidence remained.
   * Absent means the aggregator has never had reason to update this
   * publication (no fact-check row has ever resolved to it).
   */
  @Prop()
  fact_check_computed_at?: Date;

  // ---------------------------------------------------------------------
  // Phonetic display name per app locale (Mongoose-only, no @Field, so
  // schema.gql and the app codegen are untouched; the graphql query that
  // serves it declares its own output type).
  //
  // Written ONLY by the `translate-publication-names` job in mera-server-async.
  // `publication_name` itself is never changed by that job: it stays the key
  // every app-side preference, visit and suppression record is stored under.
  // ---------------------------------------------------------------------

  /**
   * `publication_name` written the way a reader of each app locale would say
   * it, in that locale's script, never translated by meaning ("Der Spiegel" is
   * デア・シュピーゲル in ja, never "The Mirror"). Keyed by the app's 20 locale
   * codes (`PUBLICATION_NAME_LOCALES` in
   * `@mera/shared/translation/publication-name-i18n`). Absent means not
   * computed yet, and a reader falls back to `publication_name`.
   */
  @Prop({ type: Map, of: String })
  publication_name_i18n?: Map<string, string>;

  /**
   * The exact `publication_name` the map above was computed from. When it
   * differs from the current `publication_name` (a `rename-publications` run
   * or a re-key), the map is STALE and the next job run recomputes it. This is
   * the whole rename story: nothing else invalidates the map.
   */
  @Prop()
  publication_name_i18n_source?: string;
}

export const PublicationSourceSchema =
  SchemaFactory.createForClass(PublicationSource);

// Compound index for efficient country_code+category queries
PublicationSourceSchema.index({ country_code: 1, category: 1 });

// Same access shape for the structured taxonomy ("all newspapers in FRA").
PublicationSourceSchema.index({ country_code: 1, publication_type: 1 });

// Hourly fanout selection: active feeds that are due, and the probe pool of
// auto-deactivated feeds that are due. Both key on is_active + due time.
PublicationSourceSchema.index({ is_active: 1, fetch_next_attempt_at: 1 });
