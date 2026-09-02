import {
  confirmAttachment,
  putToUploadUrl,
  requestUploadUrl,
  type UploadFetchLike,
} from '@od/shared/client';
import type { Attachment, UploadContentType } from '@od/shared/types';
import { onlineManager } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { decodeBase64 } from '@/lib/base64';
import { isExpiredUploadUrl, type PickedImage, preCheck } from '@/lib/uploadPolicy';
import { xhrUploadFetch } from '@/lib/uploadTransport';
import { useToast } from '@/stores/toast';

/**
 * Pick an image, `PUT` it to the presigned URL, confirm, and show progress (P3-41) — the
 * client half of P3-21 and P3-22.
 *
 * ## The chain, and where it stops
 *
 * pre-check → `requestUploadUrl` → `putToUploadUrl` (progress) → `confirmAttachment`.
 *
 * With an `activityId` the chain runs to the end and the attachment is linked. On a
 * **creation form** no activity exists yet, so it stops after the upload: the collected ids
 * ride in `attachmentIds` on the eventual `POST /v1/activities`, where P3-22 confirms them
 * server-side. Either way the row appears the moment the image is picked and resolves when
 * its last step returns — one visible progress state, never a phantom.
 *
 * ## What is refused before the network
 *
 * A type outside the four, or more than 10 MB, is a validation message under the buttons —
 * `preCheck` runs on the decoded bytes, and no request is issued (the unit test holds a
 * fetch spy to that).
 *
 * ## The expired URL
 *
 * The presigned `PUT` lasts five minutes. A `PUT` the store rejects as expired silently
 * requests a fresh URL **once**; a second failure surfaces the standard error toast with
 * `Retry` (§5.3). Any other rejection — a `Content-Type` that contradicts the declaration,
 * a `429` from the upload-url route — is that toast straight away, with the envelope's own
 * message where there is one.
 *
 * ## Offline
 *
 * While the device is offline the row shows `Pending` and nothing is sent; the upload starts
 * when connectivity returns (§5.4 "Uploads: queued"). This is an in-memory queue for the
 * life of the screen, not the durable outbox: image bytes are not an intent the SQLite
 * outbox can carry, and ADR-057 froze the native projections. Recorded in the batch state.
 */

export type UploadStatus = 'queued' | 'uploading' | 'confirming' | 'done' | 'failed';

export interface AttachmentUpload {
  readonly localId: string;
  readonly uri: string;
  readonly contentType: UploadContentType;
  readonly byteSize: number;
  readonly status: UploadStatus;
  /** 0–1 while uploading. */
  readonly progress: number;
  /** Set once the upload landed; the confirm (or the create) links it. */
  readonly attachmentId?: string;
  /** The linked attachment, once confirmed against an activity. */
  readonly attachment?: Attachment;
  readonly error?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface AttachmentUploadController {
  readonly uploads: readonly AttachmentUpload[];
  /** The last pre-check refusal, shown under the buttons until the next pick. */
  readonly refusal: string | undefined;
  readonly pick: (source: 'camera' | 'library') => Promise<void>;
  readonly retry: (localId: string) => void;
  readonly remove: (localId: string) => void;
  /** An upload is queued, moving or confirming — a form must not save yet. */
  readonly busy: boolean;
  /** Every uploaded (and, with an activity, confirmed) id, in pick order. */
  readonly attachmentIds: readonly string[];
}

export type ImageSource = 'camera' | 'library';

/** Every effect the hook has, injectable so the unit tests hold a spy on each. */
export interface UploadDeps {
  readonly client: typeof apiClient;
  readonly uploadFetch: UploadFetchLike;
  readonly pickImage: (
    source: ImageSource,
  ) => Promise<PickedImage | 'cancelled' | 'denied'>;
  readonly readBytes: (image: PickedImage) => Promise<Uint8Array>;
  readonly isOnline: () => boolean;
  readonly subscribeOnline: (listener: (online: boolean) => void) => () => void;
  readonly newKey: () => string;
}

const UPLOAD_FAILED = "Couldn't upload that photo.";
const CAMERA_DENIED = 'Ordinary Days needs camera access to take a photo.';
const LIBRARY_DENIED = 'Ordinary Days needs photo access to pick an image.';

/**
 * `expo-image-picker` returns `canceled: true` rather than throwing when the user backs out,
 * and a cancel is a complete and correct outcome — no error, no message. `base64` is asked
 * for so the bytes arrive in one representation on every platform.
 */
async function pickWithExpo(
  source: ImageSource,
): Promise<PickedImage | 'cancelled' | 'denied'> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return 'denied';
  const options = { quality: 0.8, base64: true } as const;
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return 'cancelled';
  const asset = result.assets[0];
  if (asset === undefined) return 'cancelled';
  const bytes = asset.base64 == null ? undefined : decodeBase64(asset.base64);
  return {
    uri: asset.uri,
    mimeType: asset.mimeType ?? undefined,
    fileName: asset.fileName ?? undefined,
    byteSize: bytes?.byteLength ?? asset.fileSize ?? 0,
    ...(bytes === undefined ? {} : { bytes }),
  };
}

const defaultDeps: UploadDeps = {
  client: apiClient,
  uploadFetch: xhrUploadFetch,
  pickImage: pickWithExpo,
  readBytes: async (image) => {
    if (image.bytes !== undefined) return image.bytes;
    // No base64 came back (a picker that declined it): read the URI the platform gave.
    const response = await fetch(image.uri);
    return new Uint8Array(await response.arrayBuffer());
  },
  isOnline: () => onlineManager.isOnline(),
  subscribeOnline: (listener) => onlineManager.subscribe(listener),
  newKey: () => randomUUID(),
};

