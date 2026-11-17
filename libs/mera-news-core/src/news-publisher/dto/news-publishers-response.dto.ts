import { ObjectType, Field } from '@nestjs/graphql';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

@ObjectType()
export class NewsPublishersResponse {
  @Field(() => [NewsPublisher])
  newsPublishers!: NewsPublisher[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;
}

@ObjectType()
export class PublicationSourcesForPublisherResponse {
  @Field(() => [PublicationSource])
  publicationSources!: PublicationSource[];
}
