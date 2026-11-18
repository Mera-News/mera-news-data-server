import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MeraModelsModule } from '@mera/models';
import { DEFAULT_JOB_OPTIONS } from '@mera/shared';
import { LoadRssModule } from './commands/load-rss/load-rss.module';
import { SeedPlacesModule } from './commands/seed-places/seed-places.module';
import { StatusModule } from './commands/status/status.module';
import { TopicScoresModule } from './commands/topic-scores/topic-scores.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: 'apps/mera-scripts/.env',
      cache: true,
    }),
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      inject: [ConfigService],
    }),
    MeraModelsModule,
    LoadRssModule,
    SeedPlacesModule,
    StatusModule,
    TopicScoresModule,
  ],
})
export class AppModule {}
