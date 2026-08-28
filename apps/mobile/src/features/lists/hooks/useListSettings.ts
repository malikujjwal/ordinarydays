import {
  ApiError,
  behaviourConfirmationFrom,
  changeListBehaviour,
  isRetryable,
  type ListSettingsMutation,
  type PatchListInput,
  patchList,
  undoListOperation,
} from '@od/shared/client';
import type {
  DefaultSlot,
  List,
  ListBehaviour,
  ListBehaviourConfirmation,
  ListCapabilities,
} from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useClock } from '@/hooks/useClock';
import { apiClient } from '@/lib/apiClient';
import { type ToastMessage, useToast } from '@/stores/toast';
import {
  behaviourChangeKind,
  type PendingListSettings,
  settlePendingSettings,
  withoutPendingSettings,
  withPendingSettings,
} from '../model/listSettings';
import {
  remainingSettingsUndoMs,
  type SettingsChange,
  settingsChangedToast,
} from '../model/settingsUndoToast';

/**
 * Everything the List settings sheet and the inline rename write, on **web**: one online call
 * per control (§P3-32,
 * [`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.5).
 *
 * The native file beside this one accepts the same changes into SQLite first and syncs them.
 * Metro resolves `.native.ts` before this, so the sheet imports one name — the `useListDetail` /
 * `usePatchListItem` pattern — and {@link ListSettings} is the shape both files satisfy.
 *
 * ## Every control is independent
 *
 * §P3-32: "the sheet is a settings surface, not a wizard". There is no draft, no dirty state and
 * no `Save`. Each method is one write of one thing; closing the sheet mid-flight cancels
 * nothing, because nothing was being staged. A rollback is per-field for the same reason.
 *
 * ## Two protocols, and the direction chooses between them
 *
 * A capability, a slot and a rename are ordinary `PATCH`es. A behaviour change is
 * `POST /v1/lists/:id/behaviour`, and which of P3-09's two rows it takes is read from the list's
 * own stored `behaviour`:
 *
 * - **Upgrade** (`collection → watch|meals`) is additive. It applies optimistically, goes once
 *   under one stable `Idempotency-Key`, and offers the six-second Undo — which is
 *   `POST /v1/lists/:id/undo` with the upgrade token, never a destructive downgrade POST.
 * - **Downgrade** goes first **without** a `confirmation`. That call is a direct online preview
 *   carrying its own key. A `409` comes back with the server's typed preview and becomes the
 *   §1a.1 dialog; a `200` means nothing would have been lost, so the server answered additively
 *   with a settings token and the change is already done (§1a.1 rule 3 — "a conditional
 *   confirmation that can appear with a count of 0 is a bug"). Only on confirm does a **second**
 *   call go, echoing the complete `confirmation` under a newly minted stable key.
 *
 * ## One key per decision, held across retries
 *
 * Each call mints its key once, and the closure that sends it is what a transport retry and a
 * user-tapped `Retry` both re-enter — so one decision is one migration however many times it
 * leaves the device (§P3-09: "a replay of the same key drains or returns the recorded
 * response"). The confirmed downgrade holds its key in a ref as well, so a double tap on the
 * dialog's own button cannot mint a second one; cancelling, or a fresh preview, clears it,
 * because the next confirmation is a different decision about a different item generation.
 *
 * ## The optimistic overlay retires itself
 *
 * `withPendingSettings` draws what the user asked for until the committed projection carries it,
 * and `settlePendingSettings` drops each field the moment it does — the same shape
 * `checkedOverride.ts` uses for a tick, and for the same reason: an overlay that never retired
 * would mask a change made on another device.
 */
