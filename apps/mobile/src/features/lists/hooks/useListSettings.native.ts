import type { PatchListInput } from '@od/shared/client';
import type {
  DefaultSlot,
  ItemStateMode,
  List,
  ListFeatureConfig,
  ProgressFeatureConfig,
  SubItemsFeatureConfig,
} from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import {
  mergedFeatureConfig,
  type PendingListSettings,
  settlePendingSettings,
  withoutPendingSettings,
  withPendingSettings,
} from '../model/listSettings';
import { type SettingsChange, settingsChangedToast } from '../model/settingsUndoToast';
import type { ListSettings, ListSettingsInput } from './useListSettings';

export function useListSettings({ list, onChanged }: ListSettingsInput): ListSettings {
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
  const [busy, setBusy] = useState(false);
  useEffect(() => setPending((current) => settlePendingSettings(current, list)), [list]);

  const rollback = useCallback((drop: PendingListSettings) => {
    setPending((current) => withoutPendingSettings(current, drop));
  }, []);

  const send = useCallback(
    (
      target: List,
      patch: PatchListInput,
      optimistic: PendingListSettings,
      change: SettingsChange,
      revert: PendingListSettings,
    ) => {
      const intentId = randomUUID();
      const run = () => {
        dismiss();
        setBusy(true);
        setPending((current) => ({ ...current, ...optimistic }));
        void state.account.transactions
          .run(
            (transaction) => service.patchSettings(transaction, target, patch, intentId),
            'interactive',
          )
          .then(() => {
            state.sync.request('accepted-action');
            onChanged();
            showUndo(
              settingsChangedToast({
                change,
                onUndo: () => {
                  const inverseIntentId = randomUUID();
                  setPending((current) => ({ ...current, ...revert }));
                  void state.account.transactions
                    .run(
                      (transaction) =>
                        service.undoSettings(
                          transaction,
                          target.listId,
                          intentId,
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
                      show({ message: "Couldn't undo that.", tone: 'error' });
                    });
                },
                onCommit: () => {
                  void state.account.transactions.run(
                    (transaction) =>
                      service.commitArchiveUndoOffer(transaction, intentId),
                    'interactive',
                  );
                },
              }),
            );
          })
          .catch(() => {
            rollback(optimistic);
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
      onChanged,
      rollback,
      service,
      show,
      showUndo,
      state.account.transactions,
      state.sync,
    ],
  );

  const rename = useCallback(
    (title: string) => {
      if (list === undefined || title === list.title) return;
      send(
        list,
        { title },
        { title },
        { kind: 'setting', label: 'List name', next: true },
        { title: list.title },
      );
    },
    [list, send],
  );

  const setStateMode = useCallback(
    (itemStateMode: ItemStateMode) => {
      if (
        list === undefined ||
        JSON.stringify(itemStateMode) === JSON.stringify(list.itemStateMode)
      )
        return;
      send(
        list,
        { itemStateMode },
        { itemStateMode },
        { kind: 'state-mode', label: itemStateMode.mode },
        { itemStateMode: list.itemStateMode },
      );
    },
    [list, send],
  );

  const updateFeature = useCallback(
    (
      key: keyof ListFeatureConfig,
      next: NonNullable<ListFeatureConfig[typeof key]>,
      label: string,
      enabled: boolean,
    ) => {
      if (list === undefined) return;
      const featureConfig = mergedFeatureConfig(list, { [key]: next });
      send(
        list,
        { featureConfig: { [key]: next } },
        { featureConfig },
        { kind: 'setting', label, next: enabled },
        { featureConfig: list.featureConfig },
      );
    },
    [list, send],
  );

  const setFeatureEnabled = useCallback(
    (feature: keyof ListFeatureConfig, enabled: boolean) => {
      if (list === undefined || list.featureConfig[feature]?.enabled === enabled) return;
      if (feature === 'progress')
        updateFeature(
          'progress',
          { enabled, kind: list.featureConfig.progress?.kind ?? 'text' },
          'Progress',
          enabled,
        );
      if (feature === 'place') updateFeature('place', { enabled }, 'Place', enabled);
      if (feature === 'subItems')
        updateFeature(
          'subItems',
          {
            ...(list.featureConfig.subItems ?? {
              sectionLabel: 'Sub-items',
              singularLabel: 'Sub-item',
            }),
            enabled,
          },
          'Sub-items',
          enabled,
        );
    },
    [list, updateFeature],
  );

  const setProgressKind = useCallback(
    (kind: ProgressFeatureConfig['kind']) => {
      if (list === undefined) return;
      updateFeature(
        'progress',
        { enabled: list.featureConfig.progress?.enabled ?? true, kind },
        'Progress',
        true,
      );
    },
    [list, updateFeature],
  );

  const setSubItemLabels = useCallback(
    (
      labels: Pick<
        SubItemsFeatureConfig,
        'sectionLabel' | 'singularLabel' | 'secondaryLabel'
      >,
    ) => {
      if (list === undefined) return;
      const current = list.featureConfig.subItems ?? {
        enabled: true,
        sectionLabel: 'Sub-items',
        singularLabel: 'Sub-item',
      };
      updateFeature('subItems', { ...current, ...labels }, 'Sub-items', current.enabled);
    },
    [list, updateFeature],
  );

  const setSlot = useCallback(
    (slot: DefaultSlot | null) => {
      if (list === undefined || list.slot === slot) return;
      send(list, { slot }, { slot }, { kind: 'slot', slot }, { slot: list.slot });
    },
    [list, send],
  );

  return {
    view: list === undefined ? undefined : withPendingSettings(list, pending),
    rename,
    setStateMode,
    setFeatureEnabled,
    setProgressKind,
    setSubItemLabels,
    setSlot,
    busy,
  };
}
