import {
  UrlSecurityState,
  URL_SECURITY_STATE_VALUES,
  SERVABLE_URL_SECURITY_FILTER,
  DEFAULT_HTTP_LINKS_POLICY,
  HTTP_LINKS_DEACTIVATION_REASON,
  HTTP_LINKS_DEACTIVATION_SEVERITY,
  decideHttpLinksEscalation,
  utcDayKey,
  HttpLinksAction,
  HttpLinksFeedState,
} from './url-security';

const NOW = new Date('2026-08-07T12:00:00Z');
const config = DEFAULT_HTTP_LINKS_POLICY;
const DAY = 24 * 3600 * 1000;

function state(over: Partial<HttpLinksFeedState> = {}): HttpLinksFeedState {
  return { ...over };
}

function decide(input: {
  state?: HttpLinksFeedState;
  insecureArticles: number;
  evaluatedArticles: number;
  now?: Date;
}) {
  return decideHttpLinksEscalation({
    state: input.state ?? state(),
    insecureArticles: input.insecureArticles,
    evaluatedArticles: input.evaluatedArticles,
    now: input.now ?? NOW,
    config,
  });
}

describe('UrlSecurityState', () => {
  it('enumerates exactly the three explicit states', () => {
    expect(URL_SECURITY_STATE_VALUES).toEqual([
      'secure',
      'upgraded',
      'insecure',
    ]);
  });
});

describe('SERVABLE_URL_SECURITY_FILTER', () => {
  // `$ne` rather than `$in: [secure, upgraded]` is load-bearing: ~304k legacy
  // rows have no field at all and must keep serving.
  it('uses $ne so documents missing the field still match', () => {
    expect(SERVABLE_URL_SECURITY_FILTER).toEqual({
      url_security_state: { $ne: UrlSecurityState.INSECURE },
    });
  });

  it('is frozen — a shared literal must not be mutable by any call site', () => {
    expect(Object.isFrozen(SERVABLE_URL_SECURITY_FILTER)).toBe(true);
    expect(
      Object.isFrozen(SERVABLE_URL_SECURITY_FILTER.url_security_state),
    ).toBe(true);
  });

  it('survives being spread into a larger query', () => {
    const query = { createdAt: { $gte: NOW }, ...SERVABLE_URL_SECURITY_FILTER };
    expect(query.url_security_state).toEqual({ $ne: 'insecure' });
  });
});

describe('deactivation stamps', () => {
  // The reason must NOT be 'auto_fetch_failures' — that is precisely what makes
  // the existing auto-reactivation probe skip these feeds, i.e. "forever".
  it('is not the auto-reactivation-eligible reason', () => {
    expect(HTTP_LINKS_DEACTIVATION_REASON).toBe('http_links_permanent');
    expect(HTTP_LINKS_DEACTIVATION_REASON).not.toBe('auto_fetch_failures');
    expect(HTTP_LINKS_DEACTIVATION_SEVERITY).toBe('permanent');
  });
});

describe('utcDayKey', () => {
  it.each([
    ['2026-08-07T00:00:00Z', '2026-08-07'],
    ['2026-08-07T23:59:59Z', '2026-08-07'],
    ['2026-08-08T00:00:00Z', '2026-08-08'],
  ])('maps %s to %s', (iso, expected) => {
    expect(utcDayKey(new Date(iso))).toBe(expected);
  });
});

