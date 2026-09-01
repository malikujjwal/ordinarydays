import type { CreationTarget } from '@od/shared/client';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import { useState } from 'react';
import {
  type DraftFields,
  toScheduleListItemInput,
} from '@/features/compose/model/targets';
import { useClock } from '@/hooks/useClock';
import { newLocalId } from '@/lib/localIds';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * The native `Plan this item` save (P3-34): one durable `['list','item-schedule']` intent.
 *
 * The permanent `act_` id and every reminder's `rem_` id are minted here — before the intent
 * enters SQLite — and persisted with it, so replay after any interruption reuses the same
 * identities (§P3-13). The coordinator's transaction projects the pending Plan locally; the
 * sync engine's settlement installs the server's canonical answer.
 */

export interface ScheduleListItemResult {
  save: (
    target: CreationTarget,
    fields: DraftFields,
    timezone: string,
  ) => Promise<boolean>;
  isSaving: boolean;
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  fieldErrors: Record<string, string>;
  dismissError: () => void;
}

export function useScheduleListItem(): ScheduleListItemResult {
  const state = requireActiveNativeState();
  const clock = useClock();
  const bridge = useComposeDraft((value) => value.bridge);
  const audience = useComposeDraft((value) => value.audience);
  const takeIdempotencyKey = useComposeDraft((value) => value.takeIdempotencyKey);
  const takeActivityId = useComposeDraft((value) => value.takeActivityId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  return {
    save: async (target, fields, timezone) => {
      setSaving(true);
      try {
        if (bridge === undefined || target.objectKind !== 'plan') {
          setError('Plan this item requires a bridge source and a Plan target.');
          return false;
        }
        if (audience === undefined) {
          setError('Plan this item requires the explicitly tapped audience.');
          return false;
        }
        const activityId = takeActivityId();
        const input = toScheduleListItemInput(
          target,
          fields,
          timezone,
          activityId,
          audience,
          () => newLocalId('rem'),
        );
        if (input === undefined) {
          setError('The bridge request could not be built from this draft.');
          return false;
        }
        const now = clock.now();
        const result = await state.coordinator.scheduleListItem(
          {
            listId: bridge.listId,
            itemId: bridge.itemId,
            activityId,
            idempotencyKey: takeIdempotencyKey(),
            input,
          },
          {
            today: toWallDate(now, timezone as TimeZone),
            currentMinute: toWallTime(now, timezone as TimeZone),
          },
        );
        if (result.kind === 'refused') {
          setError(result.error.message);
          return false;
        }
        setError(undefined);
        return true;
      } finally {
        setSaving(false);
      }
    },
    isSaving: saving,
    errorMessage: error,
    errorRequestId: undefined,
    fieldErrors: {},
    dismissError: () => setError(undefined),
  };
}
