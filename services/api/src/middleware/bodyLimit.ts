import { bodyLimit } from 'hono/body-limit';
import { AppError } from '../lib/errors.js';

/**
 * Chain entry 6. Rejects bodies over 256 KB.
 *
 * **Before any body parsing**, so an oversized body is never buffered into a JS object.
 * Parsing first and checking the size afterwards is the same check with the memory already
 * spent — and on a 1024 MB Lambda, a few concurrent 5 MB bodies is a real problem.
 *
 * 256 KB is `security-privacy.md` §4.1 rule 5. Attachments do not travel through here at
 * all: they go to S3 through a presigned `PUT`, capped separately at
 * `MAX_UPLOAD_BYTES` (10 MB).
 */
export const MAX_BODY_BYTES = 256 * 1024;

export const bodyLimitMiddleware = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    // Thrown rather than returned, so the one envelope in `errorHandler` formats it. A
    // second place that builds an error body is a second place for it to drift.
    throw new AppError('payload_too_large', 'The request body is too large.');
  },
});
