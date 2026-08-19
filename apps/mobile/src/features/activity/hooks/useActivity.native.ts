import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { ActivityDetail, ActivityDetailTarget } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CONFLICT_MESSAGE } from '@/features/activity/model/conflict';
import { useClock } from '@/hooks/useClock';
import { newLocalId } from '@/lib/localIds';
import { patchChangeNames } from '@/lib/mutationDefaults';
import { activityKey } from '@/lib/queryKeys';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';

export { activityKey };

export interface ActivityDetailView {
  status: 'pending' | 'success' | 'error';
  detail?: ActivityDetail;
  message?: string;
  requestId?: string;
  refetch: () => void;
  isSaving: boolean;
  patch: (input: PatchActivityInput) => Promise<boolean>;
  schedule: (input: ScheduleActivityInput) => Promise<boolean>;
  convertToOneOff: (selectedDate: string) => Promise<boolean>;
  addReminder: (offsetMinutes: number) => Promise<boolean>;
  removeReminder: (reminderId: string) => Promise<boolean>;
  isSavingReminder: boolean;
  reminderError?: string;
  conflict?: { message: string; dropped?: string };
  acknowledgeConflict: () => void;
  editError?: string;
}

export function useActivityDetail(
  targetInput: ActivityDetailTarget | string,
): ActivityDetailView {
  const state = requireActiveNativeState();
  const clock = useClock();
  const targetDate =
    typeof targetInput === 'string' || targetInput.kind === 'activity'
      ? undefined
      : targetInput.date;
  const targetActivityId =
    typeof targetInput === 'string' ? targetInput : targetInput.activityId;
  const target = useMemo<ActivityDetailTarget>(
    () =>
      targetDate === undefined
        ? { kind: 'activity', activityId: targetActivityId }
        : { kind: 'occurrence', activityId: targetActivityId, date: targetDate },
    [targetActivityId, targetDate],
  );
  const activityId = targetActivityId;
  const version = useSyncExternalStore(
    (listener) => state.activities.subscribe(activityId, listener),
    () => state.activities.version(activityId),
    () => 0,
  );
  const [detail, setDetail] = useState<ActivityDetail>();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [savingReminder, setSavingReminder] = useState(false);
  const [reminderError, setReminderError] = useState<string>();

  const load = useCallback(async () => {
    const committed = await state.activities.read(target);
    if (committed !== undefined) {
      setDetail(committed);
      setStatus('success');
    }
    return committed;
  }, [state, target]);

  const refetch = useCallback(() => {
    void (async () => {
      await load();
      try {
        const canonical = await state.sync.pullActivity(target);
        setDetail(canonical);
        setStatus('success');
        setMessage(undefined);
      } catch (error) {
        const retained = await state.activities.read(target);
        if (retained === undefined) {
          setDetail(undefined);
          setStatus('error');
        }
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [state, load, target]);

  useEffect(() => {
    void version;
    void load().then((committed) => {
      if (committed === undefined) refetch();
    });
  }, [load, refetch, version]);

  const run = useCallback(
    async (operation: () => ReturnType<typeof state.coordinator.patch>) => {
      setSaving(true);
      try {
        const result = await operation();
        if (result.kind === 'refused') {
          setMessage(result.error.message);
          return false;
        }
        setMessage(undefined);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return {
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(message === undefined ? {} : { message, editError: message }),
    refetch,
    isSaving: saving,
    patch: (input) => {
      if (detail === undefined) return Promise.resolve(false);
      return run(() =>
        state.coordinator.patch(
          activityId,
          randomUUID(),
          input,
          detail.activity.updatedAt,
          patchChangeNames(input),
        ),
      );
    },
    schedule: (input) => {
      const timezone = input.timezone ?? detail?.activity.schedule?.timezone ?? 'UTC';
      const now = clock.now();
      return run(() =>
        state.coordinator.schedule(activityId, randomUUID(), input, {
          today: toWallDate(now, timezone as TimeZone),
          currentMinute: toWallTime(now, timezone as TimeZone),
        }),
      );
    },
    convertToOneOff: (selectedDate) =>
      run(() =>
        state.coordinator.convertRecurrence(activityId, selectedDate, randomUUID()),
      ),
    addReminder: async (offsetMinutes) => {
      setSavingReminder(true);
      try {
        const result = await state.coordinator.addReminder({
          activityId,
          idempotencyKey: randomUUID(),
          input: { reminderId: newLocalId('rem'), offsetMinutes },
        });
        if (result.kind === 'refused') {
          setReminderError(result.error.message);
          return false;
        }
        setReminderError(undefined);
        return true;
      } finally {
        setSavingReminder(false);
      }
    },
    removeReminder: async (reminderId) => {
      setSavingReminder(true);
      try {
        const result = await state.coordinator.removeReminder({
          activityId,
          reminderId,
          intentId: randomUUID(),
        });
        if (result.kind === 'refused') {
          setReminderError(result.error.message);
          return false;
        }
        setReminderError(undefined);
        return true;
      } finally {
        setSavingReminder(false);
      }
    },
    isSavingReminder: savingReminder,
    ...(reminderError === undefined ? {} : { reminderError }),
    acknowledgeConflict: () =>
      setMessage((current) => (current === CONFLICT_MESSAGE ? undefined : current)),
  };
}
