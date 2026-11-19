import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CanonicalTopic, CanonicalTopicsService } from '@mera/news-core';

@Resolver(() => CanonicalTopic)
export class CanonicalTopicsResolver {
  constructor(private readonly service: CanonicalTopicsService) {}

  @Query(() => [CanonicalTopic], {
    name: 'canonicalTopics',
    description:
      'The seeded canonical category tree, optionally one level. Empty until the tree is seeded.',
  })
  canonicalTopics(
    @Args('level', { type: () => Int, nullable: true }) level?: number,
  ): Promise<CanonicalTopic[]> {
    return this.service.list(level);
  }
}
