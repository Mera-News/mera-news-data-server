import { Module, Global } from '@nestjs/common';
import { AxiosService } from './axios.service';

@Global() // Make this module global so AxiosService is available everywhere
@Module({
  providers: [AxiosService],
  exports: [AxiosService],
})
export class AxiosModule {}
