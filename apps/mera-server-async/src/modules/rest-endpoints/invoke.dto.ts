import { IsEnum, IsOptional, IsObject } from 'class-validator';
import { QueueName } from '@mera/shared';

export class InvokeDto {
  @IsEnum(QueueName)
  queue_name!: QueueName;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
