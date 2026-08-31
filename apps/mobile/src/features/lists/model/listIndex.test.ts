import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { instant } from '@od/shared/schemas';
import { fixedClock, type Instant, type TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  archivedListToast,
  remainingArchiveUndoMs,
  SETTINGS_UNDO_DURATION_MS,
} from './archiveUndoToast';
import { deleteListConfirmation } from './deleteConfirmation';
import { mayShowEmptyState, partitionByArchived, shouldDrainMore } from './indexDrain';
import {
  checkedProgress,
  countLine,
  listTint,
  showsCheckedCount,
  tileToneForListId,
} from './listCard';
import { listSwipeActions, roleFor } from './listSwipeActions';
import { updatedLine } from './updatedLine';

/** The pure rules behind the Lists index (§P3-25, `design-system.md` §7.2). */

const UTC = 'UTC' as TimeZone;

const list = (overrides: Partial<List> = {}): List => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  schemaVersion: 2,
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 12,
  doneCount: 5,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T18:30:00.000Z'),
  ...overrides,
});

describe('the count line', () => {
  it('appends the checked count on a checkable collection', () => {
    expect(countLine(list())).toBe('12 items · 5 checked');
  });

  it('says items alone when state is hidden', () => {
    expect(countLine(list({ itemStateMode: { mode: 'none' } }))).toBe('12 items');
  });

  /**
   * **The retained-flag case**, and the reason the gate is two-part. A behaviour change from
   * `collection` to `watch` leaves `checkable: true` and its `checked` values in place; reading
   * only the capability would draw a count for state the list detail shows no checkbox for.
   */
  it('says items alone on a staged list while retaining intrinsic done state', () => {
    const staged = list({
      itemStateMode: {
        mode: 'stages',
        labels: { open: 'Saved', active: 'Reading', done: 'Read' },
        groupByState: true,
      },
    });

    expect(showsCheckedCount(staged)).toBe(false);
    expect(countLine(staged)).toBe('12 items');
    expect(checkedProgress(staged)).toBeUndefined();
  });

  it('is singular for one item', () => {
    expect(
      countLine(
        list({
          itemCount: 1,
          doneCount: 0,
          itemStateMode: { mode: 'none' },
        }),
      ),
    ).toBe('1 item');
  });

  /** A defensive clamp keeps corrupt aggregate counts from drawing impossible copy. */
  it('clamps a done count above the item total', () => {
    expect(countLine(list({ itemCount: 3, doneCount: 9 }))).toBe('3 items · 3 checked');
  });
});

describe('the progress bar', () => {
  it('is the checked fraction on a checkable collection', () => {
    expect(checkedProgress(list())).toBeCloseTo(5 / 12);
  });

  /** No bar at all, rather than a bar at zero: an empty track reads as unstarted progress. */
  it('is absent on an empty list', () => {
    expect(checkedProgress(list({ itemCount: 0, doneCount: 0 }))).toBeUndefined();
  });
});

describe('the icon tint', () => {
  it('is presentation-only and independent of creation provenance', () => {
    expect(listTint()).toBe('task');
  });
});

describe('the tile tone', () => {
  it('is stable for an identity and independent of catalogue provenance', () => {
    const listId = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
    expect(tileToneForListId(listId)).toBe(tileToneForListId(listId));
    expect(tileToneForListId(list({ templateKey: 'blank' }).listId)).toBe(
      tileToneForListId(list({ templateKey: 'watch-later' }).listId),
    );
  });

  it('varies a production shelf without depending on grid position', () => {
    const ids = [
      'lst_01J8XKQ2M4N5P6R7S8T9V0W1X1',
      'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3',
      'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4',
    ];
    const forward = ids.map(tileToneForListId);
    const reversed = [...ids].reverse().map(tileToneForListId).reverse();

    expect(new Set(forward).size).toBeGreaterThan(1);
    expect(reversed).toEqual(forward);
  });
});