export interface ListSettings {
  /** The list as the user has just asked for it. `undefined` until the projection has one. */
  readonly view: List | undefined;
  /** One `PATCH { title }` under `If-Match`. Records no inverse, so it offers no Undo. */
  readonly rename: (title: string) => void;
  readonly setCapability: (capability: keyof ListCapabilities, next: boolean) => void;
  /** `null` clears the slot, and clears the matching profile default server-side with it. */
  readonly setSlot: (slot: DefaultSlot | null) => void;
  readonly changeBehaviour: (behaviour: ListBehaviour) => void;
  /** The server's preview awaiting an answer; the §1a.1 dialog is open while it is set. */
  readonly confirmation: ListBehaviourConfirmation | undefined;
  readonly confirmBehaviour: () => void;
  readonly cancelBehaviour: () => void;
  /** A behaviour write is in flight; the dialog's destructive button shows its spinner. */
  readonly busy: boolean;
}

export interface ListSettingsInput {
  readonly list: List | undefined;
  /**
   * Re-reads the projection after a change **this device accepted**.
   *
   * Native re-reads its committed SQLite rows and touches the network not at all; web has no
   * local truth and asks the server. A hook that always asked the network would put
   * "Couldn't refresh" under a rename the user had just successfully made offline.
   */
  readonly onChanged: () => void;
  /**
   * Re-reads after a change the **server** made, which is the downgrade preview that turned out
   * to lose nothing and was applied additively there and then.
   *
   * Separate for the reason `useListItemActions`' pair is separate: that write never entered
   * SQLite, so a native re-read of committed rows would find the behaviour it had before.
   */
  readonly onServerChanged: () => void;
}

