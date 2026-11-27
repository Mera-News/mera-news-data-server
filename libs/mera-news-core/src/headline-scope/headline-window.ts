/**
 * The Explore views, in hours: "the stories most covered in the last N hours".
 * The builder ranks one list per view from the same 48h pool (the article
 * TTL), counting only the articles inside the view. `entries` on the edition is
 * the 24h list; the others live in `views`.
 *
 * shortcut: a fixed set, not free input. Each view is a full ranked list built
 * every run; a new value means a new list, so add it here and rebuild.
 */
export const HEADLINE_VIEW_WINDOWS_HOURS = [6, 12, 24, 48] as const;
export const DEFAULT_HEADLINE_VIEW_WINDOW_HOURS = 24;

/**
 * Mongo projection for reading an edition for one view: the 24h list is
 * `entries`, any other view also needs its own `views` element. `entries`
 * always comes along, as the fallback for an edition built before `views`.
 */
export function editionProjectionForWindow(
  windowHours: number,
): Record<string, number | object> | string {
  if (windowHours === DEFAULT_HEADLINE_VIEW_WINDOW_HOURS) return '-views';
  return {
    scopeKey: 1,
    builtAt: 1,
    entryCount: 1,
    entries: 1,
    views: { $elemMatch: { windowHours } },
  };
}

/**
 * The ranked list for one view. 24h is `entries`; another view is its `views`
 * element. An edition written before `views` existed serves `entries` for
 * every view, exactly as it did.
 */
export function pickEditionEntries<T>(
  edition: {
    entries?: T[] | null;
    views?: Array<{ windowHours: number; entries?: T[] | null }> | null;
  },
  windowHours: number,
): T[] {
  if (windowHours !== DEFAULT_HEADLINE_VIEW_WINDOW_HOURS) {
    const view = edition.views?.find((v) => v.windowHours === windowHours);
    if (view) return view.entries ?? [];
  }
  return edition.entries ?? [];
}

/**
 * Aggregation expression for one view's ranked list, chosen as
 * `pickEditionEntries` chooses it, so a page can be cut with `$slice` in the
 * database instead of reading every entry.
 */
export function editionListExpression(windowHours: number): object {
  const entries = { $ifNull: ['$entries', []] };
  if (windowHours === DEFAULT_HEADLINE_VIEW_WINDOW_HOURS) return entries;
  return {
    $let: {
      vars: {
        view: {
          $first: {
            $filter: {
              input: { $ifNull: ['$views', []] },
              cond: { $eq: ['$$this.windowHours', windowHours] },
            },
          },
        },
      },
      in: { $ifNull: ['$$view.entries', entries] },
    },
  };
}
