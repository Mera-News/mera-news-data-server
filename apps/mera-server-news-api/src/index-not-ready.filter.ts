import { Catch, Logger } from '@nestjs/common';
import type { GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

/**
 * Nest logs every error a resolver throws at ERROR with its stack. A search
 * index that is still building, or a headline list rebuilt between two pages,
 * is an expected state that callers retry, so each gets one line per answer
 * instead; every other error is logged as before.
 */
@Catch(GraphQLError)
export class IndexNotReadyFilter implements GqlExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(error: GraphQLError): GraphQLError {
    if (error.extensions?.code === 'INDEX_NOT_READY') {
      this.logger.warn(`${error.message} (INDEX_NOT_READY)`);
    } else if (error.extensions?.code === 'EDITION_CHANGED') {
      this.logger.log(`${error.message} (EDITION_CHANGED)`);
    } else {
      this.logger.error(error);
    }
    return error;
  }
}
