/**
 * The upload half of attachments (`api-contract.md` §2.6).
 *
 * Re-exported from the schema rather than declared twice: `CLAUDE.md` requires one definition
 * per shape, and a hand-written interface beside a Zod object is how the two drift.
 *
 * `Attachment` — the stored `ACT#<id>` row — is P3-22's, and `PendingUpload` is deliberately
 * absent: it is internal cross-store confirmation state (`data-model.md` §4.3c) that the
 * client never sees, and it lives beside the repository that writes it.
 */
export type {
  RequestUploadUrlInput,
  RequestUploadUrlResult,
  UploadContentType,
} from '../schemas/attachment.js';
