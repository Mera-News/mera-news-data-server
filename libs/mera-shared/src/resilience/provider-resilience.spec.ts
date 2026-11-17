import {
  buildProviderResiliencePolicy,
  DEFAULT_PROVIDER_RESILIENCE,
  ProviderResilienceOptions,
} from './provider-resilience';

const base: ProviderResilienceOptions = {
  concurrency: 2,
  retryAttempts: 0,
  backoffMs: 1,
  maxBackoffMs: 2,
  breakerThreshold: 5,
  breakerHalfOpenMs: 100,
  timeoutMs: 500,
};

describe('buildProviderResiliencePolicy', () => {
  it('exposes production defaults', () => {
    expect(DEFAULT_PROVIDER_RESILIENCE.retryAttempts).toBe(3);
    expect(DEFAULT_PROVIDER_RESILIENCE.timeoutMs).toBe(60_000);
  });

  it('executes a call and passes an AbortSignal through', async () => {
    const policy = buildProviderResiliencePolicy(base);
    const seen = await policy.execute(({ signal }) =>
      Promise.resolve(signal instanceof AbortSignal),
    );
    expect(seen).toBe(true);
  });

  it('retries a transient failure then succeeds', async () => {
    const policy = buildProviderResiliencePolicy({ ...base, retryAttempts: 2 });
    let calls = 0;
    const result = await policy.execute(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('flaky'));
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rejects after exhausting a zero-retry policy (single attempt)', async () => {
    const policy = buildProviderResiliencePolicy(base);
    let calls = 0;
    await expect(
      policy.execute(() => {
        calls++;
        return Promise.reject(new Error('down'));
      }),
    ).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('clamps a zero concurrency up to a working semaphore', async () => {
    const policy = buildProviderResiliencePolicy({ ...base, concurrency: 0 });
    await expect(policy.execute(() => Promise.resolve('x'))).resolves.toBe('x');
  });
});
