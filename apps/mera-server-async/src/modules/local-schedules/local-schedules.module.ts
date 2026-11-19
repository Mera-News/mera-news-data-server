import { Module } from '@nestjs/common';
import { LocalSchedulesService } from './local-schedules.service';

// No queue registration of its own: the service takes the processors' queues.
@Module({
  providers: [LocalSchedulesService],
})
export class LocalSchedulesModule {}