describe('the updated line', () => {
  const now = instant.parse('2026-08-26T12:00:00.000Z');

  it.each([
    [instant.parse('2026-08-26T00:10:00.000Z'), 'Updated today'],
    [instant.parse('2026-08-25T23:50:00.000Z'), 'Updated yesterday'],
    [instant.parse('2026-08-23T09:00:00.000Z'), 'Updated 3 days ago'],
    [instant.parse('2026-08-18T09:00:00.000Z'), 'Updated last week'],
    [instant.parse('2026-08-05T09:00:00.000Z'), 'Updated 3 weeks ago'],
    [instant.parse('2026-05-05T09:00:00.000Z'), 'Updated 3 months ago'],
    [instant.parse('2024-05-05T09:00:00.000Z'), 'Updated over a year ago'],
  ])('renders %s as %s', (stamp, expected) => {
    expect(updatedLine(stamp, now, UTC)).toBe(expected);
  });

  it('accepts only branded instants', () => {
    expectTypeOf(updatedLine).parameter(0).toEqualTypeOf<Instant>();
  });

  /**
   * Calendar days, not 24-hour windows. Something written at 23:50 is `yesterday` at 00:10,
   * not `today` for another twenty-three hours.
   */
  it('crosses midnight rather than counting hours', () => {
    const justAfterMidnight = instant.parse('2026-08-26T00:10:00.000Z');
    expect(
      updatedLine(instant.parse('2026-08-25T23:50:00.000Z'), justAfterMidnight, UTC),
    ).toBe('Updated yesterday');
  });

  it('reads today when the clock is behind the write', () => {
    expect(updatedLine(instant.parse('2026-08-27T09:00:00.000Z'), now, UTC)).toBe(
      'Updated today',
    );
  });
});

describe('the auto-drain rule', () => {
  const base = { visibleCount: 0, viewportRows: 8, hasMore: true, isFetching: false };

  /**
   * The bug the rule exists for: a page of fifty archived pointers contributes no visible rows
   * and still has a cursor. Stopping there would show `No lists yet` over a page never followed.
   */
  it('keeps going while the filtered view is empty and a cursor remains', () => {
    expect(shouldDrainMore(base)).toBe(true);
  });

  it('stops once the filtered view can fill the viewport', () => {
    expect(shouldDrainMore({ ...base, visibleCount: 8 })).toBe(false);
  });

  it('stops when the cursor is exhausted', () => {
    expect(shouldDrainMore({ ...base, hasMore: false })).toBe(false);
  });

  it('does not stack a request while one is in flight', () => {
    expect(shouldDrainMore({ ...base, isFetching: true })).toBe(false);
  });
});

describe('the empty state gate', () => {
  const base = {
    visibleCount: 0,
    hasMore: false,
    isFetching: false,
    hasLoadedOnce: true,
  };

  it('allows `No lists yet` only after the cursor is exhausted', () => {
    expect(mayShowEmptyState(base)).toBe(true);
    expect(mayShowEmptyState({ ...base, hasMore: true })).toBe(false);
  });

  it('does not flash between pages', () => {
    expect(mayShowEmptyState({ ...base, isFetching: true })).toBe(false);
  });

  it('waits for the first load', () => {
    expect(mayShowEmptyState({ ...base, hasLoadedOnce: false })).toBe(false);
  });
});

describe('the archived partition', () => {
  it('splits the two groups and orders each by newest List identity first', () => {
    const rows = [
      { listId: 'lst_01A', archived: false },
      { listId: 'lst_01B', archived: true },
      { listId: 'lst_01C', archived: false },
      { listId: 'lst_01D', archived: true },
    ];

    const { active, archived } = partitionByArchived(rows);

    expect(active.map((row) => row.listId)).toEqual(['lst_01C', 'lst_01A']);
    expect(archived.map((row) => row.listId)).toEqual(['lst_01D', 'lst_01B']);
  });
});

describe('the swipe actions', () => {
  it('gives an owner Archive and Delete, in that order', () => {
    expect(listSwipeActions('owner').map((action) => action.label)).toEqual([
      'Archive',
      'Delete',
    ]);
  });

  /** Written for Phase 6 and unreachable today — the arm exists so it is one branch, not a rewrite. */
  it('gives a member Leave', () => {
    expect(listSwipeActions('member').map((action) => action.label)).toEqual(['Leave']);
  });

  it('derives the role from ownerId while the pointer role is unserialized', () => {
    expect(roleFor(list(), 'usr_local_dev')).toBe('owner');
    expect(roleFor(list(), 'usr_someone_else')).toBe('member');
    // Before `me` resolves, the safe reading is the one that offers no destructive action.
    expect(roleFor(list(), undefined)).toBe('member');
  });

  it('marks the destructive ones, so no full swipe can commit them', () => {
    expect(listSwipeActions('owner').map((action) => action.destructive)).toEqual([
      false,
      true,
    ]);
  });
});

