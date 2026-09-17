import { itemOriginatesFrom } from '@od/shared/lists';
import type { ListItemView } from '@od/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';

/**
 * Defined here rather than imported from the web twin: Metro resolves `./useIngredientPresence`
 * to whichever platform file is bundling, so an import from inside this file would resolve
 * back to itself. `useEligibleLists.ts`/`.native.ts` duplicate their small view type for the
 * same reason.
 */
export interface IngredientPresenceView {
  readonly present: ReadonlySet<string>;
  readonly known: boolean;
}

const UNKNOWN_PRESENCE: IngredientPresenceView = { present: new Set(), known: false };

/**
 * Every ingredient id an item on this page answers for, routed through the shared predicate
 * (`@od/shared/lists`) exactly as the web twin does — the platforms cannot share this small
 * iteration helper at runtime (Metro resolves one file per platform), so it is duplicated
 * rather than re-derived: both call sites read `itemOriginatesFrom`, never re-test
 * `origin.activityId`/`ingredientId` themselves.
 */
function presentIngredientIds(
  items: readonly Pick<ListItemView, 'origins'>[],
  activityId: string,
): ReadonlySet<string> {
  const present = new Set<string>();
  for (const item of items) {
    for (const origin of item.origins ?? []) {
      if (itemOriginatesFrom(item, activityId, origin.ingredientId)) {
        present.add(origin.ingredientId);
      }
    }
  }
  return present;
}

function requireListItemsDependencies() {
  const state = requireActiveNativeState();
  if (state.listItems === undefined) {
    throw new Error('Native list-items state is not ready.');
  }
  return { state, listItemsRepository: state.listItems, sync: state.sync };
}

/** Guards against a read from an old account session updating the new session's screen. */
function isCurrentSession(state: ReturnType<typeof requireActiveNativeState>): boolean {
  try {
    return requireActiveNativeState() === state;
  } catch {
    return false;
  }
}

/**
 * Whether the checked destination list holds a live item for each of this meal's
 * ingredients, read on **native** from the subscribed SQLite projection (ADR-057, migration
 * 29's `source_origins_json`).
 *
 * ## Unknown is a fact, not a guess
 *
 * No local page for the destination yet means presence cannot be answered — rendering
 * `Added` from a guess is precisely the receipt bug Option B replaces, and rendering it
 * `false` forever would just move the bug from "always added" to "never added". So an
 * unknown destination requests exactly the read that installs one: `sync.pullListDetail`,
 * the fenced install of page one (`syncEngine.ts`'s `pullListDetail`/`installFirstItemPage`).
 * `pullListItemPage` is the wrong call here — it only merges the *next* page onto one already
 * installed and returns immediately when `pageState` has no cursor to continue, which is
 * exactly the never-pulled case this branch exists for; it would resolve nothing and this
 * view would stay unknown forever. `useAddIngredients.ts` already calls `pullListDetail` for
 * the same reason after a successful add, and `useEligibleLists.native.ts` pulls the same way
 * once its own committed read has answered.
 *
 * ## Presence, not completeness
 *
 * Only the pages already committed locally are checked; a destination list long enough to
 * still be paging in may under-report presence for a row on a page that has not landed yet.
 * That degrades to "offered again", which the server's own title dedupe absorbs harmlessly
 * (`plans-and-lists.md` §7.3 step 6) rather than duplicating — the same trade-off the design
 * report accepted for this exact reason.
 */
export function useIngredientPresence(
  activityId: string,
  destinationListId: string | undefined,
): IngredientPresenceView {
  const { state, listItemsRepository, sync } = requireListItemsDependencies();
  const [view, setView] = useState<IngredientPresenceView>(UNKNOWN_PRESENCE);
  const active = useRef(false);
  const generation = useRef(0);

  const loadCommitted = useCallback(
    async (listId: string, requiredRevision?: number): Promise<void> => {
      const requestGeneration = generation.current + 1;
      generation.current = requestGeneration;
      let retryDelayMs = 50;

      while (active.current && generation.current === requestGeneration) {
        try {
          const snapshot = await listItemsRepository.readSnapshot(listId);
          if (
            !active.current ||
            generation.current !== requestGeneration ||
            !isCurrentSession(state)
          ) {
            return;
          }
          if (
            requiredRevision !== undefined &&
            snapshot.commitRevision < requiredRevision
          ) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
            continue;
          }
          if (snapshot.page === undefined) {
            // Never pulled locally: presence is unknown, never assumed absent, and the read
            // that installs page one is requested rather than left to the next unrelated
            // wake. `pullListItemPage` would return immediately here — see the doc comment
            // above — so this must be `pullListDetail`.
            setView(UNKNOWN_PRESENCE);
            const pull = sync.pullListDetail;
            if (pull !== undefined) void pull.call(sync, listId).catch(() => undefined);
            return;
          }
          setView({
            present: presentIngredientIds(snapshot.items, activityId),
            known: true,
          });
          return;
        } catch {
          if (
            !active.current ||
            generation.current !== requestGeneration ||
            !isCurrentSession(state)
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
        }
      }
    },
    [listItemsRepository, state, sync, activityId],
  );

  useEffect(() => {
    if (destinationListId === undefined) {
      active.current = false;
      generation.current += 1;
      setView(UNKNOWN_PRESENCE);
      return;
    }

    active.current = true;
    const stop = listItemsRepository.subscribe(destinationListId, (metadata) => {
      if (active.current) void loadCommitted(destinationListId, metadata.commitRevision);
    });
    void loadCommitted(destinationListId);

    return () => {
      active.current = false;
      generation.current += 1;
      stop();
    };
  }, [destinationListId, listItemsRepository, loadCommitted]);

  return view;
}
