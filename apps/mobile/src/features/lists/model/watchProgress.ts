import type { PatchListItemInput } from '@od/shared/client';
import type { CompletionFollowUp } from '@od/shared/schemas';
import type { ListItemView } from '@od/shared/types';
import type { WatchStatus } from './listItemRow';
import { watchStatusOf } from './watchSections';

/**
 * The **one write** a confirmed watch follow-up makes, and the one that takes it back
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §8.4, §8.1;
 * §P3-16, §P3-31).
 *
 * ## This is the mutation; P3-43 is the question
 *
 * §8.4 step 2 is offered in the confirmation slot, and that slot — its copy, its dismiss
 * control, its placement — is P3-43's. What lives here is what happens **after** the tap:
 * `PATCH /v1/lists/:id/items/:itemId`, once, through the route that already enforces every
 * behaviour and field gate. There is no confirm endpoint and no server-side accept
 * (`interaction-contract.md` §1a.2), and **dismissal calls nothing at all** — it is the absence
 * of a request, not a request that says no.
 *
 * ## Typed from the server's payload, so nothing is re-derived
 *
 * The input is `CompletionFollowUp` itself — the object `POST /v1/activities/:id/complete`
 * returned. P3-43 hands that back untouched and receives a body; it never picks fields out of
 * it, because picking fields out of it is where `mediaKind` and the arm come to disagree
 * (§P3-16's note on why there are two arms). `details` is a whole replacement on the wire, and
 * assembling that replacement correctly — preserving what the session says nothing about — is
 * precisely the work that must not be done twice.
 *
 * ## What each arm writes
 *
 * - **`watch_progress`** — the season and episode the session recorded, and `want → watching`
 *   **only** from `want`. A `watching` item stays `watching` and a `watched` item stays
 *   `watched`: `watching → watched` is manual only, because the app does not know how many
 *   episodes there are (§8.1). Where the session names only one of the two numbers, the other
 *   keeps the item's own value — "the session's values" is what the session has, and confirming
 *   an episode-only follow-up must not erase a season.
 * - **`watch_watched`** — the movie row. §8.4 gives a `movie` `Update {list name} item to
 *   Watched?` in place of the progress question, and confirming it sets exactly that. It is not
 *   the automatic transition §8.1 forbids: it is a tap, with its own undo, on an item whose own
 *   `mediaKind` says it is a film.
 *
 * Both arms send `details` and **nothing else**. No title, no note, no position — a follow-up
 * says something about progress and status, and a body that carried more would be writing
 * fields the user was never asked about.
 */

/**
 * The typed `details` a body carries, assembled **whole** because the field is a replacement.
 *
 * One helper for all four builders below, so the shape is stated once: a body that forgot
 * `mediaKind` would turn a show into an item of no particular kind on every status change.
 */
function watchDetails(fields: {
  watchStatus: WatchStatus;
  mediaKind?: 'movie' | 'show' | undefined;
  season?: number | undefined;
  episode?: number | undefined;
}): PatchListItemInput {
  return {
    details: {
      behaviour: 'watch',
      watchStatus: fields.watchStatus,
      ...(fields.mediaKind === undefined ? {} : { mediaKind: fields.mediaKind }),
      ...(fields.season === undefined ? {} : { season: fields.season }),
      ...(fields.episode === undefined ? {} : { episode: fields.episode }),
    },
  };
}

/**
 * The body a confirmed follow-up sends.
 *
 * One `PATCH`, one field, and the arm decides what goes in it. Nothing here reads the item: the
 * payload already carries where the item is (`current`) and what the session did (`target`),
 * which is what lets P3-43 confirm without a second read and what stops a stale row on screen
 * from writing a status nobody chose.
 */
export function followUpItemPatch(followUp: CompletionFollowUp): PatchListItemInput {
  if (followUp.kind === 'watch_watched') {
    return watchDetails({
      watchStatus: 'watched',
      mediaKind: followUp.mediaKind,
      season: followUp.current.season,
      episode: followUp.current.episode,
    });
  }
  return watchDetails({
    // `want → watching`, and only from `want`. Every other status is left exactly as it is.
    watchStatus:
      followUp.current.watchStatus === 'want' ? 'watching' : followUp.current.watchStatus,
    mediaKind: followUp.mediaKind,
    season: followUp.target.season ?? followUp.current.season,
    episode: followUp.target.episode ?? followUp.current.episode,
  });
}

/**
 * The body that puts the item back, for the six-second undo (§8.4: "one write, with its own
 * undo toast").
 *
 * Built from `current` — the state the server reported at completion — rather than from a
 * fresh read, because the inverse of a write is the value it replaced. This is a compensating
 * `PATCH`, not a delayed commit: the forward write goes on the tap, and closing the app without
 * taking it back leaves it committed (the P2-24 rule).
 */
export function followUpUndoPatch(followUp: CompletionFollowUp): PatchListItemInput {
  return watchDetails({
    watchStatus: followUp.current.watchStatus,
    mediaKind: followUp.mediaKind,
    season: followUp.current.season,
    episode: followUp.current.episode,
  });
}

/**
 * The body a `Mark watched` sends, and its inverse (§3.2's swipe action, §8.1's any→any).
 *
 * A single-field `PATCH` like the follow-up's, assembled from the item's own committed details
 * so that the media kind and the progress underneath survive a status change. `undefined` when
 * the row carries no typed details: there is no status to change and none may be invented.
 */
export function markWatchedPatch(item: ListItemView): PatchListItemInput | undefined {
  return statusPatch(item, 'watched');
}

/** The inverse of {@link markWatchedPatch} — the status the row had before it was tapped. */
export function restoreStatusPatch(item: ListItemView): PatchListItemInput | undefined {
  const current = watchStatusOf(item);
  return current === undefined ? undefined : statusPatch(item, current);
}

function statusPatch(
  item: ListItemView,
  watchStatus: WatchStatus,
): PatchListItemInput | undefined {
  const details = item.details;
  if (details?.behaviour !== 'watch') return undefined;
  return watchDetails({
    watchStatus,
    mediaKind: details.mediaKind,
    season: details.season,
    episode: details.episode,
  });
}
