import type { z } from 'zod';
import {
  type captureExtractInput,
  type captureLinkInput,
  type captureParseInput,
  parsedCapture,
} from '../../schemas/capture.js';
import { envelope } from '../../schemas/envelope.js';
import type { HttpClient } from '../http.js';

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

async function parseInto(
  client: HttpClient,
  path: string,
  body: { creationTarget: CreationTarget },
  signal?: AbortSignal,
): Promise<ParsedCapture> {
  const response = await client.request({
    method: 'POST',
    path,
    schema: parsedCaptureResponse,
    body,
    ...(signal === undefined ? {} : { signal }),
  });
  assertTargetEcho(body.creationTarget, response.data.creationTarget);
  return response.data;
}

/** `POST /v1/capture/parse` — free text into compatible fields of the chosen form. */
export function captureParse(
  client: HttpClient,
  input: CaptureParseInput,
  signal?: AbortSignal,
): Promise<ParsedCapture> {
  return parseInto(client, '/v1/capture/parse', input, signal);
}

/** `POST /v1/capture/extract` — an already-uploaded photo or screenshot. */
export function captureExtract(
  client: HttpClient,
  input: CaptureExtractInput,
  signal?: AbortSignal,
): Promise<ParsedCapture> {
  return parseInto(client, '/v1/capture/extract', input, signal);
}

/** `POST /v1/capture/link` — a pasted or shared URL. */
export function captureLink(
  client: HttpClient,
  input: CaptureLinkInput,
  signal?: AbortSignal,
): Promise<ParsedCapture> {
  return parseInto(client, '/v1/capture/link', input, signal);
}
