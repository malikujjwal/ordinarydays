import type { ActivityUpdate } from '@od/shared/types';
import { describeApiFailure } from '@/lib/apiFailure';

/**
 * The parts of the Updates feed (P3-40) that web and native must agree on: the view contract
 * both adapters return, failure copy, and the feed's order. Each adapter owns only its own
 * storage (query cache vs SQLite) and transport.
 */

/** A not-yet-acknowledged entry, rendered at the head under a local identity. */
export interface PendingUpdate {
  readonly localId: string;
  readonly body: string;
}

export type ActivityUpdatesFailureAction = 'load' | 'post' | 'delete';

export interface ActivityUpdatesFailure {
  readonly action: ActivityUpdatesFailureAction;
  readonly message: string;
  readonly requestId?: string;
}

export interface ActivityUpdatesView {
  readonly updates: readonly ActivityUpdate[];
  readonly pending: readonly PendingUpdate[];
  /** `undefined` once the feed's ordinary pagination is exhausted. */
  readonly cursor: string | undefined;
  readonly isLoadingMore: boolean;
  readonly isPosting: boolean;
  readonly loadMore: () => void;
  readonly post: (body: string) => Promise<boolean>;
  readonly remove: (update: ActivityUpdate) => Promise<boolean>;
  readonly errorMessage: string | undefined;
  readonly errorRequestId: string | undefined;
  readonly errorAction: ActivityUpdatesFailureAction | undefined;
  /** Replays failed paging/deletion; post retry is owned by the draft-preserving composer. */
  readonly retryFailure: () => Promise<boolean>;
  readonly dismissError: () => void;
}

/** One stable empty page, so an absent embedded page never reads as a new head each render. */
export const EMPTY_UPDATES: readonly ActivityUpdate[] = [];

export function describeUpdatesFailure(
  error: unknown,
  action: ActivityUpdatesFailureAction,
): ActivityUpdatesFailure {
  const fallback =
    action === 'load'
      ? "Couldn't load older updates."
      : action === 'post'
        ? "Couldn't post this update."
        : "Couldn't delete this update.";
  return { action, ...describeApiFailure(error, fallback) };
}

/** Newest first; the id tiebreak keeps two same-instant entries in one stable order. */
export function newestFirst(entries: readonly ActivityUpdate[]): ActivityUpdate[] {
  return [...entries].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.updateId.localeCompare(a.updateId)
      : b.createdAt.localeCompare(a.createdAt),
  );
}

export function dedupe(entries: readonly ActivityUpdate[]): ActivityUpdate[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.updateId)) return false;
    seen.add(entry.updateId);
    return true;
  });
}
