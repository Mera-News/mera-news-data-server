import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  NewsPublisher,
  NewsPublisherSchema,
} from '@mera/models/models/news-publisher.model';
import { NewsFeedListOfCountriesService } from './news-feed-list-of-countries.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: NewsPublisher.name, schema: NewsPublisherSchema },
    ]),
  ],
  providers: [NewsFeedListOfCountriesService],
  exports: [NewsFeedListOfCountriesService],
})
export class NewsFeedListOfCountriesModule {}
