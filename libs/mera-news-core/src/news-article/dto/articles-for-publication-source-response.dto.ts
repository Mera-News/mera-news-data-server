import { ObjectType, Field } from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

@ObjectType()
export class ArticlesForPublicationSourceResponse {
  @Field(() => [NewsArticle])
  articles!: NewsArticle[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;
}
