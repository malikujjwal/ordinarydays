import type { z } from 'zod';
import type { ErrorCode, ErrorDetail } from '../errors.js';
import { isAppErrorBody } from '../errors.js';

/**
 * The typed API client.
 *
 * It is the only place in the product that knows the wire is HTTP. Handlers on one side and
 * feature hooks on the other speak in domain objects; everything between — the envelope, the
 * headers, the retry policy, the error mapping — is here, once.
 *
 * Nothing in this file reads `process.env`, imports React, or touches a global other than
 * the documented fallbacks in {@link defaultRequestId}. Configuration arrives as arguments
 * from `apps/mobile/src/lib/apiClient.ts`, which is where Expo's `extra` is read
 * (`tech-stack.md` §5.2). That is why `strictResponses` is a field rather than a
 * `NODE_ENV` check.
 */

/** The global `fetch`, injected so tests can substitute a stub and RN can substitute its own. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Supplies the bearer token, or nothing when signed out.
 *
 * Returning `undefined` must produce **no** `Authorization` header at all, not an empty
 * one — an empty bearer is a 401 that looks like a server fault.
 */
export interface AuthTokenProvider {
  getToken(): Promise<string | undefined>;
  /** Stable app user id for authenticated-response cache isolation; never the token itself. */
  getIdentity(): Promise<string | undefined>;
}

/** A provider for the signed-out case and for Phase 0, where there is no auth yet. */
export const nullTokenProvider: AuthTokenProvider = {
  getToken: () => Promise.resolve(undefined),
  getIdentity: () => Promise.resolve(undefined),
};

/** Phase 2's local identity seam: authenticated locally, but still without a bearer token. */
export const localTokenProvider: AuthTokenProvider = {
  getToken: () => Promise.resolve(undefined),
  getIdentity: () => Promise.resolve('usr_local_dev'),
};

/** What the client reports when it does something the caller should know about but survive. */
export interface ClientWarning {
  message: string;
  path: string;
  requestId?: string;
  issues?: ErrorDetail[];
}

export interface HttpClientConfig {
  baseUrl: string;
  fetch: FetchLike;
  tokenProvider: AuthTokenProvider;
  /** IANA zone sent as `X-Client-Timezone`. */
  timezone: string;
  /** `ios/1.4.0` or `web/1.4.0`, sent as `X-Client-Version`. */
  clientVersion: string;
  /**
   * What to do when a response does not match its schema: throw, or warn and hand back what
   * arrived.
   *
   * `true` in dev and test, `false` in a shipped build. The asymmetry is deliberate and is
   * the whole point: during development a drifted contract must stop the build, but a server
   * that has added a field must never break an app already on someone's phone. A shipped
   * client that throws on an unknown field turns an additive, backwards-compatible deploy
   * into an outage.
   *
   * It is a required field with no default so that every caller states which side it is on.
   */
  strictResponses: boolean;
  /**
   * Injected so a retry test does not spend seconds sleeping. Defaults to real time.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can assert on a fixed correlation id. */
  newRequestId?: () => string;
  /** Where non-fatal problems go. Defaults to `console.warn`. */
  onWarning?: (warning: ClientWarning) => void;
}

/**
 * An error the API returned, as opposed to one the transport produced.
 *
 * It carries `status` because the client **observed** it. It does not carry the code → status
 * mapping, which lives in `services/api/src/lib/errors.ts` and is the server's business: the
 * client is told what happened, it does not decide.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string,
    readonly details?: ErrorDetail[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The transport failed before any response existed — no DNS, no socket, aeroplane mode. */
