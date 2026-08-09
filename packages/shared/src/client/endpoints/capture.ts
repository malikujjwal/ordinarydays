import type { z } from 'zod';
import {
  type captureExtractInput,
  type captureLinkInput,
  type captureParseInput,
  parsedCapture,
} from '../../schemas/capture.js';
import { envelope } from '../../schemas/envelope.js';
import { ApiError, type HttpClient } from '../http.js';

/**
 * The three `/v1/capture/*` endpoint functions (`api-contract.md` §2.11, `ai-capture.md`).
 *
 * **These return `501 not_implemented` until Phase 8** and the client is written against them
 * anyway (P1-18, P1-20). Sending the real request body for seven phases is the point: Phase 8
 * swaps a handler and discovers nothing about the client, because the client has been sending
 * the right shape all along.
 *
 * Every input carries `creationTarget` as a **required** parameter, mirroring the schema.
 * Capture fills fields inside a destination the user already chose; it never chooses one. The
 * response's `creationTarget` is an echo, and {@link assertTargetEcho} below is the check that
 * would catch a provider that decided to be helpful.
 */

export const parsedCaptureResponse = envelope(parsedCapture);

export type ParsedCapture = z.infer<typeof parsedCapture>;
export type CreationTarget = ParsedCapture['creationTarget'];
export type CaptureParseInput = z.infer<typeof captureParseInput>;
export type CaptureExtractInput = z.infer<typeof captureExtractInput>;
export type CaptureLinkInput = z.infer<typeof captureLinkInput>;

/**
 * Rejects a response whose target is not the one that was sent.
 *
 * A structural defence, not a formality: the target is the single field a compromised or
 * over-eager model could use to redirect a write, and a mismatch means the result is
 * discarded rather than reconciled. There is no "trust the server's copy" branch, and adding
 * one would undo `security-privacy.md` §1 row 7.
 */
export function assertTargetEcho(sent: CreationTarget, received: CreationTarget): void {
  if (JSON.stringify(sent) !== JSON.stringify(received)) {
    throw new Error(
      'The capture response named a different destination from the one requested.',
    );
  }
}

/**
 * What a capture call produced — **an outcome, not a value or a throw**.
 *
 * `unavailable` is a first-class result rather than an error, because until Phase 8 *every*
 * capture endpoint returns `501` and the product has to be complete and pleasant without any
 * of it (`ai-capture.md` §6.2). A caller branches on this; it does not catch.
 *
 * That distinction is the whole reason this type exists. A thrown `ApiError` would put the
 * normal Phase 1–7 path down an error branch, and error branches get error treatment — a
 * toast, a red banner, a `Try again` — when what §6.1 asks for on the text path is *nothing
 * at all*: "field suggestions simply never appear".
 *
 * **Only `not_implemented` becomes an outcome.** A `500`, a `429` or a network failure still
 * throws, because those are real failures with their own rows in §6.1 and their own copy.
 * Swallowing them here would make a broken model provider indistinguishable from a feature
 * that has not shipped.
 */
export type CaptureOutcome =
  | { readonly status: 'parsed'; readonly capture: ParsedCapture }
  /** The endpoint is a stub. The caller shows the manual form and says nothing on the text path. */
  | { readonly status: 'unavailable' };

async function parseInto(
  client: HttpClient,
  path: string,
  body: { creationTarget: CreationTarget },
  signal?: AbortSignal,
): Promise<CaptureOutcome> {
  let response: Awaited<ReturnType<typeof client.request<typeof parsedCaptureResponse>>>;

  try {
    response = await client.request({
      method: 'POST',
      path,
      schema: parsedCaptureResponse,
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_implemented') {
      return { status: 'unavailable' };
    }
    throw error;
  }

  /**
   * Still asserted on the success path, and deliberately **not** softened into an outcome:
   * a response naming a different destination is a structural failure, not a degraded one,
   * and there is no "trust the server's copy" branch (`security-privacy.md` §1 row 7).
   */
  assertTargetEcho(body.creationTarget, response.data.creationTarget);
  return { status: 'parsed', capture: response.data };
}

/** `POST /v1/capture/parse` — free text into compatible fields of the chosen form. */
export function captureParse(
  client: HttpClient,
  input: CaptureParseInput,
  signal?: AbortSignal,
): Promise<CaptureOutcome> {
  return parseInto(client, '/v1/capture/parse', input, signal);
}

/** `POST /v1/capture/extract` — an already-uploaded photo or screenshot. */
export function captureExtract(
  client: HttpClient,
  input: CaptureExtractInput,
  signal?: AbortSignal,
): Promise<CaptureOutcome> {
  return parseInto(client, '/v1/capture/extract', input, signal);
}

/** `POST /v1/capture/link` — a pasted or shared URL. */
export function captureLink(
  client: HttpClient,
  input: CaptureLinkInput,
  signal?: AbortSignal,
): Promise<CaptureOutcome> {
  return parseInto(client, '/v1/capture/link', input, signal);
}
