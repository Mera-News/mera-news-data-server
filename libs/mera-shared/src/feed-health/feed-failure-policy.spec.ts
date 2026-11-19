import {
  classifyFeedFailure,
  decideFeedFailureAction,
  isChronicallyDead,
  backoffMinutes,
  DEFAULT_FEED_FAILURE_POLICY,
  PERMANENT_STATUSES,
  BLOCKED_STATUSES,
  FeedFailureSeverity,
  FeedFetchHistory,
} from './feed-failure-policy';

const NOW = new Date('2026-07-27T12:00:00Z');
const config = DEFAULT_FEED_FAILURE_POLICY;
const DAY = 24 * 3600 * 1000;

function history(over: Partial<FeedFetchHistory> = {}): FeedFetchHistory {
  return { successes: 0, failures: 0, oldestAt: null, ...over };
}

describe('classifyFeedFailure', () => {
  it.each(PERMANENT_STATUSES)('classifies HTTP %i as permanent', (status) => {
    expect(
      classifyFeedFailure({ category: 'http_status', httpStatus: status }),
    ).toBe('permanent');
  });

  it.each(BLOCKED_STATUSES)('classifies HTTP %i as blocked', (status) => {
    expect(
      classifyFeedFailure({ category: 'http_status', httpStatus: status }),
    ).toBe('blocked');
  });

  // The bulk of real-world deactivations were these.
  it.each([500, 502, 503, 504, 520, 521, 522, 523, 525, 526, 400, 408])(
    'classifies HTTP %i as transient',
    (status) => {
      expect(
        classifyFeedFailure({ category: 'http_status', httpStatus: status }),
      ).toBe('transient');
    },
  );

  it.each(['timeout', 'network', 'parse_error', 'empty_response'])(
    'classifies category %s as transient',
    (category) => {
      expect(classifyFeedFailure({ category })).toBe('transient');
    },
  );

  // A refused address changes only when the operator lists it, so waiting out a
  // backoff cannot help.
  it('classifies a refused address as permanent', () => {
    expect(classifyFeedFailure({ category: 'refused' })).toBe('permanent');
  });

  it('classifies an item-less feed as benign — a quiet publisher is not broken', () => {
    expect(classifyFeedFailure({ category: 'empty_feed' })).toBe('benign');
  });

  it('does not treat empty_response as benign (HTTP 200 with no body is suspicious)', () => {
    expect(classifyFeedFailure({ category: 'empty_response' })).toBe(
      'transient',
    );
  });

  it('defaults to transient for unknown or absent input', () => {
    expect(classifyFeedFailure({})).toBe('transient');
    expect(classifyFeedFailure({ category: 'something-new' })).toBe(
      'transient',
    );
    expect(classifyFeedFailure({ category: null, httpStatus: null })).toBe(
      'transient',
    );
  });

  it('lets an explicit httpStatus win over the category', () => {
    expect(classifyFeedFailure({ category: 'timeout', httpStatus: 404 })).toBe(
      'permanent',
    );
  });
});

describe('backoffMinutes', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 60],
    [4, 120],
    [5, 240],
    [6, 360],
    [7, 360],
    [50, 360],
  ])('failure %i -> %i minutes', (failures, expected) => {
    expect(backoffMinutes(failures, config)).toBe(expected);
  });

  it('stays bounded so a sick feed still gets several attempts a day', () => {
    expect(backoffMinutes(999, config)).toBe(config.backoffMaxMinutes);
  });
});

