import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorFunction,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';
import { HEALTH_OPTIONS, HealthModuleOptions } from './health.constants';

/**
 * Liveness and readiness, shared by every app in this repo.
 *
 * NEVER THROTTLED, and this is a correctness requirement rather than a saving.
 * An app-wide `APP_GUARD` throttler fires on these plain REST routes too, and a
 * platform probe is anonymous, so it carries no `req.user` and falls to the
 * tracker's IP branch. Cloud Run terminates TLS in front of express and sets no
 * `trust proxy`, so that IP is the front end's for effectively all traffic:
 * every probe from every instance collapses onto ONE bucket. Backed by shared
 * Redis storage that is a single fleet-wide budget for health checks, so a
 * busy enough service starts 429ing its own probes, failing them, and taking
 * revisions down — the failure looks like an unhealthy app rather than a
 * throttle.
 *
 * It also spares a storage round trip on every probe, which is the lesser half.
 *
 * `@SkipThrottle()` ALONE, never paired with `@Throttle`: ThrottlerGuard reads
 * the skip metadata BEFORE a route's limit/ttl override, so the pair cancels
 * the override and leaves the route completely unthrottled — the opposite of
 * raising its limit. This controller carries no limit to override.
 *
 * Inert where no throttler is configured: the decorator only writes reflection
 * metadata, so apps without a ThrottlerGuard are unaffected.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(HEALTH_OPTIONS)
    private readonly options: HealthModuleOptions,
    @Optional()
    @Inject(MongooseHealthIndicator)
    private readonly mongoose?: MongooseHealthIndicator,
    @Optional()
    @Inject(RedisHealthIndicator)
    private readonly redis?: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    const checks: HealthIndicatorFunction[] = [];

    if (this.mongoose) {
      checks.push(() => this.mongoose!.pingCheck('mongodb'));
    }
    if (this.redis) {
      checks.push(() => this.redis!.isHealthy('redis'));
    }

    return this.health.check(checks);
  }
}
