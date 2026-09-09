import { type ChangeTarget, changeActivityKind } from '@od/shared';
import type { PatchActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { Activity, ActivityChild, ActivityOutcome } from '@od/shared/types';
import { type ActivityScope, scopeToWire } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { useClock } from '@/hooks/useClock';
import { useFollowUpActions } from '@/hooks/useFollowUp';
import { nextCanonicalId } from '@/lib/canonicalIds';
import { waitForCompletionFollowUp } from '@/lib/completionFollowUp';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import {
  ACTION_FAILED,
  ACTIVITY_GONE,
  type ActivityActions,
  type ActivityActionsOptions,
  OUTCOME_RECORDED,
} from '../model/activityActions';

/**
 * Native completion is accepted locally first; the one follow-up arrives when the serialized
 * owner acknowledges the server body (P3-44). The Undo toast is already showing, so the
 * follow-up attaches to that same confirmation rather than replacing it.
 */
export function useActivityActions(
  activityId: string,
  options: ActivityActionsOptions = {},
): ActivityActions {
  const state = requireActiveNativeState();
  const clock = useClock();
  const followUp = useFollowUpActions(options.followUp);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const lastCompletion = useRef<string | undefined>(undefined);
  const retryRef = useRef<(() => void) | undefined>(undefined);
  const resolutionToastId = useRef<number | undefined>(undefined);

  const fail = useCallback((retry?: () => void, message = ACTION_FAILED) => {
    retryRef.current = retry;
    setError(message);
  }, []);

  const projectionClock = useCallback(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const now = clock.now();
    return {
      today: toWallDate(now, timezone as TimeZone),
      currentMinute: toWallTime(now, timezone as TimeZone),
    };
  }, [clock]);

  const accepted = useCallback(
    async <T>(operation: () => Promise<T>, retry: () => void): Promise<T | undefined> => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await operation();
        retryRef.current = undefined;
        return result;
      } catch {
        fail(retry);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );

  const resultOk = useCallback(
    (result: Awaited<ReturnType<typeof state.coordinator.skip>>, retry: () => void) => {
      if (result.kind !== 'refused') return true;
      fail(retry);
      return false;
    },
    [fail],
  );
  const targetsSeries = useCallback(
    async (scope: ActivityScope, retry: () => void) => {
      if (scope.kind !== 'activity') return false;
      try {
        const detail = await state.activities.read({ kind: 'activity', activityId });
        return detail?.activity.recurrence !== undefined;
      } catch {
        fail(retry);
        return undefined;
      }
    },
    [activityId, fail, state],
  );
  const readRestoredStatus = useCallback(
    async (retry: () => void) => {
      try {
        const detail = await state.activities.read({ kind: 'activity', activityId });
        if (detail === undefined) {
          fail(retry, ACTIVITY_GONE);
          return undefined;
        }
        return detail.activity.schedule === undefined
          ? ('saved' as const)
          : ('scheduled' as const);
      } catch {
        fail(retry);
        return undefined;
      }
    },
    [activityId, fail, state],
  );

  async function duplicateWith(copyActivityId: string, intentId: string) {
    const retry = () => void duplicateWith(copyActivityId, intentId);
    const result = await accepted(async () => {
      const write = await state.coordinator.duplicate(
        activityId,
        copyActivityId,
        intentId,
        projectionClock(),
      );
      if (write.kind === 'refused') return { write, copy: undefined };
      const copy = (
        await state.activities.read({ kind: 'activity', activityId: copyActivityId })
      )?.activity;
      return { write, copy };
    }, retry);
    if (result === undefined || !resultOk(result.write, retry)) return undefined;
    if (result.copy === undefined) {
      fail(retry, ACTIVITY_GONE);
      return undefined;
    }
    return result.copy;
  }

  async function removeWith(intentId: string): Promise<boolean> {
    const retry = () => void removeWith(intentId);
    const result = await accepted(
      () => state.coordinator.remove(activityId, intentId),
      retry,
    );
    return result !== undefined && resultOk(result, retry);
  }

  async function skipWith(scope: ActivityScope, intentId: string): Promise<boolean> {
    const retry = () => void skipWith(scope, intentId);
    if ((await targetsSeries(scope, retry)) !== false) return false;
    const result = await accepted(
      () =>
        state.coordinator.skip(
          { activityId, idempotencyKey: intentId, input: scopeToWire(scope) },
          true,
          projectionClock(),
        ),
      retry,
    );
    return result !== undefined && resultOk(result, retry);
  }

  async function snoozeWith(
    scope: ActivityScope,
    until: string,
    renderedDate: string,
    intentId: string,
  ): Promise<boolean> {
    const retry = () => void snoozeWith(scope, until, renderedDate, intentId);
    if ((await targetsSeries(scope, retry)) !== false) return false;
    const result = await accepted(
      () =>
        state.coordinator.snooze(
          {
            activityId,
            idempotencyKey: intentId,
            input: { ...scopeToWire(scope), until },
          },
          true,
          renderedDate,
          projectionClock(),
        ),
      retry,
    );
    return result !== undefined && resultOk(result, retry);
  }

  function resolveWith(
    outcome: ActivityOutcome,
    scope: ActivityScope,
    onProjected: (resolved: boolean) => void,
    intentId: string,
  ): void {
    const retry = () => resolveWith(outcome, scope, onProjected, intentId);
    void (async () => {
      if ((await targetsSeries(scope, retry)) !== false) return;
      const restoredStatus = await readRestoredStatus(retry);
      if (restoredStatus === undefined) return;
      lastCompletion.current = intentId;
      setCompleting(true);
      setError(undefined);
      try {
        let pendingFollowUp: unknown;
        const stopWait = waitForCompletionFollowUp(intentId, (carried) => {
          const toastId = resolutionToastId.current;
          if (toastId === undefined) {
            pendingFollowUp = carried;
            return;
          }
          followUp.present(carried, { activityId, activityType: undefined }, toastId);
        });
        const result = await state.coordinator.complete(
          activityId,
          intentId,
          { outcome, ...scopeToWire(scope) },
          true,
          restoredStatus,
          projectionClock(),
        );
        if (!resultOk(result, retry)) {
          stopWait();
          return;
        }
        retryRef.current = undefined;
        onProjected(true);
        const toastId = useToast.getState().showUndo({
          message: OUTCOME_RECORDED,
          onCommit: () => undefined,
          onUndo: () => {
            const inverseIntentId = randomUUID();
            const retryUndo = () =>
              void undoToastWith(
                intentId,
                inverseIntentId,
                scope,
                restoredStatus,
                onProjected,
              );
            void undoToastWith(
              intentId,
              inverseIntentId,
              scope,
              restoredStatus,
              onProjected,
              retryUndo,
            );
          },
        });
        resolutionToastId.current = toastId;
        if (pendingFollowUp !== undefined) {
          followUp.present(
            pendingFollowUp,
            { activityId, activityType: undefined },
            toastId,
          );
        }
      } catch {
        fail(retry);
      } finally {
        setCompleting(false);
      }
    })();
  }

  async function undoToastWith(
    originalIntentId: string,
    inverseIntentId: string,
    scope: ActivityScope,
    restoredStatus: 'saved' | 'scheduled',
    onProjected: (resolved: boolean) => void,
    suppliedRetry?: () => void,
  ): Promise<void> {
    const retry =
      suppliedRetry ??
      (() =>
        void undoToastWith(
          originalIntentId,
          inverseIntentId,
          scope,
          restoredStatus,
          onProjected,
        ));
    setUndoing(true);
    setError(undefined);
    try {
      const result = await state.coordinator.undoCompletion(
        originalIntentId,
        { activityId, idempotencyKey: inverseIntentId, input: scopeToWire(scope) },
        false,
        restoredStatus,
        projectionClock(),
      );
      if (resultOk(result, retry)) {
        retryRef.current = undefined;
        onProjected(false);
      }
    } catch {
      fail(retry);
    } finally {
      setUndoing(false);
    }
  }

  function undoWith(
    scope: ActivityScope,
    onProjected: ((resolved: boolean) => void) | undefined,
    originalIntentId: string | undefined,
    inverseIntentId: string,
  ): void {
    const retry = () => undoWith(scope, onProjected, originalIntentId, inverseIntentId);
    setUndoing(true);
    setError(undefined);
    void (async () => {
      try {
        const restoredStatus = await readRestoredStatus(retry);
        if (restoredStatus === undefined) return;
        const inverse = {
          activityId,
          idempotencyKey: inverseIntentId,
          input: scopeToWire(scope),
        };
        const result =
          originalIntentId === undefined
            ? await state.coordinator.complete(
                activityId,
                inverse.idempotencyKey,
                inverse.input,
                false,
                restoredStatus,
                projectionClock(),
              )
            : await state.coordinator.undoCompletion(
                originalIntentId,
                inverse,
                false,
                restoredStatus,
                projectionClock(),
              );
        if (resultOk(result, retry)) {
          retryRef.current = undefined;
          onProjected?.(false);
        }
      } catch {
        fail(retry);
      } finally {
        setUndoing(false);
      }
    })();
  }

  async function setChildCompletionWith(
    child: ActivityChild,
    completed: boolean,
    intentId: string,
  ): Promise<boolean> {
    if (child.isRecurring) {
      fail(undefined, 'Open the task to choose which repeating occurrence to complete.');
      return false;
    }
    const retry = () => void setChildCompletionWith(child, completed, intentId);
    const result = await accepted(async () => {
      const restoredStatus = await state.activities.readChildRestoredStatus(
        activityId,
        child.activityId,
      );
      if (restoredStatus === undefined) return undefined;
      return state.coordinator.complete(
        child.activityId,
        intentId,
        completed ? { outcome: 'done' } : {},
        completed,
        restoredStatus,
        projectionClock(),
        activityId,
      );
    }, retry);
    if (result === undefined) {
      fail(retry);
      return false;
    }
    return resultOk(result, retry);
  }

  return {
    duplicate: () => duplicateWith(nextCanonicalId('act'), randomUUID()),
    remove: () => removeWith(randomUUID()),
    skip: (scope) => skipWith(scope, randomUUID()),
    snooze: (scope, until, renderedDate) =>
      snoozeWith(scope, until, renderedDate, randomUUID()),
    resolvePassed: (outcome, scope, onProjected) =>
      resolveWith(outcome, scope, onProjected, randomUUID()),
    undoResolution: (scope, onProjected) =>
      undoWith(scope, onProjected, lastCompletion.current, randomUUID()),
    setChildCompletion: (child, completed) =>
      setChildCompletionWith(child, completed, randomUUID()),
    isBusy: busy || completing || undoing,
    isCompleting: completing,
    isUndoing: undoing,
    errorMessage: error,
    errorRequestId: undefined,
    retryError: () => {
      const retry = retryRef.current;
      setError(undefined);
      retry?.();
    },
    dismissError: () => {
      retryRef.current = undefined;
      setError(undefined);
    },
  };
}

export function kindChangePatch(
  activity: Activity,
  target: ChangeTarget,
): PatchActivityInput {
  const result = changeActivityKind(activity, target);
  return {
    objectKind: result.objectKind,
    type: result.type,
    details: result.details,
    ...(result.notes === undefined ? {} : { notes: result.notes }),
    ...(result.location === undefined ? {} : { location: result.location }),
  };
}
