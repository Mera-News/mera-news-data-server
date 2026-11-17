import { buildPoolTimeouts, optionalTimeoutMs } from './mongo-pool-options';

/**
 * These pin a NEGATIVE property — "there is no code default" — which is
 * exactly the kind of thing that rots silently: someone adds a sensible
 * fallback, every other test stays green, and a request-serving timeout is
 * suddenly bounding the retention sweep's 10k-id deleteMany on the shared
 * connection.
 *
 * Absence is asserted with `'key' in object`, never `toBeUndefined()`: the
 * latter passes both when the key is missing AND when it is present holding
 * undefined, so it could not tell the two apart.
 */
describe('optionalTimeoutMs', () => {
  it('coerces a numeric string, because env values are strings', () => {
    // ConfigService.get<number> returns a string when the value came from the
    // environment; the generic is a claim, not a coercion.
    expect(optionalTimeoutMs('45000')).toBe(45_000);
  });

  it('accepts a real number unchanged', () => {
    expect(optionalTimeoutMs(10_000)).toBe(10_000);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('yields undefined for %s', (_label, raw) => {
    expect(optionalTimeoutMs(raw)).toBeUndefined();
  });
});

describe('buildPoolTimeouts', () => {
  it('returns an EMPTY object when neither variable is set', () => {
    const opts = buildPoolTimeouts({});

    // The whole contract: spreading this into a connection must change
    // nothing, so async, scripts and the bull board keep the driver defaults.
    expect(Object.keys(opts)).toEqual([]);
    expect('socketTimeoutMS' in opts).toBe(false);
    expect('waitQueueTimeoutMS' in opts).toBe(false);
  });

  it('omits the key entirely for an unusable value rather than passing undefined', () => {
    const opts = buildPoolTimeouts({
      socketTimeoutMS: 'abc',
      waitQueueTimeoutMS: '0',
    });

    expect('socketTimeoutMS' in opts).toBe(false);
    expect('waitQueueTimeoutMS' in opts).toBe(false);
  });

  it('applies only the variable that is set', () => {
    const opts = buildPoolTimeouts({ waitQueueTimeoutMS: '10000' });

    expect(opts).toEqual({ waitQueueTimeoutMS: 10_000 });
    expect('socketTimeoutMS' in opts).toBe(false);
  });

  it('applies both when both are set', () => {
    expect(
      buildPoolTimeouts({
        socketTimeoutMS: '45000',
        waitQueueTimeoutMS: '10000',
      }),
    ).toEqual({ socketTimeoutMS: 45_000, waitQueueTimeoutMS: 10_000 });
  });
});