export function useAttachmentUpload(
  options: {
    readonly activityId?: string;
    readonly onConfirmed?: (attachment: Attachment) => void;
    readonly deps?: Partial<UploadDeps>;
  } = {},
): AttachmentUploadController {
  const deps = useMemo<UploadDeps>(
    () => ({ ...defaultDeps, ...options.deps }),
    // Callers pass a stable object (or none); the merge re-runs only when it changes.
    [options.deps],
  );
  const { activityId, onConfirmed } = options;
  const [uploads, setUploads] = useState<readonly AttachmentUpload[]>([]);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const bytesRef = useRef(new Map<string, Uint8Array>());
  const running = useRef(new Set<string>());
  const onConfirmedRef = useRef(onConfirmed);
  onConfirmedRef.current = onConfirmed;

  const patch = useCallback((localId: string, change: Partial<AttachmentUpload>) => {
    setUploads((current) =>
      current.map((upload) =>
        upload.localId === localId ? { ...upload, ...change } : upload,
      ),
    );
  }, []);

  const run = useCallback(
    async (upload: AttachmentUpload) => {
      const { localId } = upload;
      const bytes = bytesRef.current.get(localId);
      if (bytes === undefined || running.current.has(localId)) return;
      if (!deps.isOnline()) {
        patch(localId, { status: 'queued', progress: 0 });
        return;
      }
      running.current.add(localId);
      patch(localId, {
        status: 'uploading',
        progress: 0,
        error: undefined,
        requestId: undefined,
      });
      try {
        const declaration = {
          contentType: upload.contentType,
          byteSize: upload.byteSize,
        };
        const issue = () => requestUploadUrl(deps.client, declaration, deps.newKey());
        const onProgress = (fraction: number) => patch(localId, { progress: fraction });

        let issued = await issue();
        try {
          await putToUploadUrl(
            deps.uploadFetch,
            issued.uploadUrl,
            bytes,
            upload.contentType,
            onProgress,
          );
        } catch (error) {
          // Silently once (§P3-41 step 5). A second failure falls through to the toast.
          if (!isExpiredUploadUrl(error)) throw error;
          issued = await issue();
          await putToUploadUrl(
            deps.uploadFetch,
            issued.uploadUrl,
            bytes,
            upload.contentType,
            onProgress,
          );
        }

        if (activityId === undefined) {
          patch(localId, {
            status: 'done',
            progress: 1,
            attachmentId: issued.attachmentId,
          });
          return;
        }
        patch(localId, {
          status: 'confirming',
          progress: 1,
          attachmentId: issued.attachmentId,
        });
        const attachment = await confirmAttachment(
          deps.client,
          activityId,
          { attachmentId: issued.attachmentId },
          deps.newKey(),
        );
        patch(localId, { status: 'done', attachment });
        onConfirmedRef.current?.(attachment);
      } catch (error) {
        const failure = describeApiFailure(error, UPLOAD_FAILED);
        patch(localId, {
          status: 'failed',
          error: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        });
        useToast.getState().show({
          message: failure.message,
          tone: 'error',
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
          action: { label: 'Retry', onPress: () => retryRef.current(localId) },
        });
      } finally {
        running.current.delete(localId);
      }
    },
    [activityId, deps, patch],
  );

  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  const retry = useCallback(
    (localId: string) => {
      const upload = uploadsRef.current.find((entry) => entry.localId === localId);
      if (upload !== undefined) void run(upload);
    },
    [run],
  );
  const retryRef = useRef(retry);
  retryRef.current = retry;

  /** Back online: everything that was waiting starts, in pick order. */
  useEffect(
    () =>
      deps.subscribeOnline((online) => {
        if (!online) return;
        for (const upload of uploadsRef.current) {
          if (upload.status === 'queued') void run(upload);
        }
      }),
    [deps, run],
  );

  const pick = useCallback(
    async (source: ImageSource) => {
      setRefusal(undefined);
      const picked = await deps.pickImage(source);
      if (picked === 'cancelled') return;
      if (picked === 'denied') {
        setRefusal(source === 'camera' ? CAMERA_DENIED : LIBRARY_DENIED);
        return;
      }
      const bytes = await deps.readBytes(picked);
      const check = preCheck({ ...picked, byteSize: bytes.byteLength });
      if (!check.ok) {
        setRefusal(check.message);
        return;
      }
      const upload: AttachmentUpload = {
        localId: deps.newKey(),
        uri: picked.uri,
        contentType: check.contentType,
        byteSize: check.byteSize,
        status: 'queued',
        progress: 0,
      };
      bytesRef.current.set(upload.localId, bytes);
      setUploads((current) => [...current, upload]);
      uploadsRef.current = [...uploadsRef.current, upload];
      void run(upload);
    },
    [deps, run],
  );

  const remove = useCallback((localId: string) => {
    bytesRef.current.delete(localId);
    setUploads((current) => current.filter((upload) => upload.localId !== localId));
  }, []);

  return useMemo(
    () => ({
      uploads,
      refusal,
      pick,
      retry,
      remove,
      busy: uploads.some(
        (upload) => upload.status !== 'done' && upload.status !== 'failed',
      ),
      attachmentIds: uploads.flatMap((upload) =>
        upload.status === 'done' && upload.attachmentId !== undefined
          ? [upload.attachmentId]
          : [],
      ),
    }),
    [uploads, refusal, pick, retry, remove],
  );
}
