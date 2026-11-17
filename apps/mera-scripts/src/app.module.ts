import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MeraModelsModule } from '@mera/models';
import { DEFAULT_JOB_OPTIONS } from '@mera/shared';
import { LoadRssModule } from './commands/load-rss/load-rss.module';

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
  ],
})
export class AppModule {}
