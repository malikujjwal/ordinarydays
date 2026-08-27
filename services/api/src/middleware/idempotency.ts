import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import {
  type CleanupRef,
  IdempotencyRaceError,
  retryableIdempotencyError,
} from '../lib/idempotency.js';
import { loadReceipt } from '../repositories/idempotencyRepository.js';
import { ROUTE_REGISTRY, type RouteEntry } from './routeRegistry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entryFor(
  registry: readonly RouteEntry[],
  matched: readonly { method: string; path: string }[] | undefined,
  requestMethod: string,
): RouteEntry | undefined {
  const route = matched?.find((candidate) => candidate.method === requestMethod);
  if (route === undefined) return undefined;
  return registry.find(
    (entry) => entry.method === route.method && entry.pattern === route.path,
  );
}

export interface IdempotencyOptions {
  readonly registry?: readonly RouteEntry[];
  readonly now?: () => number;
  readonly replayReads?: number;
  readonly wait?: (attempt: number) => Promise<void>;
  readonly drainCleanup?: (ref: CleanupRef) => Promise<void>;
}

export function createIdempotency(options: IdempotencyOptions = {}) {
  const registry = options.registry ?? ROUTE_REGISTRY;
  const now = options.now ?? (() => Date.now());
  const replayReads = options.replayReads ?? 4;
  const wait =
    options.wait ??
    ((attempt: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, 5 * 2 ** attempt)));

  async function replay(userId: string, key: string): Promise<Response | undefined> {
    const record = await loadReceipt(userId, key);
    if (record === undefined) return undefined;
    if (record.cleanupRef !== undefined) {
      if (options.drainCleanup === undefined) throw retryableIdempotencyError();
      try {
        await options.drainCleanup(record.cleanupRef);
      } catch (error) {
        throw retryableIdempotencyError(error);
      }
    }
    return new Response(record.body, {
      status: record.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const entry = entryFor(registry, c.req.matchedRoutes, c.req.method);
    if (entry?.mutates !== true) return next();

    const key = c.req.header('Idempotency-Key');
    if (key === undefined || !UUID.test(key)) {
      throw new AppError(
        'validation_failed',
        'This request needs an Idempotency-Key header containing a UUID.',
        [{ path: 'Idempotency-Key', message: 'Required, and must be a UUID.' }],
      );
    }

    const userId = c.get('userId');
    if (userId === undefined) return next();
    const stored = await replay(userId, key);
    if (stored !== undefined) return stored;

    c.set('idempotencyKey', key);
    c.set('idempotencyRoute', `${c.req.method} ${entry.pattern}`);
    c.set('idempotencyNowMs', now());

    const recoverRace = async (error: Error): Promise<Response> => {
      for (let attempt = 0; attempt < replayReads; attempt += 1) {
        const winner = await replay(userId, key);
        if (winner !== undefined) return winner;
        await wait(attempt);
      }
      throw retryableIdempotencyError(error);
    };

    try {
      await next();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== IdempotencyRaceError.name)
        throw error;
      return recoverRace(error);
    }

    // Hono records downstream handler failures on the context after its error boundary has
    // formatted them. Recover the typed transaction race here and replace that provisional
    // response with the winner's receipt.
    if (c.error?.name === IdempotencyRaceError.name) {
      const recovered = await recoverRace(c.error);
      c.error = undefined;
      c.res = recovered;
      return recovered;
    }
  });
}

export const idempotency = createIdempotency();
