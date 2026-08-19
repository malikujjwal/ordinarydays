import type { CreationTarget } from '@od/shared/client';
import type { CreateActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import { useState } from 'react';
import {
  type DraftFields,
  toCreateActivityInput,
} from '@/features/compose/model/targets';
import { useClock } from '@/hooks/useClock';
import { newLocalId } from '@/lib/localIds';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useComposeDraft } from '@/stores/composeDraft';

export interface CreateActivityResult {
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

function withReminderIds(input: CreateActivityInput): CreateActivityInput {
  if (input.reminders === undefined) return input;
  return {
    ...input,
    reminders: input.reminders.map((reminder) => ({
      ...reminder,
      reminderId: reminder.reminderId ?? newLocalId('rem'),
    })),
  };
}

export function useCreateActivity(): CreateActivityResult {
  const state = requireActiveNativeState();
  const clock = useClock();
  const takeIdempotencyKey = useComposeDraft((value) => value.takeIdempotencyKey);
  const takeActivityId = useComposeDraft((value) => value.takeActivityId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  return {
    save: async (target, fields, timezone) => {
      setSaving(true);
      try {
        const authored = toCreateActivityInput(target, fields, timezone);
        if (authored === undefined) {
          setError('A List item is not created through Activity storage.');
          return false;
        }
        const input = withReminderIds({ ...authored, activityId: takeActivityId() });
        const now = clock.now();
        const result = await state.coordinator.create(
          { input, idempotencyKey: takeIdempotencyKey() },
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
