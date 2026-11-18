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
import { ADAPTER_DOCUMENTS } from './adapter-documents';

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE WIRE CONTRACT WITH THE NEWS CLIENT, MACHINE-CHECKED
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The news client's `MeraNewsAdapter` sends eleven GraphQL documents that are
 * compile-time constants in ITS repo. Nothing in a normal build of THIS repo
 * can see them, so a renamed field, a dropped argument or a narrowed type here
 * produces no error anywhere at build time.
 *
 * It produces GraphQL `errors` at runtime instead — and the adapter's failure
 * policy deliberately turns any `errors` response into the degraded value for
 * that method, logging only the error COUNT (never the messages, because a
 * GraphQL error string can echo the variables back). The observable symptom of
 * breaking this contract is therefore a THIN OR EMPTY FEED with no recorded
 * cause. That is the worst possible failure mode, and this file exists to make
 * it a red test instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOCUMENTS ARE HAND-TRANSCRIBED COPIES, AND THAT IS THE POINT. They live
 * in `./adapter-documents`, shared with `scripts/news-api-probe.ts`, which
 * EXECUTES what this file only validates. See that module's header for why
 * they are copied rather than imported from the client.
 *
 * This file answers "does the schema still accept these documents"; it boots
 * no server and touches no database. The probe answers "does a running service
 * return usable data for them". Both are needed: a document can validate
 * against the schema and still resolve to null on every field.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Root fields this service must NOT expose. Everything here is user-side or a
 * write, and the whole point of a separate internal service is that one leaked
 * API key cannot reach any of it. `articlesForStories` is not listed: the news
 * client sends it, and here it is the same unmetered read as its twin.
 */
const FORBIDDEN_ROOT_FIELDS = [
  'userBilling',
  'userPersonaByUserId',
  'unblockRequestStatus',
];

describe('internal news API — wire contract with the news client', () => {
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
        .create([InternalNewsResolver, InternalNewsPublisherFieldResolver]);
    } finally {
      await app.close();
    }
  });

  it.each(Object.keys(ADAPTER_DOCUMENTS))(
    'validates %s against the generated schema',
    (operationName) => {
      const errors = validate(schema, parse(ADAPTER_DOCUMENTS[operationName]));
      // Surface the real messages — "expected 1 to be 0" would tell whoever
      // broke this nothing about which field went missing.
      expect(errors.map((error) => error.message)).toEqual([]);
    },
  );

  it('covers every operation the adapter can send', () => {
    // The adapter has 11 documents. A document silently dropped from the map
    // above would make this suite pass while leaving that operation unchecked.
    expect(Object.keys(ADAPTER_DOCUMENTS)).toHaveLength(11);
  });

  it('exposes no mutation at all', () => {
    expect(schema.getMutationType()).toBeUndefined();
  });

  it.each(FORBIDDEN_ROOT_FIELDS)('does NOT expose %s', (fieldName) => {
    const queryFields = schema.getQueryType()?.getFields() ?? {};
    expect(Object.keys(queryFields)).not.toContain(fieldName);
  });
});
