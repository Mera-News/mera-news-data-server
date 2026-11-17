import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModelsNewsModule } from './models/models-news.module';
import { buildPoolTimeouts } from './mongo-pool-options';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      cache: true,
    }),
    MongooseModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const mongoUri = configService.get<string>('MONGODB_URI');
        if (!mongoUri) {
          throw new Error('MONGODB_URI environment variable is not defined');
        }
        return {
          uri: mongoUri,
          maxPoolSize: configService.get<number>('MONGODB_MAX_POOL_SIZE', 5),
          minPoolSize: 0,
          maxIdleTimeMS: 60_000,
          serverSelectionTimeoutMS: 10_000,
          readPreference: 'primary',
          // Env-gated and defaulted NOWHERE in code: this factory is the one
          // connection for async, graphql, scripts and the bull board, so a
          // request-serving timeout set here would also bound the retention
          // sweep's 10k-id deleteMany. Infra sets them per service.
          ...buildPoolTimeouts({
            socketTimeoutMS: configService.get('MONGODB_SOCKET_TIMEOUT_MS'),
            waitQueueTimeoutMS: configService.get(
              'MONGODB_WAIT_QUEUE_TIMEOUT_MS',
            ),
          }),
        };
      },
      inject: [ConfigService],
    }),
    // Only the news-side schemas: this connection never registers a
    // user-owned collection.
    ModelsNewsModule,
  ],
})
export class MeraModelsModule {}