export class NetworkError extends Error {
  constructor(
    message: string,
    // `override` because `Error` already declares `cause`. Keeping the name rather than
    // inventing one means a logger that knows about `Error.cause` finds it.
    override readonly cause: unknown,
    /** Client-generated correlation id when this error came from an HTTP request. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

function withRequestId(
  cause: unknown,
  requestId: string,
  fallbackMessage: string,
): NetworkError {
  if (cause instanceof NetworkError) {
    if (cause.requestId !== undefined) return cause;
    return new NetworkError(cause.message, cause.cause, requestId);
  }
  return new NetworkError(fallbackMessage, cause, requestId);
}

/**
 * Whether an error is worth trying again. Exported because TanStack Query's retry predicate
 * uses it too (`tech-stack.md` §3.4), and one definition beats two that drift.
 *
 * `rate_limited` is deliberately **not** retryable. A 429 means the server has already
 * decided the caller is going too fast; retrying it automatically is how a client turns its
 * own rate limit into a sustained one. It carries `retryAfterSeconds` so the UI can offer
 * the retry as a decision instead.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) return error.status >= 500;
  return false;
}

/** Retries after the first attempt, so at most four requests leave the device. */
export const MAX_RETRIES = 3;
export const CLIENT_REQUEST_TIMEOUT_MS = 10_000;

const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 2_000;

interface ManagedRequestSignal {
  readonly signal: AbortSignal;
  readonly abortError: (cause?: unknown) => Error;
  readonly dispose: () => void;
}

function requestAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The request timed out.');
  error.name = 'AbortError';
  return error;
}

/**
 * Bounds work that cannot consume an AbortSignal itself, notably authentication and retry
 * backoff. The losing promise keeps its own lifecycle, but it always has rejection handlers
 * attached, so a late failure cannot become an unhandled rejection after the request retires.
 */
function withinRequestDeadline<T>(
  work: Promise<T>,
  requestSignal: ManagedRequestSignal,
): Promise<T> {
  const { signal } = requestSignal;
  if (signal.aborted) return Promise.reject(requestSignal.abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(requestSignal.abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One deadline for the whole logical request, including retries.
 *
 * Browsers and Node provide the standard static helpers. React Native 0.81 installs
 * `abort-controller@3`, whose `AbortSignal` has neither `timeout` nor `any`, so the native
 * fallback builds the same semantics from the controller API it does provide. The disposer
 * matters on that path: a successful request must not leave a ten-second timer or listeners
 * attached to a caller-owned signal.
 */
function managedRequestSignal(
  caller: AbortSignal | undefined,
  requestId: string,
): ManagedRequestSignal {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  let deadline: AbortSignal;
  if (typeof AbortSignal.timeout === 'function') {
    deadline = AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS);
  } else {
    const controller = new AbortController();
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, CLIENT_REQUEST_TIMEOUT_MS);
    deadline = controller.signal;
  }

  const markDeadlineExpired = () => {
    deadlineExpired = true;
  };
  deadline.addEventListener('abort', markDeadlineExpired, { once: true });

  const abortError = (cause?: unknown): Error => {
    // A caller-owned cancellation means "stop" and must never become a Retry prompt. Only
    // the deadline created in this function is a transient transport failure.
    if (caller?.aborted === true) return requestAbortReason(caller);
    if (deadlineExpired || deadline.aborted) {
      return new NetworkError(
        'The request timed out.',
        cause ?? deadline.reason,
        requestId,
      );
    }
    return requestAbortReason(caller ?? deadline);
  };

  const clearDeadline = () => {
    deadline.removeEventListener('abort', markDeadlineExpired);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  if (caller === undefined) {
    return { signal: deadline, abortError, dispose: clearDeadline };
  }
  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([caller, deadline]),
      abortError,
      dispose: clearDeadline,
    };
  }

  const combined = new AbortController();
  const abort = () => combined.abort();
  if (caller.aborted || deadline.aborted) abort();
  else {
    caller.addEventListener('abort', abort, { once: true });
    deadline.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: combined.signal,
    abortError,
    dispose: () => {
      caller.removeEventListener('abort', abort);
      deadline.removeEventListener('abort', abort);
      clearDeadline();
    },
  };
}

/**
 * Full-jitter exponential backoff: a delay drawn uniformly from `[0, min(cap, base·2^n))`.
 *
 * Full jitter rather than a fixed ramp because the failure this protects against is
 * correlated — an API that just returned 503 is about to be hit by every client at once, and
 * a deterministic backoff schedules them all to return together. Exported so its shape can
 * be asserted without waiting for real time to pass.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A correlation id in the API's own format (`services/api/src/middleware/requestId.ts`).
 *
 * `crypto.randomUUID` is present on web and on Node, and absent on Hermes without a
 * polyfill, so the fallback is not theoretical — it is the React Native path. The fallback
 * is **not** cryptographic and must never be used for anything that needs unguessability;
 * an idempotency key comes from `expo-crypto` at the app layer for exactly that reason.
 */
function defaultRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `req_${uuid.replaceAll('-', '')}`;

  let hex = '';
  for (let i = 0; i < 4; i += 1) {
    hex += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return `req_${hex}`;
}

export interface RequestOptions<S extends z.ZodType> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Absolute path including the `/v1` prefix, e.g. `/v1/health`. */
  path: string;
  /** The **envelope** schema for the endpoint, so `meta` is validated with `data`. */
  schema: S;
  body?: unknown;
  /** Request headers, including `Idempotency-Key` on replay-protected mutations. */
  headers?: Record<string, string>;
  /** The server stores and replays this mutation's exact response under its required key. */
  replayProtected?: boolean;
  signal?: AbortSignal;
}