/** §5.3's mutation row, plus the two failures a list-level write has of its own. */
export function settingsFailureToast(
  error: unknown,
  message: string,
  retry: () => void,
): ToastMessage {
  let displayed = message;
  if (error instanceof ApiError) {
    if (error.status === 409) {
      // §5.11.5, verbatim: list-level edits carry `If-Match`, and this is what losing says.
      displayed = 'This list changed while you were editing.';
    } else if (error.status === 403) {
      displayed = 'Only the person who made this plan can change that.';
    } else if (error.status === 404) {
      displayed = "This isn't here any more.";
    } else if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      displayed = `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    } else if (error.status >= 500) {
      displayed = 'Something went wrong.';
    }
  }
  return {
    message: displayed,
    tone: 'error',
    ...(error instanceof ApiError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(isRetryable(error) ? { action: { label: 'Retry', onPress: retry } } : {}),
  };
}

/**
 * What an Undo the server declined says, per outcome.
 *
 * `expired` and `no_longer_applicable` are `200`s carrying a true answer, so both are reported
 * honestly rather than swallowed: §P3-32 requires a `no_longer_applicable` upgrade-undo to leave
 * the current data untouched *and* to say so. Silence would leave the user believing the list
 * went back.
 */
export function undoOutcomeMessage(outcome: 'expired' | 'no_longer_applicable'): string {
  return outcome === 'expired'
    ? 'That was too long ago to undo.'
    : 'The list has changed since, so it was left as it is.';
}

export function useListSettings({
  list,
  onChanged,
  onServerChanged,
}: ListSettingsInput): ListSettings {
  const clock = useClock();
  const show = useToast((state) => state.show);
  const showUndo = useToast((state) => state.showUndo);
  const dismiss = useToast((state) => state.dismiss);
  const [pending, setPending] = useState<PendingListSettings>();
  const [confirmation, setConfirmation] = useState<ListBehaviourConfirmation>();
  const [busy, setBusy] = useState(false);
  /** The confirmed downgrade's key, held so a second tap cannot mint a second migration. */
  const confirmKey = useRef<string | undefined>(undefined);

  // Retire each pending field as the committed projection catches up, and never before.
  useEffect(() => {
    setPending((current) => settlePendingSettings(current, list));
  }, [list]);

  const rollback = useCallback((drop: PendingListSettings) => {
    setPending((current) => withoutPendingSettings(current, drop));
  }, []);

  const undo = useCallback(
    (listId: string, undoToken: string, revert: PendingListSettings) => {
      // Acceptance owns the singleton toast slot before this request can settle.
      dismiss();
      const idempotencyKey = randomUUID();
      const run = () => {
        setPending((current) => ({ ...current, ...revert }));
        void undoListOperation(apiClient, listId, undoToken, idempotencyKey)
          .then((response) => {
            onChanged();
            if (response.data.outcome === 'applied') return;
            /*
             * The compensation did not run, so the optimistic revert above is a lie. Take it
             * back before saying so, or the sheet would show the old value under a message
             * explaining that the new one stands.
             */
            rollback(revert);
            show({
              message: undoOutcomeMessage(response.data.outcome),
              tone: 'error',
              requestId: response.meta.requestId,
            });
          })
          .catch((error: unknown) => {
            rollback(revert);
            show(settingsFailureToast(error, "Couldn't undo that.", run));
          });
      };
      run();
    },
    [dismiss, onChanged, rollback, show],
  );

  /** The Undo offer an additive change earns, when the server recorded an inverse for it. */
  const offerUndo = useCallback(
    (
      listId: string,
      result: ListSettingsMutation,
      change: SettingsChange,
      revert: PendingListSettings,
    ) => {
      if (!('undoToken' in result)) return;
      const duration = remainingSettingsUndoMs(result.undoExpiresAt, clock);
      // Past its own offer deadline on arrival: the change stands, unoffered (§4.2).
      if (duration === undefined) return;
      showUndo(
        settingsChangedToast({
          change,
          duration,
          undoExpiresAt: result.undoExpiresAt,
          onUndo: () => undo(listId, result.undoToken, revert),
          onCommit: () => undefined,
        }),
      );
    },
    [clock, showUndo, undo],
  );

  const sendPatch = useCallback(
    (
      target: List,
      patch: PatchListInput,
      optimistic: PendingListSettings,
      undoOffer?: {
        readonly change: SettingsChange;
        readonly revert: PendingListSettings;
      },
    ) => {
      const idempotencyKey = randomUUID();
      const run = () => {
        // The accepted action takes the singleton toast slot before this request can settle.
        dismiss();
        setPending((current) => ({ ...current, ...optimistic }));
        void patchList(apiClient, target.listId, patch, target.updatedAt, idempotencyKey)
          .then((result) => {
            onChanged();
            if (undoOffer !== undefined) {
              offerUndo(target.listId, result, undoOffer.change, undoOffer.revert);
            }
          })
          .catch((error: unknown) => {
            rollback(optimistic);
            show(settingsFailureToast(error, `Couldn't change "${target.title}."`, run));
          });
      };
      run();
    },
    [dismiss, offerUndo, onChanged, rollback, show],
  );

  const sendBehaviour = useCallback(
    (
      target: List,
      behaviour: ListBehaviour,
      idempotencyKey: string,
      echoed: ListBehaviourConfirmation | undefined,
    ) => {
      const run = () => {
        setBusy(true);
        dismiss();
        setPending((current) => ({ ...current, behaviour }));
        void changeListBehaviour(
          apiClient,
          target.listId,
          { behaviour, ...(echoed === undefined ? {} : { confirmation: echoed }) },
          target.updatedAt,
          idempotencyKey,
        )
          .then((result) => {
            confirmKey.current = undefined;
            setConfirmation(undefined);
            onChanged();
            /*
             * A confirmed destructive change gets **no** Undo (§4.1): what it removed is gone,
             * and the server returns no token for it. An additive one — an upgrade, or the
             * zero-loss downgrade §1a.1 rule 3 turns into an ordinary toggle — does.
             */
            if (echoed === undefined) {
              offerUndo(
                target.listId,
                result,
                { kind: 'behaviour', behaviour },
                { behaviour: target.behaviour },
              );
            }
          })
          .catch((error: unknown) => {
            rollback({ behaviour });
            /*
             * A fresh `409` replaces the preview rather than failing: an item mutation between
             * preview and confirmation makes the old count wrong, and the user has to agree to
             * the new one under a new key (P3-09).
             */
            const preview = behaviourConfirmationFrom(error);
            if (preview !== undefined) {
              confirmKey.current = undefined;
              setConfirmation(preview);
              return;
            }
            setConfirmation(undefined);
            show(settingsFailureToast(error, `Couldn't change "${target.title}."`, run));
          })
          .finally(() => setBusy(false));
      };
      run();
    },
    [dismiss, offerUndo, onChanged, rollback, show],
  );

  const rename = useCallback(
    (title: string) => {
      if (list === undefined || title === list.title) return;
      sendPatch(list, { title }, { title });
    },
    [list, sendPatch],
  );

  const setCapability = useCallback(
    (capability: keyof ListCapabilities, next: boolean) => {
      if (list === undefined || list.capabilities[capability] === next) return;
      sendPatch(
        list,
        { capabilities: { [capability]: next } },
        { capabilities: { [capability]: next } },
        {
          change: { kind: 'capability', capability, next },
          revert: { capabilities: { [capability]: !next } },
        },
      );
    },
    [list, sendPatch],
  );

  const setSlot = useCallback(
    (slot: DefaultSlot | null) => {
      if (list === undefined || list.slot === slot) return;
      sendPatch(
        list,
        { slot },
        { slot },
        {
          change: { kind: 'slot', slot },
          revert: { slot: list.slot },
        },
      );
    },
    [list, sendPatch],
  );

  const changeBehaviour = useCallback(
    (behaviour: ListBehaviour) => {
      if (list === undefined) return;
      const kind = behaviourChangeKind(list.behaviour, behaviour);
      if (kind === undefined) return;
      if (kind === 'upgrade') {
        sendBehaviour(list, behaviour, randomUUID(), undefined);
        return;
      }
      /*
       * The downgrade preview: its **own** key, sent unconfirmed, and never accepted into a
       * durable queue on either platform. It is a question, and a question the user has not
       * answered yet must not survive the app being closed.
       */
      const previewKey = randomUUID();
      const preview = () => {
        setBusy(true);
        dismiss();
        void changeListBehaviour(
          apiClient,
          list.listId,
          { behaviour },
          list.updatedAt,
          previewKey,
        )
          .then((result) => {
            /*
             * Nothing was carrying the typed fields, so the server did it additively and
             * returned a settings token. §1a.1 rule 3: no dialog, ever, at a count of zero.
             */
            setPending((current) => ({ ...current, behaviour }));
            onServerChanged();
            offerUndo(
              list.listId,
              result,
              { kind: 'behaviour', behaviour },
              { behaviour: list.behaviour },
            );
          })
          .catch((error: unknown) => {
            const answer = behaviourConfirmationFrom(error);
            if (answer !== undefined) {
              /*
               * A new question needs a new key. An earlier confirmation that failed for some
               * other reason may have left one behind, and reusing it here would address the
               * receipt of a decision taken against a different item generation.
               */
              confirmKey.current = undefined;
              setConfirmation(answer);
              return;
            }
            show(
              settingsFailureToast(error, `Couldn't change "${list.title}."`, preview),
            );
          })
          .finally(() => setBusy(false));
      };
      preview();
    },
    [dismiss, list, offerUndo, onServerChanged, sendBehaviour, show],
  );

  const confirmBehaviour = useCallback(() => {
    if (list === undefined || confirmation === undefined) return;
    confirmKey.current ??= randomUUID();
    sendBehaviour(list, confirmation.toBehaviour, confirmKey.current, confirmation);
  }, [confirmation, list, sendBehaviour]);

  const cancelBehaviour = useCallback(() => {
    // Nothing was written, so there is nothing to take back — and the next preview is a new
    // question about a new item generation, which is why its key does not survive the answer.
    confirmKey.current = undefined;
    setConfirmation(undefined);
  }, []);

  return {
    view: list === undefined ? undefined : withPendingSettings(list, pending),
    rename,
    setCapability,
    setSlot,
    changeBehaviour,
    confirmation,
    confirmBehaviour,
    cancelBehaviour,
    busy,
  };
}
