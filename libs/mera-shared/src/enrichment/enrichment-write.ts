import type { ArticleEnrichment } from './article-enrichment-provider.port';

/** The value written to `tags_status` on a successful (or degraded) enrichment. */
export const TAGGING_SUCCESSFUL_STATUS = 'TAGGING_SUCCESSFUL';

/**
 * The one `news-article` update for an enrichment result, shared by the async
 * worker and the backfill command so a new field is added in exactly one
 * place (the two used to carry their own copies).
 *
 * Optional fields use conditional spreads, never `field: out.field`: an
 * explicit `undefined` in a `$set` can land as `null` depending on the
 * driver's ignoreUndefined setting, which would stamp every Gemini-produced
 * and every degraded row with nulls. With the Gemini adapter the update is
 * byte-identical to what it was before the v2 fields existed.
 */
export function buildEnrichmentUpdate(out: ArticleEnrichment): {
  $set: Record<string, unknown>;
  $unset: Record<string, ''>;
} {
  return {
    $set: {
      geo_tags: out.geo_tags,
      entities: out.entities,
      event_type: out.event_type,
      ...(out.content_category
        ? { content_category: out.content_category }
        : {}),
      ...(out.content_categories
        ? { content_categories: out.content_categories }
        : {}),
      ...(out.geo_scope ? { geo_scope: out.geo_scope } : {}),
      ...(out.genre ? { genre: out.genre } : {}),
      ...(out.tone ? { tone: out.tone } : {}),
      ...(typeof out.significance === 'number'
        ? { significance: out.significance }
        : {}),
      tags_status: TAGGING_SUCCESSFUL_STATUS,
    },
    $unset: { tagsError: '' },
  };
}
