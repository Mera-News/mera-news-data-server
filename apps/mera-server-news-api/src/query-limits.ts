import type { ConfigService } from '@nestjs/config';
import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type GraphQLFormattedError,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';
import { readText } from '@mera/shared/config/env-choice';

const DEFAULT_MAX_QUERY_DEPTH = 12;
const QUERY_TOO_COMPLEX = 'QUERY_TOO_COMPLEX';

/** Most field selections one operation may make, fragments expanded. */
export const MAX_QUERY_FIELDS = 1000;

/** `NEWS_API_MAX_QUERY_DEPTH`: how many levels of fields a query may nest. */
export function maxQueryDepth(config: ConfigService): number {
  const text = readText(config, 'NEWS_API_MAX_QUERY_DEPTH');
  if (text === '') return DEFAULT_MAX_QUERY_DEPTH;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `NEWS_API_MAX_QUERY_DEPTH="${text}" must be a positive whole number`,
    );
  }
  return n;
}

/**
 * A validation rule, so a query over the limit is refused before any resolver
 * runs. Depth and selection count follow fragments; `__schema` and `__type`
 * are skipped so introspection keeps working at any depth.
 */
export function queryLimitsRule(maxDepth: number, maxFields: number) {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(operation) {
      let fields = 0;
      let failure: string | null = null;

      const walk = (
        set: SelectionSetNode,
        depth: number,
        spreading: string[],
      ) => {
        for (const selection of set.selections) {
          if (failure) return;
          if (selection.kind === Kind.FIELD) {
            const name = selection.name.value;
            if (name === '__schema' || name === '__type') continue;
            fields += 1;
            if (fields > maxFields) {
              failure = `Query selects more than the limit of ${maxFields} fields`;
            } else if (depth + 1 > maxDepth) {
              failure = `Query is nested deeper than the limit of ${maxDepth} levels`;
            } else if (selection.selectionSet) {
              walk(selection.selectionSet, depth + 1, spreading);
            }
          } else if (selection.kind === Kind.INLINE_FRAGMENT) {
            walk(selection.selectionSet, depth, spreading);
          } else if (!spreading.includes(selection.name.value)) {
            const fragment = context.getFragment(selection.name.value);
            if (fragment) {
              walk(fragment.selectionSet, depth, [
                ...spreading,
                fragment.name.value,
              ]);
            }
          }
        }
      };

      walk(operation.selectionSet, 0, []);
      if (failure) {
        context.reportError(
          new GraphQLError(failure, {
            nodes: operation as OperationDefinitionNode,
            extensions: { code: QUERY_TOO_COMPLEX },
          }),
        );
      }
    },
  });
}

/** Apollo stamps every validation error GRAPHQL_VALIDATION_FAILED; this puts the limit's own code back. */
export function keepQueryLimitCode(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = (error as GraphQLError | undefined)?.originalError as
    | GraphQLError
    | undefined;
  return original?.extensions?.code === QUERY_TOO_COMPLEX
    ? {
        ...formatted,
        extensions: { ...formatted.extensions, code: QUERY_TOO_COMPLEX },
      }
    : formatted;
}
