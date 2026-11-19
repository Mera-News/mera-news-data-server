import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SelfhostCheckCommand } from './selfhost-check.command';

/**
 * Its own root: the scripts app connects to MongoDB before any command runs,
 * so a check booted through it could never report that MongoDB is unreachable.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The same files the services read: the root .env is where the guide puts settings.
      envFilePath: ['apps/mera-scripts/.env', '.env'],
      cache: true,
    }),
  ],
  providers: [SelfhostCheckCommand],
})
export class SelfhostCheckModule {}
