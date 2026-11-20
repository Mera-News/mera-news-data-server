import type { GraphQLFormattedError } from 'graphql';

/**
 * An unexpected error's message can hold whatever the failing code had in
 * hand, such as a stored document with its feed address (graphql's own
 * serialisers print the value they refuse). Callers get the code only; refusals
 * this API makes on purpose carry their own codes and keep their messages.
 */
export function hideInternalErrorMessage(
  formatted: GraphQLFormattedError,
): GraphQLFormattedError {
  return formatted.extensions?.code === 'INTERNAL_SERVER_ERROR'
    ? { ...formatted, message: 'Internal server error' }
    : formatted;
}