describe('decideHttpLinksEscalation', () => {
  // ── Table 1: the escalation ladder, one clean day-boundary step at a time ──
  it.each<[number, HttpLinksAction, number]>([
    [0, 'record_day', 1],
    [1, 'record_day', 2],
    [4, 'record_day', 5],
    [5, 'record_day', 6],
    // Threshold boundary: 6 -> 7 == blockAfterDays, so this is the block.
    [6, 'deactivate', 7],
    // Defensive: a count already past the threshold keeps deactivating.
    [7, 'deactivate', 8],
  ])(
    'stored day count %i on a new UTC day -> %s (count %i)',
    (stored, action, dayCount) => {
      const decision = decide({
        state: state({
          http_links_day_count: stored,
          http_links_first_seen_at: new Date(NOW.getTime() - stored * DAY),
          http_links_last_seen_at: new Date(NOW.getTime() - DAY),
        }),
        insecureArticles: 1,
        evaluatedArticles: 10,
      });
      expect(decision.action).toBe(action);
      expect(decision.dayCount).toBe(dayCount);
      expect(decision.lastSeenAt).toEqual(NOW);
    },
  );

  it('deactivates exactly at the configured threshold, not before', () => {
    expect(config.blockAfterDays).toBe(7);
    const below = decide({
      state: state({
        http_links_day_count: 5,
        http_links_last_seen_at: new Date(NOW.getTime() - DAY),
      }),
      insecureArticles: 1,
      evaluatedArticles: 1,
    });
    const at = decide({
      state: state({
        http_links_day_count: 6,
        http_links_last_seen_at: new Date(NOW.getTime() - DAY),
      }),
      insecureArticles: 1,
      evaluatedArticles: 1,
    });
    expect(below.action).toBe('record_day');
    expect(at.action).toBe('deactivate');
  });

  it('stamps first_seen_at on the first counted day and never moves it after', () => {
    const first = decide({ insecureArticles: 1, evaluatedArticles: 3 });
    expect(first.action).toBe('record_day');
    expect(first.dayCount).toBe(1);
    expect(first.firstSeenAt).toEqual(NOW);

    const anchor = new Date('2026-08-01T09:00:00Z');
    const later = decide({
      state: state({
        http_links_day_count: 3,
        http_links_first_seen_at: anchor,
        http_links_last_seen_at: new Date(NOW.getTime() - DAY),
      }),
      insecureArticles: 1,
      evaluatedArticles: 3,
    });
    expect(later.firstSeenAt).toEqual(anchor);
  });

  // ── Table 2: same-UTC-day idempotency ────────────────────────────────────
  // A feed fetched hourly must cost at most one day, or 7 days of patience
  // collapses into 7 hours. The guard is a stored timestamp, so it is also
  // idempotent across BullMQ retries.
  it.each([
    ['2026-08-07T00:00:00Z', 'same day, midnight'],
    ['2026-08-07T11:59:00Z', 'same day, one minute earlier'],
    ['2026-08-07T23:00:00Z', 'same day, later clock time'],
  ])('does not re-count within the same UTC day (%s: %s)', (iso) => {
    const decision = decide({
      state: state({
        http_links_day_count: 3,
        http_links_first_seen_at: new Date('2026-08-04T00:00:00Z'),
        http_links_last_seen_at: new Date(iso),
      }),
      insecureArticles: 5,
      evaluatedArticles: 20,
    });
    expect(decision.action).toBe('none');
    expect(decision.dayCount).toBe(3);
    expect(decision.lastSeenAt).toEqual(new Date(iso));
  });

  it('never deactivates on a repeat fetch within the same day, even at count 6', () => {
    const decision = decide({
      state: state({
        http_links_day_count: 6,
        http_links_last_seen_at: new Date('2026-08-07T01:00:00Z'),
      }),
      insecureArticles: 99,
      evaluatedArticles: 99,
    });
    expect(decision.action).toBe('none');
    expect(decision.dayCount).toBe(6);
  });

  // ── Table 3: reset on a clean fetch — "try again next day if they fixed it" ──
  it.each<[string, HttpLinksFeedState, HttpLinksAction]>([
    ['mid-escalation', { http_links_day_count: 3 }, 'reset'],
    [
      'one step from the block',
      {
        http_links_day_count: 6,
        http_links_first_seen_at: new Date('2026-08-01T00:00:00Z'),
        http_links_last_seen_at: new Date('2026-08-06T00:00:00Z'),
      },
      'reset',
    ],
    [
      'counters present but count zero',
      { http_links_last_seen_at: new Date('2026-08-06T00:00:00Z') },
      'reset',
    ],
    ['never escalated', {}, 'none'],
  ])('a fully clean fetch (%s) -> %s', (_label, stored, action) => {
    const decision = decide({
      state: state(stored),
      insecureArticles: 0,
      evaluatedArticles: 12,
    });
    expect(decision.action).toBe(action);
    expect(decision.dayCount).toBe(0);
    expect(decision.firstSeenAt).toBeNull();
    expect(decision.lastSeenAt).toBeNull();
  });

  it('resets on the same UTC day it was last counted (recovery is not rate-limited)', () => {
    const decision = decide({
      state: state({
        http_links_day_count: 4,
        http_links_last_seen_at: new Date('2026-08-07T01:00:00Z'),
      }),
      insecureArticles: 0,
      evaluatedArticles: 4,
    });
    expect(decision.action).toBe('reset');
  });

  // ── Table 4: no evidence ─────────────────────────────────────────────────
  it.each<[string, HttpLinksFeedState]>([
    ['no stored state', {}],
    ['mid-escalation', { http_links_day_count: 4 }],
  ])(
    'a fetch that classified zero articles (%s) changes nothing',
    (_label, stored) => {
      const decision = decide({
        state: state(stored),
        insecureArticles: 0,
        evaluatedArticles: 0,
      });
      expect(decision.action).toBe('none');
      expect(decision.dayCount).toBe(stored.http_links_day_count ?? 0);
    },
  );

  it('carries a human-readable reason on every branch', () => {
    const branches = [
      decide({ insecureArticles: 0, evaluatedArticles: 0 }),
      decide({ insecureArticles: 0, evaluatedArticles: 5 }),
      decide({ insecureArticles: 1, evaluatedArticles: 5 }),
      decide({
        state: state({
          http_links_day_count: 6,
          http_links_last_seen_at: new Date(NOW.getTime() - DAY),
        }),
        insecureArticles: 1,
        evaluatedArticles: 5,
      }),
      decide({
        state: state({ http_links_last_seen_at: NOW, http_links_day_count: 2 }),
        insecureArticles: 1,
        evaluatedArticles: 5,
      }),
    ];
    for (const b of branches) {
      expect(typeof b.reason).toBe('string');
      expect(b.reason.length).toBeGreaterThan(0);
    }
  });

  it('honours a non-default threshold', () => {
    const decision = decideHttpLinksEscalation({
      state: state({
        http_links_day_count: 1,
        http_links_last_seen_at: new Date(NOW.getTime() - DAY),
      }),
      insecureArticles: 1,
      evaluatedArticles: 1,
      now: NOW,
      config: { blockAfterDays: 2 },
    });
    expect(decision.action).toBe('deactivate');
    expect(decision.dayCount).toBe(2);
  });
});
