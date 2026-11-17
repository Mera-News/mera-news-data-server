import { DynamicModule, Module } from '@nestjs/common';
import { TerminusModule, MongooseHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';
import { HEALTH_OPTIONS, HealthModuleOptions } from './health.constants';

export { HEALTH_OPTIONS, HealthModuleOptions };

@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions = {}): DynamicModule {
    const providers: any[] = [
      RedisHealthIndicator,
      { provide: HEALTH_OPTIONS, useValue: options },
    ];

    if (options.mongo) {
      providers.push(MongooseHealthIndicator as any);
    }

    return {
      module: HealthModule,
      imports: [TerminusModule],
      controllers: [HealthController],
      providers,
    };
  }
}
