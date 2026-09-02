import type { UploadFetchLike } from '@od/shared/client';

/**
 * The binary transport behind `putToUploadUrl` (P3-24's injected seam, P3-41's owner).
 *
 * `XMLHttpRequest` rather than `fetch`, on every platform, for one reason: `fetch` has no
 * portable upload-progress event, and §P3-41 asks for one visible progress state as the bytes
 * leave the device. React Native and every browser ship `XMLHttpRequest` with `upload.onprogress`,
 * so this is the same few lines everywhere.
 *
 * **Exactly the headers it is given.** The presigned URL carries its own authorisation in the
 * signature; the API's bearer token never travels here (see `putToUploadUrl`'s note), and an
 * extra header is one S3 did not sign for.
 */
export const xhrUploadFetch: UploadFetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(init.method, url, true);
    for (const [name, value] of Object.entries(init.headers)) {
      request.setRequestHeader(name, value);
    }
    if (init.onProgress !== undefined) {
      const report = init.onProgress;
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) report(event.loaded / event.total);
      };
    }
    request.onload = () =>
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        text: () => Promise.resolve(request.responseText ?? ''),
      });
    request.onerror = () => reject(new TypeError('Network request failed'));
    request.onabort = () =>
      reject(new DOMException('The upload was aborted.', 'AbortError'));
    if (init.signal !== undefined) {
      if (init.signal.aborted) {
        request.abort();
        return;
      }
      init.signal.addEventListener('abort', () => request.abort(), { once: true });
    }
    // A fresh copy: some RN XHR bodies reject a view over a shared, offset buffer.
    request.send(init.body.slice().buffer);
  });
