import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { NewsArticleService } from '../../../../libs/mera-news-core/src/news-article/news-article.service';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedCluster,
  seedHeadlineEdition,
  seedSource,
} from '../support/fixtures';

// An ID field that receives a populated document fails to serialise, and the
// serialiser's message prints the document: a source's name and feed address.
const leaks = (
  body: unknown,
  source: { publication_name: string; feed_url: string },
) => {
  const text = JSON.stringify(body);
  return (
    text.includes(source.feed_url) || text.includes(source.publication_name)
  );
};

describe('ID fields that can receive a populated document', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  it('articleById answers the source id, populated alongside publicationSource', async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });

    const res = await api.gql<{
      articleById: {
        publicationSourceId: string;
        publicationSource: { _id: string };
      };
    }>(
      `query($id: ID!) { articleById(id: $id) { publicationSourceId publicationSource { _id } } }`,
      { id: String(id) },
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.articleById.publicationSourceId).toBe(
      String(source._id),
    );
    expect(res.body.data!.articleById.publicationSource._id).toBe(
      String(source._id),
    );
  });

  it('articleById answers the source id when publicationSource is not selected', async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });

    const res = await api.gql<{ articleById: { publicationSourceId: string } }>(
      `query($id: ID!) { articleById(id: $id) { publicationSourceId } }`,
      { id: String(id) },
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.articleById.publicationSourceId).toBe(
      String(source._id),
    );
  });

  it("a cluster's articles answer their source ids", async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });
    await seedCluster(api.connection, [id]);

    const res = await api.gql<{
      newsClusterForArticle: {
        articles: { articles: { publicationSourceId: string }[] };
      };
    }>(
      `query($id: ID!) { newsClusterForArticle(articleId: $id) { articles(first: 5) { articles { publicationSourceId } } } }`,
      { id: String(id) },
    );

    expect(res.body.errors).toBeUndefined();
    expect(
      res.body.data!.newsClusterForArticle.articles.articles.map(
        (a) => a.publicationSourceId,
      ),
    ).toEqual([String(source._id)]);
  });

  it("a country's top headlines answer their source ids", async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });
    await seedHeadlineEdition(api.connection, 'NLD', [id]);

    const res = await api.gql<{
      topHeadlinesForCountry: {
        headlines: { article: { publicationSourceId: string } }[];
      };
    }>(
      `{ topHeadlinesForCountry(countryCode: "NLD", first: 5) { headlines { article { publicationSourceId } } } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(
      res.body.data!.topHeadlinesForCountry.headlines.map(
        (h) => h.article.publicationSourceId,
      ),
    ).toEqual([String(source._id)]);
  });

  it('an unpopulated read answers the same id', async () => {
    const source = await seedSource(api.connection);
    await seedArticle(api.connection, { source });

    const res = await api.gql<{
      articlesForPublicationSource: {
        articles: { publicationSourceId: string }[];
      };
    }>(
      `query($id: ID!) { articlesForPublicationSource(publicationSourceId: $id) { articles { publicationSourceId } } }`,
      { id: String(source._id) },
    );

    expect(res.body.errors).toBeUndefined();
    expect(
      res.body.data!.articlesForPublicationSource.articles.map(
        (a) => a.publicationSourceId,
      ),
    ).toEqual([String(source._id)]);
  });

  describe('an unexpected error', () => {
    let failing: NewsApi;
    const stored = {
      publication_name: 'Leaky Ledger',
      feed_url: 'https://leaky.example.test/feed.xml?token=abc',
    };

    beforeAll(async () => {
      failing = await bootNewsApi({
        override: (b) =>
          b.overrideProvider(NewsArticleService).useValue({
            articleById: () => {
              throw new Error(`could not read ${JSON.stringify(stored)}`);
            },
          }),
      });
    });
    afterAll(() => failing.close());

    it('reaches the caller without the stored values in its message', async () => {
      const res = await failing.gql(
        `query($id: ID!) { articleById(id: $id) { _id } }`,
        { id: String(new Types.ObjectId()) },
      );

      const errors = (
        res.body as { errors?: { extensions?: { code?: string } }[] }
      ).errors;
      expect(errors?.[0].extensions?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(leaks(res.body, stored)).toBe(false);
    });

    it('is still logged at ERROR with its stack', async () => {
      const errors: unknown[][] = [];
      Logger.overrideLogger({
        log: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        verbose: () => undefined,
        fatal: () => undefined,
        error: (...args: unknown[]) => errors.push(args),
      });
      try {
        await failing.gql(`query($id: ID!) { articleById(id: $id) { _id } }`, {
          id: String(new Types.ObjectId()),
        });
      } finally {
        Logger.overrideLogger(false);
      }
      const logged = errors.flat().find((a): a is Error => a instanceof Error);
      expect(logged?.stack).toMatch(/\n\s+at /);
    });
  });
});
