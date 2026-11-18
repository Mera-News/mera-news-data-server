import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Place, PlaceSchema } from '@mera/models/models/place.model';
import { PlaceService } from './place.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Place.name, schema: PlaceSchema }]),
  ],
  providers: [PlaceService],
  exports: [PlaceService],
})
export class PlaceModule {}