describe('isChronicallyDead', () => {
  it('is true with zero successes, enough attempts, and a long enough window', () => {
    expect(
      isChronicallyDead(
        history({ failures: 30, oldestAt: new Date(NOW.getTime() - 10 * DAY) }),
        NOW,
        config,
      ),
    ).toBe(true);
  });

  // The single most important guarantee: proof of life beats any failure count.
  it('is false when the window contains even one success', () => {
    expect(
      isChronicallyDead(
        history({
          successes: 1,
          failures: 500,
          oldestAt: new Date(NOW.getTime() - 100 * DAY),
        }),
        NOW,
        config,
      ),
    ).toBe(false);
  });

  it('is false when there are too few recorded attempts', () => {
    expect(
      isChronicallyDead(
        history({ failures: 5, oldestAt: new Date(NOW.getTime() - 10 * DAY) }),
        NOW,
        config,
      ),
    ).toBe(false);
  });

  it('is false when the failures are recent, however numerous', () => {
    expect(
      isChronicallyDead(
        history({ failures: 300, oldestAt: new Date(NOW.getTime() - 1 * DAY) }),
        NOW,
        config,
      ),
    ).toBe(false);
  });

  it('is false with no recorded history at all', () => {
    expect(isChronicallyDead(history({ failures: 30 }), NOW, config)).toBe(
      false,
    );
  });
});

describe('decideFeedFailureAction', () => {
  const decide = (
    over: Partial<Parameters<typeof decideFeedFailureAction>[0]>,
  ) =>
    decideFeedFailureAction({
      severity: 'transient',
      consecutiveFailures: 1,
      history: history(),
      isDeactivated: false,
      now: NOW,
      config,
      ...over,
    });

  it('ignores a benign failure entirely', () => {
    const d = decide({ severity: 'benign', consecutiveFailures: 99 });
    expect(d.action).toBe('ignore');
    expect(d.nextAttemptAt).toBeNull();
  });

  it('retries next cycle for the first couple of failures', () => {
    expect(decide({ consecutiveFailures: 1 }).action).toBe('retry_next_cycle');
    expect(decide({ consecutiveFailures: 2 }).action).toBe('retry_next_cycle');
  });

  it('quarantines with backoff once the threshold is passed', () => {
    const d = decide({ consecutiveFailures: 4 });
    expect(d.action).toBe('quarantine');
    expect(d.nextAttemptAt).toEqual(new Date(NOW.getTime() + 120 * 60_000));
  });

  it('deactivates a permanent status at the configured threshold', () => {
    const d = decide({ severity: 'permanent', consecutiveFailures: 3 });
    expect(d.action).toBe('deactivate');
    expect(d.severity).toBe('permanent');
  });

  it('does not deactivate a permanent status below the threshold', () => {
    expect(
      decide({ severity: 'permanent', consecutiveFailures: 2 }).action,
    ).not.toBe('deactivate');
  });

  // The regression that motivated this policy: 403/5xx/timeouts killed ~95%
  // of the deactivated catalog under the old count-only rule.
  it.each<FeedFailureSeverity>(['blocked', 'transient'])(
    'never deactivates a %s failure on count alone, however high',
    (severity) => {
      const d = decide({ severity, consecutiveFailures: 10_000 });
      expect(d.action).toBe('quarantine');
    },
  );

  it('deactivates a transient failure only on chronic-death evidence', () => {
    const d = decide({
      severity: 'transient',
      consecutiveFailures: 40,
      history: history({
        failures: 30,
        oldestAt: new Date(NOW.getTime() - 10 * DAY),
      }),
    });
    expect(d.action).toBe('deactivate');
    expect(d.reason).toMatch(/no successful fetch/);
  });

  it('schedules a probe when it does deactivate, so recovery stays possible', () => {
    const d = decide({ severity: 'permanent', consecutiveFailures: 3 });
    expect(d.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + config.probeIntervalMinutes * 60_000),
    );
  });

  it('re-arms the probe timer instead of escalating an already-dead feed', () => {
    const d = decide({
      severity: 'permanent',
      consecutiveFailures: 999,
      isDeactivated: true,
    });
    expect(d.action).toBe('quarantine');
    expect(d.nextAttemptAt).toEqual(
      new Date(NOW.getTime() + config.probeIntervalMinutes * 60_000),
    );
  });

  it('honors a custom config', () => {
    const d = decideFeedFailureAction({
      severity: 'permanent',
      consecutiveFailures: 1,
      history: history(),
      isDeactivated: false,
      now: NOW,
      config: { ...config, permanentThreshold: 1 },
    });
    expect(d.action).toBe('deactivate');
  });
});
