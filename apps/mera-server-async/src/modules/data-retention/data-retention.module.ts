import { Module } from '@nestjs/common';
import { DataRetentionSweepProcessor } from './processor-data-retention-sweep/data-retention-sweep.processor';
import { DataRetentionSweepService } from './processor-data-retention-sweep/data-retention-sweep.service';

@Module({
  providers: [DataRetentionSweepProcessor, DataRetentionSweepService],
})
export class DataRetentionModule {}
