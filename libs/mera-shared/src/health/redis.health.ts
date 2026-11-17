import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Optional() @Inject(CACHE_MANAGER) private readonly cacheManager?: Cache,
  ) {}

  /** `down()` makes HealthCheckService answer 503, as HealthCheckError did. */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    if (!this.cacheManager) {
      return indicator.up({ message: 'Redis not configured' });
    }

    try {
      // Attempt a basic set/get to verify Redis connectivity
      const testKey = '__health_check__';
      await this.cacheManager.set(testKey, 'ok', 5000);
      const value = await this.cacheManager.get(testKey);

      if (value === 'ok') {
        return indicator.up();
      }

      throw new Error('Redis read/write check failed');
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