describe('the archive undo toast', () => {
  it('offers the six-second settings window, not the ten-second bulk one', () => {
    expect(SETTINGS_UNDO_DURATION_MS).toBe(6000);
    expect(
      archivedListToast({
        title: 'Groceries',
        onUndo: () => undefined,
        onCommit: () => undefined,
      }),
    ).toMatchObject({ message: 'Groceries archived', duration: 6000 });
  });

  it('uses only the unelapsed part of the server offer', () => {
    const clock = fixedClock('2026-08-27T14:00:00.000Z' as Instant);

    expect(remainingArchiveUndoMs('2026-08-27T14:00:01.500Z' as Instant, clock)).toBe(
      1500,
    );
  });

  it('does not offer Undo after the server deadline', () => {
    const clock = fixedClock('2026-08-27T14:00:00.000Z' as Instant);

    expect(
      remainingArchiveUndoMs('2026-08-27T13:59:59.999Z' as Instant, clock),
    ).toBeUndefined();
  });

  it('does not offer a zero-length server window', () => {
    const clock = fixedClock(instant.parse('2026-08-27T14:00:00.000Z'));

    expect(
      remainingArchiveUndoMs(instant.parse('2026-08-27T14:00:00.000Z'), clock),
    ).toBeUndefined();
  });

  it('caps a clock-skewed deadline at the six-second settings window', () => {
    const clock = fixedClock('2026-08-27T14:00:00.000Z' as Instant);

    expect(remainingArchiveUndoMs('2026-08-27T14:01:00.000Z' as Instant, clock)).toBe(
      SETTINGS_UNDO_DURATION_MS,
    );
  });
});

describe('the delete confirmation', () => {
  /**
   * §1a.1: a dialog reading `Are you sure?` is a defect, not a style choice. Every number is
   * real, the verb is repeated, and the `Keeps:` line states what survives.
   */
  it('names the losses and repeats the verb', () => {
    const confirmation = deleteListConfirmation(list({ itemCount: 12 }));

    expect(confirmation.heading).toBe('Delete "Groceries"?');
    expect(confirmation.removes).toEqual([
      '12 List items will be removed',
      'No other people will lose access',
    ]);
    expect(confirmation.confirmLabel).toBe('Delete list');
    expect(confirmation.keeps).toContain('Linked Plans remain');
  });

  it('counts other members, excluding the owner', () => {
    expect(deleteListConfirmation(list({ memberCount: 4 })).removes).toEqual([
      '12 List items will be removed',
      '3 other people will lose access',
    ]);
  });

  it('truthfully says when nobody else loses access', () => {
    expect(deleteListConfirmation(list({ memberCount: 1 })).removes).toEqual([
      '12 List items will be removed',
      'No other people will lose access',
    ]);
  });
});

/**
 * **The renderer never reaches for the catalogue** (ADR-031, ADR-032, §P3-25, §P3-28).
 *
 * `check-forbidden.mjs`'s `list-templates-are-creation-data` already fails the build on the
 * `LIST_TEMPLATES` symbol anywhere in `apps/`. This adds the half that check cannot see: no
 * file in this feature may **resolve `templateKey`** either. A list's card must render from the
 * fields copied onto the row at creation, so that editing a template a year later cannot
 * silently change a list made from it.
 *
 * `templateKey` may be *stored* and *passed through* — the repository writes the column and the
 * schema carries it — so the assertion is about indexing with it, which is what a lookup looks
 * like.
 */
describe('the catalogue is not reachable from the Lists feature', () => {
  const featureRoot = join(__dirname, '..');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  const files = sourceFiles(featureRoot);

  /**
   * Code only, matching `check-forbidden.mjs`'s own `codeOnly` rule and for its stated reason:
   * "Prose may cite the rule; only code that touches the array is a violation." Without this,
   * the doc comments explaining *why* the catalogue is unreachable would themselves fail —
   * which teaches the next author to delete the explanation.
   */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s names no LIST_TEMPLATES', (file) => {
    expect(withoutComments(readFileSync(file, 'utf8'))).not.toContain('LIST_TEMPLATES');
  });

  it.each(files)('%s resolves nothing by templateKey', (file) => {
    const code = withoutComments(readFileSync(file, 'utf8'));
    // `[templateKey]`, `[list.templateKey]`, `.get(templateKey)` — any lookup keyed by it.
    expect(code).not.toMatch(/\[[^\]\n]*templateKey[^\]\n]*\]/);
    expect(code).not.toMatch(/\.get\([^)\n]*templateKey/);
  });
});
