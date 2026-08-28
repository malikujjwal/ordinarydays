import {
  ApiError,
  isRetryable,
  type ListSettingsMutation,
  type PatchListInput,
  patchList,
  undoListOperation,
} from '@od/shared/client';
import type {
  DefaultSlot,
  ItemStateMode,
  List,
  ListFeatureConfig,
  ProgressFeatureConfig,
  SubItemsFeatureConfig,
} from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import { useClock } from '@/hooks/useClock';
import { apiClient } from '@/lib/apiClient';
import { type ToastMessage, useToast } from '@/stores/toast';
import {
  mergedFeatureConfig,
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

export interface ListSettings {
  readonly view: List | undefined;
  readonly rename: (title: string) => void;
  readonly setStateMode: (mode: ItemStateMode) => void;
  readonly setFeatureEnabled: (
    feature: keyof ListFeatureConfig,
    enabled: boolean,
  ) => void;
  readonly setProgressKind: (kind: ProgressFeatureConfig['kind']) => void;
  readonly setSubItemLabels: (
    labels: Pick<
      SubItemsFeatureConfig,
      'sectionLabel' | 'singularLabel' | 'secondaryLabel'
    >,
  ) => void;
  readonly setSlot: (slot: DefaultSlot | null) => void;
  readonly busy: boolean;
}

export interface ListSettingsInput {
  readonly list: List | undefined;
  readonly onChanged: () => void;
  readonly onServerChanged: () => void;
}

export function settingsFailureToast(
  error: unknown,
  message: string,
  retry: () => void,
): ToastMessage {
  let displayed = message;
  if (error instanceof ApiError) {
    if (error.status === 409) displayed = 'This list changed while you were editing.';
    else if (error.status === 403) displayed = 'Only the list owner can change that.';
    else if (error.status === 404) displayed = "This isn't here any more.";
    else if (error.status === 429 && error.retryAfterSeconds !== undefined)
      displayed = `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    else if (error.status >= 500) displayed = 'Something went wrong.';
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

export function undoOutcomeMessage(outcome: 'expired' | 'no_longer_applicable'): string {
  return outcome === 'expired'
    ? 'That was too long ago to undo.'
    : 'The list has changed since, so it was left as it is.';
}

export function useListSettings({ list, onChanged }: ListSettingsInput): ListSettings {
  const clock = useClock();
  const show = useToast((state) => state.show);
  const showUndo = useToast((state) => state.showUndo);
  const dismiss = useToast((state) => state.dismiss);
  const [pending, setPending] = useState<PendingListSettings>();
  const [busy, setBusy] = useState(false);

  useEffect(() => setPending((current) => settlePendingSettings(current, list)), [list]);
  const rollback = useCallback((drop: PendingListSettings) => {
    setPending((current) => withoutPendingSettings(current, drop));
  }, []);

  const offerUndo = useCallback(
    (
      target: List,
      result: ListSettingsMutation,
      change: SettingsChange,
      revert: PendingListSettings,
    ) => {
      if (!('undoToken' in result)) return;
      const duration = remainingSettingsUndoMs(result.undoExpiresAt, clock);
      if (duration === undefined) return;
      showUndo(
        settingsChangedToast({
          change,
          duration,
          undoExpiresAt: result.undoExpiresAt,
          onUndo: () => {
            dismiss();
            setPending((current) => ({ ...current, ...revert }));
            const key = randomUUID();
            void undoListOperation(apiClient, target.listId, result.undoToken, key)
              .then((response) => {
                onChanged();
                if (response.data.outcome === 'applied') return;
                rollback(revert);
                show({
                  message: undoOutcomeMessage(response.data.outcome),
                  tone: 'error',
                });
              })
              .catch((error: unknown) => {
                rollback(revert);
                show(settingsFailureToast(error, "Couldn't undo that.", () => undefined));
              });
          },
          onCommit: () => undefined,
        }),
      );
    },
    [clock, dismiss, onChanged, rollback, show, showUndo],
  );

  const send = useCallback(
    (
      target: List,
      patch: PatchListInput,
      optimistic: PendingListSettings,
      change: SettingsChange,
      revert: PendingListSettings,
    ) => {
      const key = randomUUID();
      const run = () => {
        dismiss();
        setBusy(true);
        setPending((current) => ({ ...current, ...optimistic }));
        void patchList(apiClient, target.listId, patch, target.updatedAt, key)
          .then((result) => {
            onChanged();
            offerUndo(target, result, change, revert);
          })
          .catch((error: unknown) => {
            rollback(optimistic);
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
      next: ListFeatureConfig[typeof key],
      label: string,
      enabled: boolean,
    ) => {
      if (list === undefined || next === undefined) return;
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
      if (list === undefined) return;
      const current = list.featureConfig[feature];
      if (current?.enabled === enabled) return;
      if (feature === 'progress')
        updateFeature(
          feature,
          { enabled, kind: list.featureConfig.progress?.kind ?? 'text' },
          'Progress',
          enabled,
        );
      if (feature === 'place') updateFeature(feature, { enabled }, 'Place', enabled);
      if (feature === 'subItems')
        updateFeature(
          feature,
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
