import {
  behaviourConfirmationFrom,
  changeListBehaviour,
  type PatchListInput,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import {
  behaviourChangeKind,
  type PendingListSettings,
  settlePendingSettings,
  withoutPendingSettings,
  withPendingSettings,
} from '../model/listSettings';
import { type SettingsChange, settingsChangedToast } from '../model/settingsUndoToast';
import {
  type ListSettings,
  type ListSettingsInput,
  settingsFailureToast,
  undoOutcomeMessage,
} from './useListSettings';

/**
 * The same settings surface, on **native**: accepted into SQLite first, then synced (§P3-32,
 * ADR-057).
 *
 * The visible row and the queued intent commit in **one** transaction — `interaction-contract.md`
 * §5.4's writes rule for a migrated domain — so a rename typed on a train is a change the user
 * can see they made *and* one that survives the app being closed.
 *
 * ## Three of the four controls ride an intent that already existed
 *
 * `title`, the two capability flags and `slot` are `['list','patch']`, the key P3-25's archive
 * introduced, with its `input` widened from the archive flag to the whole `PatchListInput`. One
 * ordering key per list means a rename queued behind a capability toggle cannot overtake it and
 * run its `If-Match` against a version that never existed.
 *
 * **Behaviour is the inventory extension**: a new `['list','behaviour']` intent, its own
 * variables, its own push branch and its own settlement, because it is a different route running
 * a gated item migration rather than one conditional write.
 *
 * ## The downgrade preview is online, by design
 *
 * It is a **question**: "what would this cost?" A question the user has not answered must not
 * survive the app being closed, and its answer is only true against the item generation the
 * server measured — so it carries its own key, is never appended to the outbox, and simply fails
 * offline like any other read. Only the user's **answer** becomes durable, under a new key, with
 * the server's own `confirmation` echoed whole.
 *
 * A preview that comes back `200` is the zero-loss case §1a.1 rule 3 turns into an ordinary
 * additive change: the server already performed it, so this device refreshes from the server
 * rather than from SQLite, and its Undo is the online compensation matching the online write.
 *
 * ## Undo is a durable compensation, never a second PATCH
 *
 * `undoSettings` cancels the forward intent if it has not left the queue — the exact inverse —
 * and otherwise appends `['list','undo']` carrying the server's opaque token, which settlement
 * installs on the offer. Nothing here reconstructs what goes back; the local row is redrawn from
 * the forward intent's recorded `previous`, which is a projection and not an authority.
 */
export function useListSettings({
  list,
  onChanged,
  onServerChanged,
}: ListSettingsInput): ListSettings {
  const state = requireActiveNativeState();
  if (state.lists === undefined) throw new Error('Native Lists state is not ready.');
  const lists = state.lists;
  const service = useMemo(
    () => new ListTransactionService(state.outbox, lists),
    [lists, state.outbox],
  );
  const show = useToast((store) => store.show);
  const showUndo = useToast((store) => store.showUndo);
  const dismiss = useToast((store) => store.dismiss);
  const [pending, setPending] = useState<PendingListSettings>();
  const [confirmation, setConfirmation] = useState<ListBehaviourConfirmation>();
  const [busy, setBusy] = useState(false);
  const confirmKey = useRef<string | undefined>(undefined);

  // Retire each pending field as the committed SQLite row catches up, and never before.
  useEffect(() => {
    setPending((current) => settlePendingSettings(current, list));
  }, [list]);

  const rollback = useCallback((drop: PendingListSettings) => {
    setPending((current) => withoutPendingSettings(current, drop));
  }, []);

  /** The durable compensation, and the local redraw that goes with it. */
  const offerUndo = useCallback(
    (
      listId: string,
      originalIntentId: string,
      change: SettingsChange,
      revert: PendingListSettings,
    ) => {
      showUndo(
        settingsChangedToast({
          change,
          onUndo: () => {
            const inverseIntentId = randomUUID();
            const runUndo = () => {
              dismiss();
              setPending((current) => ({ ...current, ...revert }));
              void state.account.transactions
                .run(
                  (transaction) =>
                    service.undoSettings(
                      transaction,
                      listId,
                      originalIntentId,
                      inverseIntentId,
                    ),
                  'interactive',
                )
                .then((result) => {
                  if (result.kind === 'queued') state.sync.request('accepted-action');
                  onChanged();
                })
                .catch(() => {
                  rollback(revert);
                  show({
                    message: "Couldn't undo that.",
                    tone: 'error',
                    action: { label: 'Retry', onPress: runUndo },
                  });
                });
            };
            runUndo();
          },
          onCommit: () => {
            void state.account.transactions.run(
              (transaction) =>
                service.commitArchiveUndoOffer(transaction, originalIntentId),
              'interactive',
            );
          },
        }),
      );
    },
    [
      dismiss,
      onChanged,
      rollback,
      service,
      show,
      showUndo,
      state.account.transactions,
      state.sync,
    ],
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
      // One intent identity, reused by every replay of this same decision (§P3-05's rule).
      const intentId = randomUUID();
      const run = () => {
        dismiss();
        setPending((current) => ({ ...current, ...optimistic }));
        void state.account.transactions
          .run(
            (transaction) => service.patchSettings(transaction, target, patch, intentId),
            'interactive',
          )
          .then(() => {
            state.sync.request('accepted-action');
            onChanged();
            if (undoOffer !== undefined) {
              offerUndo(target.listId, intentId, undoOffer.change, undoOffer.revert);
            }
          })
          .catch(() => {
            rollback(optimistic);
            show({
              message: `Couldn't change "${target.title}."`,
              tone: 'error',
              action: { label: 'Retry', onPress: run },
            });
          });
      };
      run();
    },
    [
      dismiss,
      offerUndo,
      onChanged,
      rollback,
      service,
      show,
      state.account.transactions,
      state.sync,
    ],
  );

  const sendBehaviour = useCallback(
    (
      target: List,
      behaviour: ListBehaviour,
      intentId: string,
      echoed: ListBehaviourConfirmation | undefined,
    ) => {
      const run = () => {
        setBusy(true);
        dismiss();
        setPending((current) => ({ ...current, behaviour }));
        void state.account.transactions
          .run(
            (transaction) =>
              service.changeBehaviour(
                transaction,
                target,
                {
                  behaviour,
                  ...(echoed === undefined ? {} : { confirmation: echoed }),
                },
                intentId,
              ),
            'interactive',
          )
          .then(() => {
            state.sync.request('accepted-action');
            confirmKey.current = undefined;
            setConfirmation(undefined);
            onChanged();
            // A confirmed destructive change gets no Undo (§4.1); an upgrade does.
            if (echoed === undefined) {
              offerUndo(
                target.listId,
                intentId,
                { kind: 'behaviour', behaviour },
                { behaviour: target.behaviour },
              );
            }
          })
          .catch(() => {
            rollback({ behaviour });
            setConfirmation(undefined);
            show({
              message: `Couldn't change "${target.title}."`,
              tone: 'error',
              action: { label: 'Retry', onPress: run },
            });
          })
          .finally(() => setBusy(false));
      };
      run();
    },
    [
      dismiss,
      offerUndo,
      onChanged,
      rollback,
      service,
      show,
      state.account.transactions,
      state.sync,
    ],
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
             * Nothing carried the typed fields, so the server did it additively and returned a
             * settings token. The write happened on the **server**, so the refresh is a pull and
             * the compensation is the matching online call — the split `useListItemActions`
             * records for its own online delete.
             */
            setPending((current) => ({ ...current, behaviour }));
            onServerChanged();
            if (!('undoToken' in result)) return;
            showUndo(
              settingsChangedToast({
                change: { kind: 'behaviour', behaviour },
                undoExpiresAt: result.undoExpiresAt,
                onUndo: () => {
                  dismiss();
                  const inverseKey = randomUUID();
                  setPending((current) => ({
                    ...current,
                    behaviour: list.behaviour,
                  }));
                  void undoListOperation(
                    apiClient,
                    list.listId,
                    result.undoToken,
                    inverseKey,
                  )
                    .then((response) => {
                      onServerChanged();
                      if (response.data.outcome === 'applied') return;
                      rollback({ behaviour: list.behaviour });
                      show({
                        message: undoOutcomeMessage(response.data.outcome),
                        tone: 'error',
                        requestId: response.meta.requestId,
                      });
                    })
                    .catch((error: unknown) => {
                      rollback({ behaviour: list.behaviour });
                      show(settingsFailureToast(error, "Couldn't undo that.", preview));
                    });
                },
                onCommit: () => undefined,
              }),
            );
          })
          .catch((error: unknown) => {
            const answer = behaviourConfirmationFrom(error);
            if (answer !== undefined) {
              // A new question needs a new key, for the reason the web file records.
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
    [dismiss, list, onServerChanged, rollback, sendBehaviour, show, showUndo],
  );

  const confirmBehaviour = useCallback(() => {
    if (list === undefined || confirmation === undefined) return;
    confirmKey.current ??= randomUUID();
    sendBehaviour(list, confirmation.toBehaviour, confirmKey.current, confirmation);
  }, [confirmation, list, sendBehaviour]);

  const cancelBehaviour = useCallback(() => {
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
