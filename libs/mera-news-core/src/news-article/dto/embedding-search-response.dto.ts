import { ObjectType, Field, Float } from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';

@ObjectType()
export class EmbeddingSearchResult {
  @Field(() => NewsArticle)
  article!: NewsArticle;

  @Field(() => Float)
  score!: number;
}

@ObjectType()
export class EmbeddingSearchResponse {
  @Field(() => [EmbeddingSearchResult])
  results!: EmbeddingSearchResult[];

  @Field()
  query!: string;

  @Field()
  totalResults!: number;
}
