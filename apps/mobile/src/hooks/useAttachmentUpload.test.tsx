import type { HttpClient } from '@od/shared/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPendingAttachmentJournal } from '@/lib/pendingAttachmentUploads';
import type { PickedImage } from '@/lib/uploadPolicy';
import { useToast } from '@/stores/toast';
import { type UploadDeps, useAttachmentUpload } from './useAttachmentUpload';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));
// The real picker is a native module; every test here injects `pickImage` instead.
vi.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));

/**
 * The upload chain (P3-41), with every effect held by a spy: the API client, the presigned
 * `PUT` transport, the picker, the bytes and connectivity. What the tests read is *which*
 * calls were made, in what order, and what the rows say meanwhile.
 */

const ATT = 'att_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const ATT_TWO = 'att_01J8XKQ2M4N5P6R7S8T9V0W1A2';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const jpeg = (byteSize = 4096): PickedImage => ({
  uri: 'file:///tmp/photo.jpg',
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  byteSize,
  bytes: new Uint8Array(byteSize),
});

interface Harness {
  deps: UploadDeps;
  request: ReturnType<typeof vi.fn>;
  uploadFetch: ReturnType<typeof vi.fn>;
  online: { value: boolean; listeners: Set<(online: boolean) => void> };
  issued: string[];
}

function harness(
  overrides: {
    picked?: PickedImage | 'cancelled' | 'denied';
    putResponses?: Array<{ ok: boolean; status: number; body?: string }>;
    online?: boolean;
  } = {},
): Harness {
  const issued = [ATT, ATT_TWO];
  const request = vi.fn(
    async (input: { method: string; path: string; body?: unknown }) => {
      if (input.path === '/v1/attachments/upload-url') {
        const attachmentId = issued.shift() ?? ATT_TWO;
        return {
          data: {
            attachmentId,
            uploadUrl: `https://store.local/tmp/${attachmentId}?sig`,
            key: `tmp/${attachmentId}.jpg`,
            expiresAt: '2026-09-01T00:05:00.000Z',
          },
        };
      }
      if (input.path === `/v1/activities/${ACT}/attachments`) {
        const { attachmentId } = input.body as { attachmentId: string };
        return {
          data: {
            attachmentId,
            activityId: ACT,
            key: `u/usr/${attachmentId}.jpg`,
            contentType: 'image/jpeg',
            byteSize: 4096,
            createdAt: '2026-09-01T00:00:00.000Z',
            schemaVersion: 1,
          },
        };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    },
  );
  const putResponses = [...(overrides.putResponses ?? [{ ok: true, status: 200 }])];
  const uploadFetch = vi.fn(
    async (
      _url: string,
      init: { onProgress?: (fraction: number) => void; body: Uint8Array },
    ) => {
      init.onProgress?.(0.5);
      const response = putResponses.shift() ?? { ok: true, status: 200 };
      return {
        ok: response.ok,
        status: response.status,
        text: () => Promise.resolve(response.body ?? ''),
      };
    },
  );
  const online = {
    value: overrides.online ?? true,
    listeners: new Set<(o: boolean) => void>(),
  };
  let keys = 0;
  const deps: UploadDeps = {
    client: { request } as unknown as HttpClient,
    uploadFetch: uploadFetch as unknown as UploadDeps['uploadFetch'],
    pickImage: vi.fn(async () => overrides.picked ?? jpeg()),
    readBytes: async (image) => image.bytes ?? new Uint8Array(image.byteSize),
    isOnline: () => online.value,
    subscribeOnline: (listener) => {
      online.listeners.add(listener);
      return () => online.listeners.delete(listener);
    },
    newKey: () => {
      keys += 1;
      return `key-${keys}`;
    },
    journal: createPendingAttachmentJournal(),
  };
  return { deps, request, uploadFetch, online, issued };
}

beforeEach(() => {
  useToast.setState({ current: undefined });
  vi.stubGlobal('fetch', vi.fn());
});

describe('pre-checks refuse before any network call', () => {
  it('refuses an 11 MB image with no request issued', async () => {
    const h = harness({ picked: jpeg(11 * 1024 * 1024) });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));

    expect(result.current.refusal).toBe('Photos must be under 10 MB.');
    expect(result.current.uploads).toEqual([]);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.uploadFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a PDF with no request issued', async () => {
    const h = harness({
      picked: { ...jpeg(), mimeType: 'application/pdf', fileName: 'menu.pdf' },
    });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));

    expect(result.current.refusal).toBe('Photos must be JPEG, PNG, HEIC or WebP.');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.uploadFetch).not.toHaveBeenCalled();
  });

  it('treats a cancelled picker as nothing happening', async () => {
    const h = harness({ picked: 'cancelled' });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));
    await act(() => result.current.pick('library'));
    expect(result.current.refusal).toBeUndefined();
    expect(result.current.uploads).toEqual([]);
  });
});

