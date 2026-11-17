import { TopicArticleLinkSchema } from './topic-article-link.model';
import { UserTopicSchema } from './user-topic.model';

describe('canonical topic schema fields', () => {
  it('UserTopic declares the canonical paths with the right types', () => {
    expect(UserTopicSchema.path('canonical_level').instance).toBe('Number');
    expect(UserTopicSchema.path('canonical_path').instance).toBe('String');
    expect(UserTopicSchema.path('canonical_parent_id').instance).toBe(
      'ObjectId',
    );
    expect(UserTopicSchema.path('canonical_embed').instance).toBe('Array');
  });

  it('UserTopic indexes { is_canonical, canonical_level }', () => {
    expect(UserTopicSchema.indexes().map(([f]) => f)).toContainEqual({
      is_canonical: 1,
      canonical_level: 1,
    });
  });

  it('TopicArticleLink declares canonical so strict bulkWrites keep it', () => {
    expect(TopicArticleLinkSchema.path('canonical').instance).toBe('Boolean');
  });
});
