/**
 * Screen-lifetime is not upload-lifetime (P3-41).
 *
 * ADR-057 forbids photo bytes and a second general write queue in SQLite domain rows. This
 * journal is the existing pick-queue, held outside the hook so a remount can restore the
 * placeholder and Retry. Tests inject it; production keeps one process-wide map.
 */
export interface PendingAttachmentRecord<TUpload extends { readonly localId: string }> {
  readonly upload: TUpload;
  readonly bytes: Uint8Array;
}

export interface PendingAttachmentJournal<TUpload extends { readonly localId: string }> {
  save(ownerKey: string, record: PendingAttachmentRecord<TUpload>): void;
  load(ownerKey: string): readonly PendingAttachmentRecord<TUpload>[];
  remove(ownerKey: string, localId: string): void;
}

function emptyJournal<
  TUpload extends { readonly localId: string },
>(): PendingAttachmentJournal<TUpload> {
  const byOwner = new Map<string, Map<string, PendingAttachmentRecord<TUpload>>>();
  return {
    save(ownerKey, record) {
      const current =
        byOwner.get(ownerKey) ?? new Map<string, PendingAttachmentRecord<TUpload>>();
      current.set(record.upload.localId, record);
      byOwner.set(ownerKey, current);
    },
    load(ownerKey) {
      return [...(byOwner.get(ownerKey)?.values() ?? [])];
    },
    remove(ownerKey, localId) {
      byOwner.get(ownerKey)?.delete(localId);
    },
  };
}

export const pendingAttachmentJournal = emptyJournal();

export function createPendingAttachmentJournal<
  TUpload extends { readonly localId: string },
>(): PendingAttachmentJournal<TUpload> {
  return emptyJournal();
}