export interface HttpClient {
  request<S extends z.ZodType>(options: RequestOptions<S>): Promise<z.infer<S>>;
  /** Drops every conditional-GET body/ETag pair without replacing this client instance. */
  clearCache(): void;
}

interface CachedGetResponse {
  etag: string;
  body: unknown;
}

/**
 * Whether this request may be sent twice.
 *
 * `GET` is safe by definition. A mutation is safe only when its endpoint explicitly declares
 * server-side exact-response replay and supplies the key that addresses that receipt. Header
 * presence is not the declaration: an ordinary PATCH may carry a cross-cutting key that its
 * route ignores, and retrying it would turn a committed write with a lost response into a
 * misleading `409`.
 */
function isRetryableRequest(
  method: string,
  replayProtected: boolean,
  headers: Record<string, string>,
): boolean {
  if (method === 'GET') return true;
  if (method !== 'POST' && method !== 'PATCH') return false;
  return (
    replayProtected &&
    Object.keys(headers).some((header) => header.toLowerCase() === 'idempotency-key')
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Turns a non-2xx response into an `ApiError`.
 *
 * A body that is not the documented envelope is not a contract violation to shout about —
 * it is what an API Gateway timeout, a CloudFront error page or a proxy produces, and none
 * of those know about `{ error }`. Those become `internal` with the observed status, so the
 * caller still gets one error type to handle.
 */
function toApiError(
  status: number,
  body: unknown,
  requestId: string,
  retryAfter?: number,
) {
  if (isAppErrorBody(body)) {
    const { code, message, details, requestId: serverRequestId } = body.error;
    return new ApiError(code, message, status, serverRequestId, details, retryAfter);
  }
  return new ApiError(
    status === 429 ? 'rate_limited' : 'internal',
    'The server returned an unexpected response.',
    status,
    requestId,
    undefined,
    retryAfter,
  );
}

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const sleep = config.sleep ?? realSleep;
  const newRequestId = config.newRequestId ?? defaultRequestId;
  const getCache = new Map<string, CachedGetResponse>();
  const warn =
    config.onWarning ??
    ((warning: ClientWarning) => {
      console.warn(`[od] ${warning.message}`, warning);
    });

  function parseResponse<S extends z.ZodType>(
    options: RequestOptions<S>,
    body: unknown,
    requestId: string,
  ): z.infer<S> {
    const parsed = options.schema.safeParse(body);
    if (parsed.success) return parsed.data as z.infer<S>;

    const issues: ErrorDetail[] = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    if (config.strictResponses) {
      const error = new Error(
        `Response from ${options.path} did not match its schema: ${issues
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}`,
      );
      error.name = 'ResponseValidationError';
      throw error;
    }

    warn({
      message: 'Response did not match its schema; using it as received.',
      path: options.path,
      requestId,
      issues,
    });
    // Deliberate: a shipped app returns what arrived rather than failing on a field the
    // server added. The cast is the honest expression of that — this value is unvalidated.
    return body as z.infer<S>;
  }

  async function send<S extends z.ZodType>(
    options: RequestOptions<S>,
    requestId: string,
    token: string | undefined,
    identity: string | undefined,
  ): Promise<z.infer<S>> {
    const baseHeaders: Record<string, string> = {
      Accept: 'application/json',
      'X-Request-Id': requestId,
      'X-Client-Timezone': config.timezone,
      'X-Client-Version': config.clientVersion,
      ...options.headers,
    };
    // No header at all when there is no token. An empty bearer reads as a server fault.
    if (token !== undefined && token !== '')
      baseHeaders.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) {
      baseHeaders['Content-Type'] = 'application/json; charset=utf-8';
    }

    const cacheKey =
      options.method === 'GET' && identity !== undefined
        ? JSON.stringify([identity, options.path])
        : undefined;
    const cached = cacheKey === undefined ? undefined : getCache.get(cacheKey);

    const fetchOnce = async (conditional: CachedGetResponse | undefined) => {
      const headers = { ...baseHeaders };
      // Conditional GET ownership stays here. In particular, the one recovery request after
      // an unpaired 304 must be unconditional even if a caller supplied the header manually.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'if-none-match') delete headers[name];
      }
      if (conditional !== undefined) headers['If-None-Match'] = conditional.etag;

      try {
        return await config.fetch(`${config.baseUrl}${options.path}`, {
          method: options.method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        // An abort is the caller's own decision and must surface as itself, not as a network
        // fault the client will then retry three times.
        if (cause instanceof Error && cause.name === 'AbortError') throw cause;
        throw new NetworkError('The request could not be sent.', cause, requestId);
      }
    };

    let response = await fetchOnce(cached);

    if (response.status === 304) {
      const paired = cacheKey === undefined ? undefined : getCache.get(cacheKey);
      if (paired !== undefined && paired === cached) {
        // A 304 has no body by definition. Re-validate the paired body, but never ask the
        // response to parse bytes that do not exist.
        return parseResponse(options, paired.body, requestId);
      }

      // A proxy may answer 304 after the in-memory pair was cleared. Retry exactly once
      // without a condition so the response is self-contained again.
      response = await fetchOnce(undefined);
      if (response.status === 304) {
        throw toApiError(response.status, undefined, requestId);
      }
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (cause) {
      // Reading the body is still transport work: the socket may fail after the headers have
      // arrived. The request loop decides whether an aborted managed signal belongs to the
      // caller or to the client deadline; every other stream failure is retryable and keeps
      // the correlation id already sent in the request headers.
      if (options.signal?.aborted === true) throw cause;
      throw withRequestId(cause, requestId, 'The response could not be read.');
    }
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      throw toApiError(
        response.status,
        body,
        requestId,
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }

    const parsed = parseResponse(options, body, requestId);

    if (cacheKey !== undefined) {
      const etag = response.headers.get('ETag');
      if (etag === null || etag === '') getCache.delete(cacheKey);
      else getCache.set(cacheKey, { etag, body: parsed });
    }

    return parsed;
  }

  return {
    clearCache: () => getCache.clear(),
    async request<S extends z.ZodType>(options: RequestOptions<S>): Promise<z.infer<S>> {
      // One id for the whole call, reused across retries, because the server honours an
      // inbound `X-Request-Id` — so a retry and its original correlate in the logs rather
      // than looking like two unrelated requests.
      const requestId = newRequestId();
      const managedSignal = managedRequestSignal(options.signal, requestId);
      const { signal } = managedSignal;
      const boundedOptions: RequestOptions<S> = { ...options, signal };
      const retryable = isRetryableRequest(
        options.method,
        options.replayProtected === true,
        options.headers ?? {},
      );

      /**
       * **One token decision per request, whatever the transport does underneath.**
       *
       * Read here rather than inside `send`, so a retried request reuses the token it
       * started with instead of asking again on every attempt. Corrected in P1-20: the
       * struck-through P1-19 subsection specifies "`getToken` is called exactly once per
       * request including on a retried `GET`", and it was being called once per attempt.
       *
       * Re-reading per attempt bought nothing and cost predictability. `isRetryable` only
       * retries `5xx` and network failures — a `401` is never retried — so a fresh token
       * between attempts could not have recovered an expired one anyway; that is the
       * one-retry-on-`401` rule, which is Phase 4's and deliberately absent here. What it
       * did do is make the number of provider calls depend on transport luck, which is the
       * last thing a seam with a single-flight refresh behind it should expose.
       */
      try {
        let token: string | undefined;
        let identity: string | undefined;
        try {
          [token, identity] = await withinRequestDeadline(
            Promise.all([
              config.tokenProvider.getToken(),
              config.tokenProvider.getIdentity(),
            ]),
            managedSignal,
          );
        } catch (cause) {
          if (signal.aborted) throw managedSignal.abortError(cause);
          throw withRequestId(cause, requestId, 'Authentication could not be completed.');
        }

        let attempt = 0;
        for (;;) {
          try {
            return await withinRequestDeadline(
              send(boundedOptions, requestId, token, identity),
              managedSignal,
            );
          } catch (error) {
            // The ten-second client deadline is for the whole request, not each retry. Once
            // it fires, retrying with a fresh ten seconds would put a durable intent back into
            // the exact unbounded in-flight state the deadline exists to prevent.
            if (signal.aborted) throw managedSignal.abortError(error);
            if (!retryable || attempt >= MAX_RETRIES || !isRetryable(error)) throw error;
            try {
              await withinRequestDeadline(sleep(backoffDelayMs(attempt)), managedSignal);
            } catch (cause) {
              if (signal.aborted) throw managedSignal.abortError(cause);
              throw withRequestId(
                cause,
                requestId,
                'The request retry could not be scheduled.',
              );
            }
            attempt += 1;
          }
        }
      } finally {
        managedSignal.dispose();
      }
    },
  };
}
