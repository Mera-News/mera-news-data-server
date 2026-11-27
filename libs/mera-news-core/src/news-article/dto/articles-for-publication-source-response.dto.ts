import { ObjectType, Field } from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

@ObjectType()
export class ArticlesForPublicationSourceResponse {
  @Field(() => [NewsArticle])
  articles!: NewsArticle[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;

  @Field(() => [String], {
    description:
      'One cursor per article, in the same order: passed as after, it continues right after that article, so a caller that keeps only part of a page loses nothing.',
  })
  itemCursors!: string[];
}
