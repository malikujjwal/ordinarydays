import type {
  DefaultSlot,
  List,
  ListBehaviour,
  ListCapabilities,
} from '@od/shared/types';

/**
 * What the List settings sheet is allowed to say, and how it classifies what it is about to do
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.5, §5.8,
 * [`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §1a.1,
 * §P3-32).
 *
 * Pure: no React, no client, no clock. The sheet renders these strings and the hooks branch on
 * these predicates, so both platforms say the same words about the same change and a copy
 * change is one edit rather than two.
 *
 * ## The direction of a behaviour change is the whole protocol
 *
 * `collection → watch|meals` is **additive** — every item gains a default and nothing is lost —
 * so it applies at once and offers Undo. `watch|meals → anything` is the destructive row, and
 * the client never guesses how much it would cost: it asks the server and renders the answer
 * (§P3-32's recorded decision, and `behaviourConfirmation.ts` beside this file). What *is*
 * decided here is only which of the two protocols to run, which is P3-09's change-rules table
 * read from the row's own stored `behaviour`.
 *
 * A zero-loss downgrade is not a third case: the server answers it additively with a settings
 * token (§1a.1 rule 3), so it arrives back through the additive path having never rendered a
 * dialog. Nothing here anticipates that — deciding locally that a downgrade "probably" loses
 * nothing is exactly the paginated-cache guess the decision forbids.
 */

/** The capability flags a `collection` exposes, by the words §5.5 gives them. */
export const CAPABILITY_LABELS: Record<keyof ListCapabilities, string> = {
  checkable: 'Show checkboxes',
  supportsLocation: 'Add a place to items',
};

/**
 * What each toggle actually does, said in the sheet under its label.
 *
 * Both say **retained**, because both are additive in *both* directions (§5.5's decision) and
 * the only thing that makes a switch labelled `Add a place to items` safe to flip is the user
 * knowing that flipping it back brings the addresses with it.
 */
export const CAPABILITY_MEANINGS: Record<keyof ListCapabilities, string> = {
  checkable: 'Turning this off keeps every tick, ready for when you turn it back on.',
  supportsLocation: 'Turning this off keeps every place you have saved.',
};

/** §5.8's three destinations, under the names the profile's `Default lists` gives them. */
export const SLOT_LABELS: Record<DefaultSlot, string> = {
  groceries: 'Groceries',
  watch: 'Watchlist',
  meals: 'Meals',
};

/**
 * A slot in plain words, because it is otherwise invisible until it changes where something
 * lands (§P3-32).
 *
 * Each names the flow that will use it rather than the field that stores it: a user setting
 * `groceries` is answering "where do ingredients go", not choosing an enum.
 */
export const SLOT_MEANINGS: Record<DefaultSlot, string> = {
  groceries: 'Send ingredients here by default',
  watch: 'Send things to watch here by default',
  meals: 'Send meal ideas here by default',
};

/** The row that takes the slot away. Not "None": the user is choosing, not clearing a field. */
export const NO_SLOT_LABEL = 'Not a default destination';

/**
 * What clearing a slot costs beyond this list, stated as a condition rather than a fact.
 *
 * §5.5's edge case: clearing a slot that **is** the profile default clears `defaultLists` for
 * it too, in the same List `PATCH`, "and the sheet says so". The sheet does not know whether
 * this list holds that default — `defaultLists` is on the profile, this screen reads the List —
 * and the same edge case forbids the second profile request that would tell it. So the
 * consequence is stated conditionally, which is true in both cases, rather than asserted in one
 * where it might not be.
 */
export const SLOT_CLEARS_PROFILE_DEFAULT =
  'If this list is your default for that, changing it here changes that too.';

/** §5.5's labels for the three targets, as the row that starts the change. */
export const BEHAVIOUR_CHOICE_LABELS: Record<ListBehaviour, string> = {
  collection: 'Turn this into a plain list',
  watch: 'Turn this into a watchlist',
  meals: 'Turn this into a meals list',
};

/**
 * The destructive button, which **repeats the verb** (§1a.1 rule 1).
 *
 * The same sentence as the row that opened it, minus "this": the dialog has already named the
 * list in its heading, and `OK` or `Continue` is the defect the rule exists to stop.
 */
export const BEHAVIOUR_CONFIRM_LABELS: Record<ListBehaviour, string> = {
  collection: 'Turn into a plain list',
  watch: 'Turn into a watchlist',
  meals: 'Turn into a meals list',
};

/**
 * What an **upgrade** gains, previewed before the tap (§P3-32).
 *
 * `collection` has no entry because arriving at `collection` is never additive by inspection —
 * whether it loses anything is the server's answer, not a sentence composed here.
 */
export const BEHAVIOUR_GAINS: Partial<Record<ListBehaviour, string>> = {
  watch: 'Items will gain a watch status, season and episode.',
  meals: 'Items will gain a list of ingredients.',
};

/**
 * The reassurance §P3-32 requires beside every behaviour choice.
 *
 * `templateKey` is immutable provenance and `icon`/`emptyStateCopy` are frozen presentation
 * (ADR-032, §5.5): changing behaviour does not make the list adopt another template's face. A
 * user who has to guess whether their list is about to be renamed and re-iconed will not touch
 * the control at all.
 */
