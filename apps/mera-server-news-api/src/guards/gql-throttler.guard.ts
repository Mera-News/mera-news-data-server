import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';

/**
 * The stock throttler guard reads the HTTP request, which a GraphQL operation
 * does not fill. This one reads the request and response `app.module.ts`
 * puts on the GraphQL context, and the HTTP pair everywhere else.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  protected getRequestResponse(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      const { req, res } = GqlExecutionContext.create(context).getContext<{
        req: Record<string, any>;
        res: Record<string, any>;
      }>();
      return { req, res };
    }
    const http = context.switchToHttp();
    return {
      req: http.getRequest<Record<string, any>>(),
      res: http.getResponse<Record<string, any>>(),
    };
  }

  /**
   * A GraphQL client gets the code `TOO_MANY_REQUESTS`, `retryAfterSeconds`
   * and a `Retry-After` header, so it can tell "slow down" from a server
   * fault. The HTTP status stays 200, as for any error inside execution.
   */
  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    if (context.getType<'graphql'>() !== 'graphql') {
      return super.throwThrottlingException(context, detail);
    }
    const retryAfter = Math.max(
      1,
      Math.ceil(detail.timeToBlockExpire || detail.timeToExpire),
    );
    throw new GraphQLError(
      `Too many requests. Try again in ${retryAfter} seconds.`,
      {
        extensions: {
          code: 'TOO_MANY_REQUESTS',
          retryAfterSeconds: retryAfter,
          http: {
            headers: new Map([['retry-after', String(retryAfter)]]),
          },
        },
      },
    );
  }
}
