import { CircuitState } from 'cockatiel';
import { EgressRefusedError } from '../url/public-egress';
import { buildProxyEgressBreaker, isEgressFault } from './proxy-egress-breaker';

const refusal = () =>
  new EgressRefusedError('10.0.0.1', 'is not a public address');
// How an HTTP client hands it back: wrapped, with the refusal as the cause.
const wrapped = () =>
  Object.assign(new Error('connect failed'), { cause: refusal() });

const breaker = () =>
  buildProxyEgressBreaker({
    faultThreshold: 0.5,
    // Twenty calls inside one second clear a 1/s floor (0 means cockatiel's own default).
    samplingDurationMs: 1_000,
    minimumRps: 1,
    halfOpenAfterMs: 60_000,
  });

async function run(policy: ReturnType<typeof breaker>, fail: () => Error) {
  for (let i = 0; i < 20; i++) {
    await policy.execute(() => Promise.reject(fail())).catch(() => undefined);
  }
}

describe('egress fault rule', () => {
  it('does not count a refused address, bare or wrapped', () => {
    expect(isEgressFault(refusal())).toBe(false);
    expect(isEgressFault(wrapped())).toBe(false);
  });

  it("still counts a failure with no response as the pool's", () => {
    expect(isEgressFault(new Error('socket hang up'))).toBe(true);
  });

  it('stays closed through a run of refused fetches', async () => {
    const policy = breaker();
    await run(policy, wrapped);
    expect(policy.state).toBe(CircuitState.Closed);
  });

  it('opens on a run of pool failures, so the closed case is not vacuous', async () => {
    const policy = breaker();
    await run(policy, () => new Error('socket hang up'));
    expect(policy.state).toBe(CircuitState.Open);
  });
});
