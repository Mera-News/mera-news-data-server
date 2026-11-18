import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Place, PlaceSchema } from '@mera/models/models/place.model';
import { SeedPlacesCommand } from './seed-places.command';
import { SeedPlacesService } from './seed-places.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Place.name, schema: PlaceSchema }]),
  ],
  providers: [SeedPlacesCommand, SeedPlacesService],
})
export class SeedPlacesModule {}
