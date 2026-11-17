import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { HealthController } from '@mera/shared/health/health.controller';

/**
 * Metadata key + decorator for the handful of routes that must answer WITHOUT
 * a credential — in practice only the health endpoint, which Cloud Run's
 * startup and liveness probes call with no headers at all.
 *
 * It is an explicit opt-out on the handler rather than a path check inside the
 * guard: a guard that string-matches `/health` silently exempts anything a
 * future route happens to mount underneath it.
 */
export const SKIP_API_KEY = 'skipApiKey';
export const SkipApiKey = () => SetMetadata(SKIP_API_KEY, true);

/** DI token for {@link ApiKeyVerifier}. Declared before the guard that injects it. */
export const API_KEY_VERIFIER = Symbol('API_KEY_VERIFIER');

/**
 * The ONLY credential on this service.
 *
 * `apps/mera-server-news-api` is internal, service-to-service, and has no user
 * sessions — there is no `AuthMiddleware` here and no `@CurrentUser` anywhere,
 * because its caller cannot send a user identity and must not be able to. So a
 * shared `x-api-key` is the whole application-layer authentication story,
 * sitting behind Cloud Run IAM (the caller additionally presents a Google
 * id-token, which the platform verifies before the request ever arrives).
 *
 * Modelled on `apps/mera-server-async`'s `ApiKeyGuard`, with two deliberate
 * differences:
 *
 *  1. It reads the request through `GqlExecutionContext` as well as the HTTP
 *     context. This app serves GraphQL, where `context.switchToHttp()` does
 *     NOT give you the real request — it returns the resolver's argument array,
 *     and `.headers` on that is `undefined`. A guard written the HTTP-only way
 *     rejects every request with a confusing 401.
 *
 *  2. The comparison is timing-safe. `!==` on a secret leaks its length and a
 *     prefix-match oracle to anyone who can time responses; this endpoint is
 *     reachable by anything inside the VPC.
 *
 * FAIL CLOSED. A missing `MERA_NEWS_API_KEY` throws rather than waving requests
 * through. A misconfigured deployment must refuse traffic, not serve the entire
 * news corpus unauthenticated to whoever finds the URL.
 *
 * WHO the key belongs to is the injected `API_KEY_VERIFIER`'s answer, so a
 * deployment that issues its own keys binds its own verifier instead of
 * forking this guard. The answer rides on the request as `apiPrincipal`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_VERIFIER) private readonly verifier: ApiKeyVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_API_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    // The shared health controller cannot carry `@SkipApiKey()` — it lives in
    // `@mera/shared` and is used by services that have never heard of this
    // guard. Allowlisted by CLASS IDENTITY rather than by matching the path
    // string, which would also exempt anything later mounted beneath /health.
    if (context.getClass() === HealthController) return true;

    const request = this.getRequest(context);
    const presented = request?.headers?.['x-api-key'];
    const principal = await this.verifier.verify(
      typeof presented === 'string' ? presented : undefined,
    );

    if (!principal || !request) {
      // Deliberately unspecific: "wrong key" and "no key" produce the same
      // message, so a prober learns nothing about which it was.
      throw new UnauthorizedException('Invalid API key');
    }
    request.apiPrincipal = principal;
    return true;
  }

  /**
   * GraphQL requests carry the real `req` on the GraphQL context, which
   * `app.module.ts` exposes explicitly. Falls back to the HTTP context so the
   * guard also works on plain controllers (the health route, and anything REST
   * added later).
   */
  private getRequest(context: ExecutionContext): ApiKeyRequest | undefined {
    if (context.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{
        req?: ApiKeyRequest;
      }>()?.req;
    }
    return context.switchToHttp().getRequest<ApiKeyRequest>();
  }
}

/** A request that passed {@link ApiKeyGuard}, carrying whose key it was. */
export type ApiKeyRequest = Request & { apiPrincipal?: string };

export interface ApiKeyVerifier {
  /**
   * The principal a presented key belongs to, or null for a wrong or missing
   * key. Throws when the verifier itself is not configured (fail closed).
   */
  verify(presented: string | undefined): Promise<string | null>;
}

/**
 * The default verifier: one shared key from `MERA_NEWS_API_KEY`, compared in
 * constant time. Every holder of that key is the same principal.
 */
@Injectable()
export class EnvApiKeyVerifier implements ApiKeyVerifier {
  constructor(private readonly configService: ConfigService) {}

  verify(presented: string | undefined): Promise<string | null> {
    const expectedKey = this.configService.get<string>('MERA_NEWS_API_KEY');
    if (!expectedKey) {
      throw new UnauthorizedException('MERA_NEWS_API_KEY is not configured');
    }
    const matches =
      presented !== undefined && safeEqual(presented, expectedKey);
    return Promise.resolve(matches ? INTERNAL_PRINCIPAL : null);
  }
}

/**
 * The principal of the shared key. Never read under `NoopArticleQuota`; a
 * constant, so no caller-supplied value can be smuggled in as an identity.
 */
const INTERNAL_PRINCIPAL = 'internal-news-api';

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be a length
 * oracle, so the lengths are compared first and the result is folded into the
 * answer — the buffer comparison still runs on equal-length inputs only.
 */
function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
