import { cors } from 'hono/cors';
import { config } from '../lib/config.js';

/**
 * Chain entry 4. Allows the configured web origins and nothing else.
 *
 * Sits before anything that could reject a request, because a browser preflight carries no
 * credentials — if auth ran first, every cross-origin request would fail as unauthenticated
 * at the `OPTIONS` and the real request would never be sent.
 *
 * The origin list is an allow-list, never `*`: `credentials: true` with a wildcard origin
 * is rejected by browsers anyway, and silently reflecting the request origin would defeat
 * the point.
 */

/**
 * On a laptop the app is served by Metro on `:8081`, and P0-22 also loads it on the
 * machine's **LAN address** so a physical iPhone can reach it. That address changes with
 * the network, so local dev matches the private ranges by pattern rather than by a
 * hard-coded IP. This applies to `local` only — `dev` and `prod` use `cfg.webOrigins`.
 */
const LAN_ORIGIN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$/;

export function isAllowedOrigin(origin: string): boolean {
  if (config.WEB_ORIGINS.includes(origin)) return true;
  return config.STAGE === 'local' && LAN_ORIGIN.test(origin);
}

export const corsMiddleware = cors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  credentials: true,
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-Client-Timezone',
    'X-Client-Version',
    'Idempotency-Key',
    'If-Match',
  ],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['X-Request-Id', 'Retry-After'],
  maxAge: 600,
});
