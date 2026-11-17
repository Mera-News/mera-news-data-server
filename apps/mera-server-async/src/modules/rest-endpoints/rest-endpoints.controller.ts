import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InvokeDto } from './invoke.dto';
import { ApiKeyGuard } from './api-key.guard';

@Controller()
@UseGuards(ApiKeyGuard)
export class RestEndpointsController {
  private readonly logger = new Logger(RestEndpointsController.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  @Post('invoke')
  async invoke(@Body() dto: InvokeDto) {
    const queueName = dto.queue_name;
    const now = Date.now();
    const jobName = `api-triggered-${queueName}.${now}`;

    try {
      const queue = this.moduleRef.get<Queue>(getQueueToken(queueName), {
        strict: false,
      });

      const job = await queue.add(jobName, dto.data ?? {});

      return {
        success: true,
        message: 'Job created successfully',
        jobId: job.id,
        jobName,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to create job: ${errorMessage}`, errorStack);
      return {
        success: false,
        message: 'Failed to create job',
        error: errorMessage,
      };
    }
  }
}
