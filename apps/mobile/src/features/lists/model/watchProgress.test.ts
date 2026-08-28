import type { CompletionFollowUp } from '@od/shared/schemas';
import type { ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  followUpItemPatch,
  followUpUndoPatch,
  markWatchedPatch,
  restoreStatusPatch,
} from './watchProgress';

/**
 * The one write a confirmed follow-up makes, and the one a swipe makes (§8.4, §8.1; §P3-31).
 *
 * Two rules are asserted everywhere below, because both are ways the app could start deciding
 * things it may not: **only `details` is ever sent**, and **`watching → watched` never happens
 * on its own**.
 */

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM_ID = 'itm_01J0000000000000000000AA';

const progressFollowUp = (
  current: {
    watchStatus: 'want' | 'watching' | 'watched';
    season?: number;
    episode?: number;
  },
  target: { season?: number; episode?: number },
  mediaKind?: 'show',
): CompletionFollowUp =>
  ({
    kind: 'watch_progress',
    listId: LIST_ID,
    listTitle: 'Movies and shows',
    itemId: ITEM_ID,
    current,
    ...(mediaKind === undefined ? {} : { mediaKind }),
    target,
  }) as CompletionFollowUp;

const item = (details?: ListItemView['details']): ListItemView => ({
  itemId: ITEM_ID,
  listId: LIST_ID,
  rank: 'm',
  title: 'Severance',
  checked: false,
  ...(details === undefined ? {} : { details }),
});

describe('the confirmed progress follow-up', () => {
  it('sets the session values and moves want to watching', () => {
    const patch = followUpItemPatch(
      progressFollowUp({ watchStatus: 'want' }, { season: 2, episode: 5 }, 'show'),
    );

    expect(patch).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watching',
        mediaKind: 'show',
        season: 2,
        episode: 5,
      },
    });
  });

  /** One field, and only one. A body that carried more would write what nobody was asked. */
  it('sends details and nothing else', () => {
    const patch = followUpItemPatch(
      progressFollowUp({ watchStatus: 'want' }, { season: 2, episode: 5 }),
    );

    expect(Object.keys(patch)).toEqual(['details']);
  });

  /**
   * §8.1: the app does not know how many episodes there are, so it never reaches for
   * `watched` on a show. Only `want` moves, and it moves exactly one step.
   */
  it('applies want → watching only from want', () => {
    const fromWatching = followUpItemPatch(
      progressFollowUp({ watchStatus: 'watching' }, { season: 2, episode: 5 }),
    );
    const fromWatched = followUpItemPatch(
      progressFollowUp({ watchStatus: 'watched' }, { season: 2, episode: 5 }),
    );

    expect(fromWatching.details).toMatchObject({ watchStatus: 'watching' });
    expect(fromWatched.details).toMatchObject({ watchStatus: 'watched' });
  });

  /** Confirming an episode-only follow-up must not erase the season the item already had. */
  it('keeps the item value for a number the session did not name', () => {
    const patch = followUpItemPatch(
      progressFollowUp(
        { watchStatus: 'watching', season: 2, episode: 4 },
        { episode: 5 },
      ),
    );

    expect(patch.details).toMatchObject({ season: 2, episode: 5 });
  });

  /** A back-filled item has no `mediaKind`; copying the session's numbers is not an opinion. */
  it('invents no media kind for an item that has never said which it is', () => {
    const patch = followUpItemPatch(
      progressFollowUp({ watchStatus: 'want' }, { season: 1, episode: 1 }),
    );

    expect(patch.details).toEqual({
      behaviour: 'watch',
      watchStatus: 'watching',
      season: 1,
      episode: 1,
    });
  });

  /** A rewatch: the session repeats the item's own progress, and the write is still one write. */
  it('writes the same values back when the session repeats them', () => {
    const patch = followUpItemPatch(
      progressFollowUp(
        { watchStatus: 'watching', season: 2, episode: 4 },
        { season: 2, episode: 4 },
      ),
    );

    expect(patch.details).toMatchObject({
      season: 2,
      episode: 4,
      watchStatus: 'watching',
    });
  });
});

describe('the movie arm', () => {
  const movieFollowUp: CompletionFollowUp = {
    kind: 'watch_watched',
    listId: LIST_ID,
    listTitle: 'Movies and shows',
    itemId: ITEM_ID,
    current: { watchStatus: 'want' },
    mediaKind: 'movie',
    target: { watchStatus: 'watched' },
  };

  /** §8.4 gives a movie the watched transition, because its own `mediaKind` says it is one. */
  it('sets watched and keeps the item a movie', () => {
    expect(followUpItemPatch(movieFollowUp)).toEqual({
      details: { behaviour: 'watch', watchStatus: 'watched', mediaKind: 'movie' },
    });
  });

  it('puts the previous status back on undo', () => {
    expect(followUpUndoPatch(movieFollowUp).details).toMatchObject({
      watchStatus: 'want',
    });
  });
});

describe('the undo', () => {
  /** The inverse of a write is the value it replaced, which the payload already carries. */
  it('restores the status and the progress the item had', () => {
    const followUp = progressFollowUp(
      { watchStatus: 'want', season: 1, episode: 8 },
      { season: 2, episode: 1 },
      'show',
    );

    expect(followUpUndoPatch(followUp)).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'want',
        mediaKind: 'show',
        season: 1,
        episode: 8,
      },
    });
  });
});

describe('Mark watched', () => {
  it('changes the status and keeps everything under it', () => {
    const row = item({
      behaviour: 'watch',
      watchStatus: 'watching',
      mediaKind: 'show',
      season: 2,
      episode: 4,
    });

    expect(markWatchedPatch(row)).toEqual({
      details: {
        behaviour: 'watch',
        watchStatus: 'watched',
        mediaKind: 'show',
        season: 2,
        episode: 4,
      },
    });
  });

  it('is undone by the status the row had', () => {
    const row = item({ behaviour: 'watch', watchStatus: 'want', mediaKind: 'movie' });

    expect(restoreStatusPatch(row)).toEqual({
      details: { behaviour: 'watch', watchStatus: 'want', mediaKind: 'movie' },
    });
  });

  /** Invalid data: there is no status to change, and none may be invented. */
  it('has nothing to send for a row with no typed details', () => {
    expect(markWatchedPatch(item())).toBeUndefined();
    expect(restoreStatusPatch(item())).toBeUndefined();
  });
});