export const BEHAVIOUR_PRESENTATION_NOTE =
  'The name, icon and empty-list words stay exactly as they are.';

/** Which of P3-09's two protocols a transition runs under. `undefined` is not a change. */
export function behaviourChangeKind(
  from: ListBehaviour,
  to: ListBehaviour,
): 'upgrade' | 'downgrade' | undefined {
  if (from === to) return undefined;
  return from === 'collection' ? 'upgrade' : 'downgrade';
}

/**
 * Whether the two capability switches are shown at all (§5.5, §P3-32).
 *
 * Read from the row's own `behaviour` and nothing else. A `watch` list keeps its stored flags
 * and its items keep their `checked` values — a later change back restores exactly what was
 * there — but until then nothing here drives a count, a control or a bulk operation.
 */
export function showsCapabilityControls(list: Pick<List, 'behaviour'>): boolean {
  return list.behaviour === 'collection';
}

/**
 * The settings the user has just asked for and the server has not confirmed yet.
 *
 * `slot` is nullable rather than optional for the reason `patchListInput` is: absent means
 * "unchanged" and `null` means "cleared", and a sheet that could not tell them apart would
 * make clearing a slot indistinguishable from not touching it.
 */
export interface PendingListSettings {
  readonly title?: string;
  readonly capabilities?: Partial<ListCapabilities>;
  readonly slot?: DefaultSlot | null;
  readonly behaviour?: ListBehaviour;
}

/**
 * The list as the user has just asked for it, for the render between tap and acknowledgement.
 *
 * One overlay applied once, at the screen, so the header, the rows, the `⋯` menu and the sheet
 * all draw the same optimistic truth. Two of them disagreeing — a sheet showing checkboxes on
 * while the rows below still draw none — is the flicker §1a.1's "applies immediately,
 * optimistically" exists to prevent.
 *
 * It never invents a field the change does not touch: a rename leaves `behaviour` alone, and a
 * behaviour change leaves the capability flags stored exactly as they are.
 */
export function withPendingSettings(
  list: List,
  pending: PendingListSettings | undefined,
): List {
  if (pending === undefined) return list;
  return {
    ...list,
    ...(pending.title === undefined ? {} : { title: pending.title }),
    ...(pending.behaviour === undefined ? {} : { behaviour: pending.behaviour }),
    ...(pending.slot === undefined ? {} : { slot: pending.slot }),
    ...(pending.capabilities === undefined
      ? {}
      : { capabilities: { ...list.capabilities, ...pending.capabilities } }),
  };
}

const isEmpty = (pending: PendingListSettings): boolean =>
  Object.keys(pending).length === 0;

/**
 * Drops every pending field the committed row already carries.
 *
 * Returns the **same object** when nothing settled, so a screen effect that runs this on every
 * projection change does not re-render for a no-op — `settleOverrides` in `checkedOverride.ts`
 * makes the same promise for a tick, and this overlay is the settings-shaped twin of it.
 */
export function settlePendingSettings(
  pending: PendingListSettings | undefined,
  list: List | undefined,
): PendingListSettings | undefined {
  if (pending === undefined || list === undefined) return pending;
  const settled: PendingListSettings = {
    ...(pending.title === undefined || pending.title === list.title
      ? {}
      : { title: pending.title }),
    ...(pending.behaviour === undefined || pending.behaviour === list.behaviour
      ? {}
      : { behaviour: pending.behaviour }),
    ...(pending.slot === undefined || pending.slot === list.slot
      ? {}
      : { slot: pending.slot }),
    ...(pending.capabilities === undefined ||
    Object.entries(pending.capabilities).every(
      ([name, value]) => list.capabilities[name as keyof ListCapabilities] === value,
    )
      ? {}
      : { capabilities: pending.capabilities }),
  };
  if (isEmpty(settled)) return undefined;
  return Object.keys(settled).length === Object.keys(pending).length ? pending : settled;
}

/**
 * Takes one failed change back out of the overlay, and leaves every other one standing.
 *
 * A rejected capability toggle must not also revert a rename the user made a second earlier:
 * every control here writes independently (§P3-32), so a rollback is per-field too. `drop` is
 * the same optimistic object the failed write applied, which is why the fields it names are
 * exactly the fields it owned.
 */
export function withoutPendingSettings(
  current: PendingListSettings | undefined,
  drop: PendingListSettings,
): PendingListSettings | undefined {
  if (current === undefined) return undefined;
  const kept: PendingListSettings = {
    ...(drop.title !== undefined || current.title === undefined
      ? {}
      : { title: current.title }),
    ...(drop.behaviour !== undefined || current.behaviour === undefined
      ? {}
      : { behaviour: current.behaviour }),
    ...(drop.slot !== undefined || current.slot === undefined
      ? {}
      : { slot: current.slot }),
    ...(drop.capabilities !== undefined || current.capabilities === undefined
      ? {}
      : { capabilities: current.capabilities }),
  };
  return isEmpty(kept) ? undefined : kept;
}
