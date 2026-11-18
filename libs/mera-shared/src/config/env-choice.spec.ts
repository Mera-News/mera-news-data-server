import { assertFakeAllowed, readBool, readChoice } from './env-choice';

const env = (values: Record<string, string | undefined>) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

describe('readChoice', () => {
  const allowed = ['gemini', 'routed', 'none'] as const;

  it('returns the fallback when the key is unset or empty', () => {
    expect(readChoice(env({}), 'P', allowed, 'gemini')).toBe('gemini');
    expect(readChoice(env({ P: '  ' }), 'P', allowed, 'gemini')).toBe('gemini');
  });

  it('accepts a listed value, ignoring case and spaces', () => {
    expect(readChoice(env({ P: ' Routed ' }), 'P', allowed, 'gemini')).toBe(
      'routed',
    );
  });

  it('refuses an unlisted value and names the allowed ones', () => {
    expect(() =>
      readChoice(env({ P: 'gemni' }), 'P', allowed, 'gemini'),
    ).toThrow('P="gemni" is not one of: gemini, routed, none');
  });
});

describe('readBool', () => {
  it('reads true and false only', () => {
    expect(readBool(env({}), 'B', false)).toBe(false);
    expect(readBool(env({ B: 'TRUE' }), 'B', false)).toBe(true);
    expect(readBool(env({ B: 'false' }), 'B', true)).toBe(false);
    expect(() => readBool(env({ B: 'yes' }), 'B', false)).toThrow(
      'B="yes" must be true or false',
    );
    expect(() => readBool(env({ B: '1' }), 'B', false)).toThrow();
  });
});

describe('assertFakeAllowed', () => {
  it('allows the fake outside production', () => {
    expect(() =>
      assertFakeAllowed(env({ NODE_ENV: 'development' }), 'X'),
    ).not.toThrow();
  });

  it('refuses the fake in production unless explicitly allowed', () => {
    expect(() =>
      assertFakeAllowed(env({ NODE_ENV: 'production' }), 'X'),
    ).toThrow('X=fake is for tests only');
    expect(() =>
      assertFakeAllowed(
        env({ NODE_ENV: 'production', ALLOW_FAKE_PROVIDERS: 'true' }),
        'X',
      ),
    ).not.toThrow();
  });
});
