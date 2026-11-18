import { Types } from 'mongoose';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedCluster,
  seedHeadlineEdition,
  seedSource,
} from '../support/fixtures';

const STATUS = `{
  newsServerStatus {
    placesSeeded
    lastArticleAt
    lastClusteringAt
    lastTopicLinkAt
    headlineEditionsBuilt
    vectorIndexState
    embeddingModel
  }
}`;

interface Status {
  placesSeeded: boolean;
  lastArticleAt: string | null;
  lastClusteringAt: string | null;
  lastTopicLinkAt: string | null;
  headlineEditionsBuilt: boolean;
  vectorIndexState: string | null;
  embeddingModel: string | null;
}

describe('news server status', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  const status = async () => {
    const res = await api.gql<{ newsServerStatus: Status }>(STATUS);
    expect(res.body.errors).toBeUndefined();
    return res.body.data!.newsServerStatus;
  };

  it('says nothing is built on an empty database', async () => {
    expect(await status()).toEqual({
      placesSeeded: false,
      lastArticleAt: null,
      lastClusteringAt: null,
      lastTopicLinkAt: null,
      headlineEditionsBuilt: false,
      vectorIndexState: null,
      embeddingModel: null,
    });
  });

  it('reports what is there once places, a cluster, a link run and an edition exist', async () => {
    const source = await seedSource(api.connection);
    const article = await seedArticle(api.connection, { source });
    // Inserted oldest first, as real rows are: newest is read by `_id`.
    const clusterAt = hoursAgo(3);
    await seedCluster(api.connection, [], { createdAt: hoursAgo(30) });
    await seedCluster(api.connection, [article], { createdAt: clusterAt });
    await seedHeadlineEdition(api.connection, 'GLOBAL', [article]);
    const linkAt = hoursAgo(2);
    await api.connection
      .collection('state-machine-link-topics-to-clusters')
      .insertMany([
        { _id: new Types.ObjectId(), createdAt: hoursAgo(20) },
        { _id: new Types.ObjectId(), createdAt: linkAt },
      ]);
    await api.connection.collection('places').insertOne({
      city: 'Testville',
      countryCode: 'XX',
      displayName: 'Testville, XX',
      normalized: 'testville',
      search_keys: ['testville'],
    });

    const s = await status();
    expect(s.placesSeeded).toBe(true);
    expect(s.lastArticleAt).not.toBeNull();
    expect(s.headlineEditionsBuilt).toBe(true);
    expect(s.lastClusteringAt).toBe(clusterAt.toISOString());
    expect(s.lastTopicLinkAt).toBe(linkAt.toISOString());
  });

  it('has no field about a person, an address or a secret', async () => {
    const res = await api.gql<{
      __type: { fields: { name: string }[] };
    }>('{ __type(name: "NewsServerStatus") { fields { name } } }');

    expect(res.body.data!.__type.fields.map((f) => f.name).sort()).toEqual([
      'embeddingModel',
      'headlineEditionsBuilt',
      'lastArticleAt',
      'lastClusteringAt',
      'lastTopicLinkAt',
      'placesSeeded',
      'vectorIndexState',
    ]);
  });

  it('refuses a missing key', async () => {
    const res = await api.gql(STATUS, {}, null);
    expect(res.body.errors?.[0].message).toBe('Invalid API key');
  });
});
