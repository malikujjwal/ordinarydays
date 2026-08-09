import type { CreationTarget } from '@od/shared/client';
import type { PlanType } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';
import type { ObjectChoice } from '@/features/compose/model/targets';

/**
 * The compose draft (P1-24).
 *
 * **Client state, so Zustand and not Query** (`tech-stack.md` §2.2, ADR-012). A half-filled
 * form would be meaningless to persist server-side, and no value in this store ever came from
 * the API — the created Activity goes into Query's cache and the draft is reset.
 *
 * ## The invariant this store exists to hold
 *
 * `target` is `undefined` until the user taps a row, and **there is no action that sets it
 * from anything but a tap**. `setTitle` cannot reach it. Neither can a capture result: the
 * capture actions write `title`, `notes` and `sourceUrl` and nothing else, by construction
 * rather than by filtering. The store is small enough to read in one sitting for exactly this
 * reason — the rule is only as strong as the reader's ability to confirm it
 * (`CLAUDE.md` rule 2).
 */

/** Which screen of the modal is showing. `object` is always where it opens. */
export type ComposeStep = 'object' | 'planKind' | 'form';

/**
 * The store's own field types are **present-and-possibly-undefined**, not optional.
 *
 * `CommonDraftFields.sourceUrl` is `?: string`, and under `exactOptionalPropertyTypes` those
 * are genuinely different types: an optional property may be *absent*, which a store slice
 * built by `set()` never is. Declaring them here rather than extending that interface is what
 * keeps `set({ sourceUrl: undefined })` — "the user cleared it" — expressible.
 */
export interface ComposeDraftState {
  title: string;
  notes: string;
  sourceUrl: string | undefined;
  step: ComposeStep;
  /**
   * The fixed target, or `undefined` while the user is still choosing.
   *
   * `listItem` needs a `listId` it cannot get in Phase 1, so choosing `List item` moves to
   * the Phase 3 placeholder and leaves this `undefined` rather than inventing one.
   */
  target: CreationTarget | undefined;
  /** A locally picked image. Phase 3 uploads it; Phase 1 shows it and blocks save with it. */
  attachmentUri: string | undefined;
  /**
   * Generated once at `onMutate` and reused on every retry, cleared whenever the draft
   * changes (`api-contract.md` §1). Clearing on change is what stops an edited-then-resaved
   * draft from being deduplicated against the previous body.
   */
  idempotencyKey: string | undefined;

  open: () => void;
  chooseObject: (choice: ObjectChoice) => void;
  choosePlanKind: (type: PlanType) => void;
  back: () => void;
  setTitle: (title: string) => void;
  setNotes: (notes: string) => void;
  setSourceUrl: (url: string) => void;
  attachImage: (uri: string) => void;
  clearAttachment: () => void;
  /** Returns the key for this attempt, generating one if the draft has changed since the last. */
  takeIdempotencyKey: () => string;
  reset: () => void;
}

const EMPTY = {
  step: 'object',
  target: undefined,
  title: '',
  notes: '',
  sourceUrl: undefined,
  attachmentUri: undefined,
  idempotencyKey: undefined,
} satisfies Omit<
  ComposeDraftState,
  | 'open'
  | 'chooseObject'
  | 'choosePlanKind'
  | 'back'
  | 'setTitle'
  | 'setNotes'
  | 'setSourceUrl'
  | 'attachImage'
  | 'clearAttachment'
  | 'takeIdempotencyKey'
  | 'reset'
>;

/**
 * Every content edit clears the pending key.
 *
 * Folded into one helper so no individual setter can forget it. A setter that kept the key
 * would let a user fix a typo, save again, and get the *original* title back from the
 * idempotency cache — a bug that only appears on a retry and is close to unfindable.
 */
const edited = (patch: Partial<ComposeDraftState>) => ({
  ...patch,
  idempotencyKey: undefined,
});

export const useComposeDraft = create<ComposeDraftState>()((set, get) => ({
  ...EMPTY,

  /** Always opens on the object step with nothing selected. Explicit intent costs one tap, every time. */
  open: () => set({ ...EMPTY }),

  /**
   * The one place `target` can become a Task.
   *
   * `plan` deliberately does **not** set a target: it advances to the second required chooser
   * and leaves the target unfixed, so a user who backs out of the Plan-kind step has chosen
   * nothing. `General` is chosen there, never defaulted here.
   */
  chooseObject: (choice) => {
    if (choice === 'task') {
      set({ step: 'form', target: { objectKind: 'task', type: 'task' } });
      return;
    }
    if (choice === 'plan') {
      set({ step: 'planKind', target: undefined });
      return;
    }
    // `List item` keeps the mental model stable and routes to the Phase 3 placeholder.
    set({ step: 'form', target: undefined });
  },

  /**
   * The one place `target` can become a Plan.
   *
   * Re-choosing a kind from the form keeps title, notes and the source URL: they are common
   * to every type in `activities.md` §4, so nothing is dropped and no confirmation is owed
   * (`interaction-contract.md` §1a.1, "Changing a Plan's kind, nothing dropped" → additive).
   * When P1-25 adds type-specific fields, P1-17's mapping is applied here and the destructive
   * branch of that table becomes reachable.
   */
  choosePlanKind: (type) =>
    set(edited({ step: 'form', target: { objectKind: 'plan', type } })),

  /**
   * Back never writes and never clears compatible fields.
   *
   * From the form it returns to whichever chooser produced the target — the Plan-kind step
   * for a plan, the object step for a task — and **unfixes the target**, because a form the
   * user has stepped back out of no longer has an answered destination.
   */
  back: () => {
    const { step, target } = get();
    if (step === 'planKind') {
      set({ step: 'object', target: undefined });
      return;
    }
    if (step === 'form') {
      set({
        step: target?.objectKind === 'plan' ? 'planKind' : 'object',
        target: undefined,
      });
    }
  },

  setTitle: (title) => set(edited({ title })),
  setNotes: (notes) => set(edited({ notes })),
  setSourceUrl: (sourceUrl) => set(edited({ sourceUrl })),
  attachImage: (attachmentUri) => set(edited({ attachmentUri })),
  clearAttachment: () => set(edited({ attachmentUri: undefined })),

  takeIdempotencyKey: () => {
    const existing = get().idempotencyKey;
    if (existing !== undefined) return existing;
    // `expo-crypto`, not `crypto.randomUUID` — the latter is absent from Hermes' global
    // scope on some SDK versions, and an idempotency key is the wrong place to find out.
    const key = randomUUID();
    set({ idempotencyKey: key });
    return key;
  },

  reset: () => set({ ...EMPTY }),
}));

/**
 * Whether closing should prompt `Discard this?`.
 *
 * Content only. Having *chosen* Task is not content — a user who taps `+`, taps `Task` and
 * changes their mind has typed nothing and is owed no dialog. A confirmation for an empty
 * form is the kind of friction that teaches people to dismiss dialogs without reading them.
 */
export function hasContent(
  state: Pick<ComposeDraftState, 'title' | 'notes' | 'sourceUrl' | 'attachmentUri'>,
): boolean {
  return (
    state.title.trim() !== '' ||
    state.notes.trim() !== '' ||
    (state.sourceUrl ?? '') !== '' ||
    state.attachmentUri !== undefined
  );
}