describe('the chain', () => {
  /** On a creation form the chain stops after the upload; the id rides on the create. */
  it('uploads and collects the id when there is no activity yet', async () => {
    const h = harness();
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/v1/attachments/upload-url',
      body: { contentType: 'image/jpeg', byteSize: 4096 },
      headers: { 'Idempotency-Key': 'key-2' },
    });
    // The PUT carries exactly the declared type and exactly the declared bytes.
    expect(h.uploadFetch).toHaveBeenCalledTimes(1);
    expect(h.uploadFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(
      (h.uploadFetch.mock.calls[0]?.[1] as { body: Uint8Array } | undefined)?.body
        .byteLength,
    ).toBe(4096);
    expect(result.current.attachmentIds).toEqual([ATT]);
    expect(result.current.busy).toBe(false);
  });

  it('confirms against the activity and reports the linked attachment', async () => {
    const h = harness();
    const onConfirmed = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUpload({ activityId: ACT, onConfirmed, deps: h.deps }),
    );

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));

    const paths = h.request.mock.calls.map((call) => (call[0] as { path: string }).path);
    expect(paths).toEqual([
      '/v1/attachments/upload-url',
      `/v1/activities/${ACT}/attachments`,
    ]);
    expect(h.request.mock.calls[1]?.[0]).toMatchObject({ body: { attachmentId: ATT } });
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: ATT }),
    );
    expect(result.current.uploads[0]?.attachment?.key).toBe(`u/usr/${ATT}.jpg`);
  });

  it('shows progress while the bytes leave', async () => {
    const h = harness();
    let resolvePut: (() => void) | undefined;
    h.uploadFetch.mockImplementationOnce(
      (_url: string, init: { onProgress?: (fraction: number) => void }) =>
        new Promise((resolve) => {
          init.onProgress?.(0.4);
          resolvePut = () =>
            resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
        }),
    );
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.progress).toBe(0.4));
    expect(result.current.uploads[0]?.status).toBe('uploading');
    expect(result.current.busy).toBe(true);

    await act(async () => {
      resolvePut?.();
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));
  });
});

describe('the expired URL', () => {
  const expired = {
    ok: false,
    status: 403,
    body: '<Message>Request has expired</Message>',
  };

  it('silently requests a fresh URL exactly once, then succeeds', async () => {
    const h = harness({ putResponses: [expired, { ok: true, status: 200 }] });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));

    const urlRequests = h.request.mock.calls.filter(
      (call) => (call[0] as { path: string }).path === '/v1/attachments/upload-url',
    );
    expect(urlRequests).toHaveLength(2);
    expect(h.uploadFetch).toHaveBeenCalledTimes(2);
    // The second URL is the one that landed, so its id is the one collected.
    expect(result.current.attachmentIds).toEqual([ATT_TWO]);
    expect(useToast.getState().current).toBeUndefined();
  });

  it('re-requests once and then surfaces the error toast with Retry', async () => {
    const h = harness({ putResponses: [expired, expired] });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('failed'));

    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.uploadFetch).toHaveBeenCalledTimes(2);
    expect(result.current.uploads[0]?.error).toBe("Couldn't upload that photo.");
    expect(useToast.getState().current).toMatchObject({
      message: "Couldn't upload that photo.",
      tone: 'error',
      action: { label: 'Retry' },
    });
    expect(result.current.attachmentIds).toEqual([]);
  });

  /** A content-type mismatch is a store rejection, surfaced at once — never a silent re-request. */
  it('does not re-request for a rejection that is not an expiry', async () => {
    const h = harness({
      putResponses: [{ ok: false, status: 403, body: 'SignatureDoesNotMatch' }],
    });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('failed'));

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.uploadFetch).toHaveBeenCalledTimes(1);
  });

  it('Retry runs the whole chain again from a fresh URL', async () => {
    const h = harness({ putResponses: [expired, expired, { ok: true, status: 200 }] });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));
    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('failed'));

    const localId = result.current.uploads[0]?.localId ?? '';
    act(() => result.current.retry(localId));
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));
    expect(h.request).toHaveBeenCalledTimes(3);
  });
});

describe('offline', () => {
  it('queues the row as Pending and starts it when connectivity returns', async () => {
    const h = harness({ online: false });
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));

    await act(() => result.current.pick('library'));

    expect(result.current.uploads[0]?.status).toBe('queued');
    expect(result.current.busy).toBe(true);
    expect(h.request).not.toHaveBeenCalled();

    h.online.value = true;
    act(() => {
      for (const listener of h.online.listeners) listener(true);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe('done'));
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe('remount', () => {
  it('restores a pending placeholder and Retry after the screen unmounts', async () => {
    const h = harness({ online: false });
    const first = renderHook(() =>
      useAttachmentUpload({ activityId: ACT, deps: h.deps }),
    );
    await act(() => first.result.current.pick('library'));
    expect(first.result.current.uploads[0]?.status).toBe('queued');
    first.unmount();

    const second = renderHook(() =>
      useAttachmentUpload({ activityId: ACT, deps: h.deps }),
    );
    await waitFor(() => expect(second.result.current.uploads).toHaveLength(1));
    expect(second.result.current.uploads[0]).toMatchObject({
      status: 'queued',
      uri: 'file:///tmp/photo.jpg',
    });

    h.online.value = true;
    act(() =>
      second.result.current.retry(second.result.current.uploads[0]?.localId ?? ''),
    );
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe('done'));
  });
});

describe('remove', () => {
  it('drops a row and its id from what a save would carry', async () => {
    const h = harness();
    const { result } = renderHook(() => useAttachmentUpload({ deps: h.deps }));
    await act(() => result.current.pick('library'));
    await waitFor(() => expect(result.current.attachmentIds).toEqual([ATT]));

    act(() => result.current.remove(result.current.uploads[0]?.localId ?? ''));

    expect(result.current.uploads).toEqual([]);
    expect(result.current.attachmentIds).toEqual([]);
  });
});
