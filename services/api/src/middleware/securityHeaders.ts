import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';

/**
 * Chain entry 5. Cheap headers that apply to every response, including error responses.
 *
 * `Cache-Control: no-store` is the default rather than the exception. The health endpoint
 * is the clearest case — a cached health response makes a reload look successful when it
 * was not (P0-14) — but it holds generally: every authed response here is per-user, and a
 * shared cache holding one is a data leak. A route that genuinely wants caching sets its
 * own header afterwards.
 *
 * There is no CSP here. The API emits only JSON and is not a browsing context; the CSP that
 * matters is applied by the CloudFront response-headers policy on the **web** distribution
 * (`security-privacy.md` §4.3, P0-16).
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});
