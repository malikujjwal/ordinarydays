import { isRetryable } from '@od/shared/client';
import {
  type PatchActivityInput,
  patchActivityInput,
  type ScheduleActivityInput,
} from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { ActivityDetail, ActivityDetailTarget } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CONFLICT_MESSAGE } from '@/features/activity/model/conflict';
import { useClock } from '@/hooks/useClock';
import { newLocalId } from '@/lib/localIds';
import { patchChangeNames } from '@/lib/patchChangeNames';
import { activityKey } from '@/lib/queryKeys';
import { getActiveNativeState, requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { CanonicalActivityInstallDeferredError } from '@/lib/sqlite/syncEngine';

export { activityKey };

const CAPABILITY_RETRY_DELAYS_MS = [500, 2_000, 10_000] as const;
const HYDRATION_RETRY_MESSAGE =
  "Latest details are still syncing. We'll retry automatically.";

function manualHydrationMessage(error: unknown): string {
  return error instanceof CanonicalActivityInstallDeferredError
    ? HYDRATION_RETRY_MESSAGE
    : error instanceof Error
      ? error.message
      : String(error);
}

function shouldRetryCapabilityHydration(error: unknown): boolean {
  return error instanceof CanonicalActivityInstallDeferredError || isRetryable(error);
}

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
  const [loadMessage, setLoadMessage] = useState<string>();
  const [editError, setEditError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [savingReminder, setSavingReminder] = useState(false);
  const [reminderError, setReminderError] = useState<string>();
  const [hydrationRetry, setHydrationRetry] = useState(0);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const automaticPullKey = useRef<string | undefined>(undefined);
  const automaticPullInFlight = useRef<string | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryIndex = useRef(0);
  const targetKey = `${target.kind}:${targetActivityId}:${targetDate ?? ''}`;

  const isCurrentRequest = useCallback(
    (generation: number) =>
      mounted.current &&
      requestGeneration.current === generation &&
      getActiveNativeState() === state,
    [state],
  );

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!mounted.current || getActiveNativeState() !== state) return;
    if (retryTimer.current !== undefined) return;
    const delay =
      CAPABILITY_RETRY_DELAYS_MS[
        Math.min(retryIndex.current, CAPABILITY_RETRY_DELAYS_MS.length - 1)
      ];
    retryIndex.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      if (mounted.current && getActiveNativeState() === state) {
        setHydrationRetry((current) => current + 1);
      }
    }, delay);
  }, [state]);

  const load = useCallback(
    async (generation: number) => {
      const committed = await state.activities.read(target);
      if (!isCurrentRequest(generation)) return undefined;
      if (committed !== undefined) {
        setDetail(committed);
        setStatus('success');
      }
      return committed;
    },
    [isCurrentRequest, state, target],
  );

  const refetch = useCallback(() => {
    clearRetry();
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    void (async () => {
      const committed = await load(generation);
      if (!isCurrentRequest(generation)) return;
      const hydrationState = await state.activities.capabilityHydrationState(activityId);
      if (!isCurrentRequest(generation)) return;
      if (hydrationState === 'deferred') {
        if (committed === undefined) {
          setStatus('error');
          setLoadMessage(HYDRATION_RETRY_MESSAGE);
        }
        return;
      }
      const pullKey = `${targetKey}:${committed?.activity.updatedAt ?? 'missing'}`;
      try {
        const canonical = await state.sync.pullActivity(target);
        if (!isCurrentRequest(generation)) return;
        setDetail(canonical);
        setStatus('success');
        setLoadMessage(undefined);
        const hydrated = await state.activities.hasInstalledCapabilities(activityId);
        if (!isCurrentRequest(generation)) return;
        if (hydrated) {
          automaticPullKey.current = pullKey;
          retryIndex.current = 0;
          clearRetry();
        } else {
          scheduleRetry();
        }
      } catch (error) {
        const retained = await state.activities.read(target);
        if (!isCurrentRequest(generation)) return;
        if (retained === undefined) {
          setDetail(undefined);
          setStatus('error');
        } else {
          setDetail(retained);
          setStatus('success');
        }
        setLoadMessage(manualHydrationMessage(error));
        if (shouldRetryCapabilityHydration(error)) {
          scheduleRetry();
        } else {
          automaticPullKey.current = `${targetKey}:${retained?.activity.updatedAt ?? 'missing'}`;
          retryIndex.current = 0;
          clearRetry();
        }
      }
    })();
  }, [
    activityId,
    clearRetry,
    isCurrentRequest,
    load,
    scheduleRetry,
    state,
    target,
    targetKey,
  ]);

  useEffect(() => {
    void state;
    void targetKey;
    mounted.current = true;
    automaticPullKey.current = undefined;
    automaticPullInFlight.current = undefined;
    retryIndex.current = 0;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      automaticPullInFlight.current = undefined;
      clearRetry();
    };
  }, [clearRetry, state, targetKey]);

  useEffect(() => {
    void version;
    void hydrationRetry;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    void load(generation).then(async (committed) => {
      if (!isCurrentRequest(generation)) return;
      const hydrationState = await state.activities.capabilityHydrationState(activityId);
      if (!isCurrentRequest(generation)) return;
      if (hydrationState === 'deferred') {
        clearRetry();
        return;
      }
      const needsCanonicalDetail =
        committed === undefined || hydrationState === 'missing';
      const pullKey = `${targetKey}:${committed?.activity.updatedAt ?? 'missing'}`;
      if (
        needsCanonicalDetail &&
        automaticPullKey.current !== pullKey &&
        automaticPullInFlight.current === undefined
      ) {
        clearRetry();
        automaticPullInFlight.current = pullKey;
        try {
          const canonical = await state.sync.pullActivity(target);
          if (!isCurrentRequest(generation)) return;
          setDetail(canonical);
          setStatus('success');
          setLoadMessage(undefined);
          const hydrated = await state.activities.hasInstalledCapabilities(activityId);
          if (!isCurrentRequest(generation)) return;
          if (hydrated) {
            automaticPullKey.current = pullKey;
            retryIndex.current = 0;
            clearRetry();
          } else {
            scheduleRetry();
          }
        } catch (error) {
          if (!isCurrentRequest(generation)) return;
          const retained = await state.activities.read(target);
          if (!isCurrentRequest(generation)) return;
          if (retained === undefined) {
            setDetail(undefined);
            setStatus('error');
          } else {
            setDetail(retained);
            setStatus('success');
          }
          const retryable = shouldRetryCapabilityHydration(error);
          setLoadMessage(
            retained === undefined
              ? retryable
                ? HYDRATION_RETRY_MESSAGE
                : manualHydrationMessage(error)
              : undefined,
          );
          if (retryable) {
            scheduleRetry();
          } else {
            automaticPullKey.current = `${targetKey}:${retained?.activity.updatedAt ?? 'missing'}`;
            retryIndex.current = 0;
            clearRetry();
          }
        } finally {
          if (automaticPullInFlight.current === pullKey) {
            automaticPullInFlight.current = undefined;
          }
        }
      }
    });
  }, [
    activityId,
    clearRetry,
    hydrationRetry,
    isCurrentRequest,
    load,
    scheduleRetry,
    state,
    target,
    targetKey,
    version,
  ]);

  const run = useCallback(
    async (operation: () => ReturnType<typeof state.coordinator.patch>) => {
      setSaving(true);
      try {
        const result = await operation();
        if (result.kind === 'refused') {
          setEditError(result.error.message);
          return false;
        }
        setEditError(undefined);
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
    ...(loadMessage === undefined ? {} : { message: loadMessage }),
    ...(editError === undefined ? {} : { editError }),
    refetch,
    isSaving: saving,
    patch: (input) => {
      if (detail === undefined) return Promise.resolve(false);
      const parsed = patchActivityInput.safeParse(input);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        setEditError(firstIssue?.message ?? 'This change is not valid.');
        return Promise.resolve(false);
      }
      const timezone = (detail.activity.schedule?.timezone ?? 'UTC') as TimeZone;
      const now = clock.now();
      return run(() =>
        state.coordinator.patch(
          activityId,
          randomUUID(),
          parsed.data,
          detail.activity.updatedAt,
          {
            today: toWallDate(now, timezone),
            currentMinute: toWallTime(now, timezone),
          },
          patchChangeNames(parsed.data),
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
      setEditError((current) => (current === CONFLICT_MESSAGE ? undefined : current)),
  };
}
