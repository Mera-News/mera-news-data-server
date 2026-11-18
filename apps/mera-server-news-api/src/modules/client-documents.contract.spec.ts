import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { GraphQLSchema, parse, validate } from 'graphql';
import {
  InternalNewsPublisherFieldResolver,
  InternalNewsResolver,
} from './internal-news.resolver';
import { NewsClusterArticlesResolver } from './news-cluster-articles.resolver';
import { WorldHeadlinesResolver } from './world-headlines.resolver';
import { PublicSourceResolver } from '@mera/news-core/source-url/source-url.resolvers';
import { CLIENT_DOCUMENTS } from './client-documents';

/**
 * The news client and the Mera News app send these documents as compile-time
 * constants on their side of the wire. A dropped field or argument here shows
 * up for them as GraphQL errors and a thin feed, so each document must keep
 * validating against the schema this API generates.
 */

const EXPECTED_OPERATIONS = [
  'AllCountries',
  'ClusterMembershipsForArticles',
  'GetArticleById',
  'GetArticleIdsForPersona',
  'GetArticleIdsForPersonaCheck',
  'GetArticlesForCountry',
  'GetArticlesForPublisher',
  'GetArticlesForPublisherNoOrder',
  'GetArticlesForStories',
  'GetArticlesForStoriesLegacy',
  'GetArticlesForTopicsByIds',
  'GetArticlesForTopicsByIdsLegacy',
  'GetNewsClusterForArticle',
  'GetNewsPublishers',
  'GetRecentArticleCount',
  'GetRelatedArticlesPage',
  'GetRelatedArticlesPageFiltered',
  'GetRelatedArticlesPageLegacy',
  'GetTopHeadlinesForCountry',
  'GetTopHeadlinesForCountryWindowed',
  'GetWorldHeadlines',
  'PlaceSearch',
  'PublicationProfile',
  'PublicationSourcesForNewsPublisher',
  'SearchPublishers',
];

describe('client and app news documents against the news API schema', () => {
  jest.setTimeout(60_000);

  let schema: GraphQLSchema;

  beforeAll(async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    await app.init();
    try {
      schema = await app
        .get(GraphQLSchemaFactory)
        .create([
          InternalNewsResolver,
          InternalNewsPublisherFieldResolver,
          PublicSourceResolver,
          NewsClusterArticlesResolver,
          WorldHeadlinesResolver,
        ]);
    } finally {
      await app.close();
    }
  });

  it.each(Object.keys(CLIENT_DOCUMENTS))('validates %s', (key) => {
    const errors = validate(schema, parse(CLIENT_DOCUMENTS[key]));
    expect(errors.map((error) => error.message)).toEqual([]);
  });

  it('pins the list of documents', () => {
    expect(Object.keys(CLIENT_DOCUMENTS).sort()).toEqual(EXPECTED_OPERATIONS);
  });
});
