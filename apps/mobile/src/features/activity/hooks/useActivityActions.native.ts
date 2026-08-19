import { type ChangeTarget, changeActivityKind } from '@od/shared';
import type { PatchActivityInput } from '@od/shared/schemas';
import { type TimeZone, toWallDate, toWallTime } from '@od/shared/time';
import type { Activity, ActivityOutcome } from '@od/shared/types';
import { type ActivityScope, scopeToWire } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import { useClock } from '@/hooks/useClock';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';

export interface ActivityActions {
  duplicate: () => Promise<Activity | undefined>;
  remove: () => Promise<boolean>;
  skip: (scope: ActivityScope) => Promise<boolean>;
  snooze: (scope: ActivityScope, until: string, renderedDate: string) => Promise<boolean>;
  resolvePassed: (
    outcome: ActivityOutcome,
    scope: ActivityScope,
    onProjected: (resolved: boolean) => void,
  ) => void;
  undoResolution: (
    scope: ActivityScope,
    onProjected?: (resolved: boolean) => void,
  ) => void;
  isBusy: boolean;
  isCompleting: boolean;
  isUndoing: boolean;
  errorMessage: string | undefined;
  dismissError: () => void;
}

export function useActivityActions(activityId: string): ActivityActions {
  const state = requireActiveNativeState();
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const lastCompletion = useRef<string | undefined>(undefined);

  const projectionClock = useCallback(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const now = clock.now();
    return {
      today: toWallDate(now, timezone as TimeZone),
      currentMinute: toWallTime(now, timezone as TimeZone),
    };
  }, [clock]);

  const accepted = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(undefined);
      try {
        return await operation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const resultOk = useCallback(
    (result: Awaited<ReturnType<typeof state.coordinator.skip>>) => {
      if (result.kind !== 'refused') return true;
      setError(result.error.message);
      return false;
    },
    [],
  );
  const targetsSeries = useCallback(
    async (scope: ActivityScope) => {
      if (scope.kind !== 'activity') return false;
      const detail = await state.activities.read({ kind: 'activity', activityId });
      return detail?.activity.recurrence !== undefined;
    },
    [activityId, state],
  );

  return {
    duplicate: async () => {
      const result = await accepted(() =>
        state.coordinator.duplicate(activityId, randomUUID()),
      );
      if (result === undefined || !resultOk(result)) return undefined;
      // The server assigns the duplicate id. Its canonical response is installed by sync.
      return undefined;
    },
    remove: async () => {
      const result = await accepted(() =>
        state.coordinator.remove(activityId, randomUUID()),
      );
      return result !== undefined && resultOk(result);
    },
    skip: async (scope) => {
      if (await targetsSeries(scope)) return false;
      const result = await accepted(() =>
        state.coordinator.skip(
          {
            activityId,
            idempotencyKey: randomUUID(),
            input: scopeToWire(scope),
          },
          true,
          projectionClock(),
        ),
      );
      return result !== undefined && resultOk(result);
    },
    snooze: async (scope, until, renderedDate) => {
      if (await targetsSeries(scope)) return false;
      const result = await accepted(() =>
        state.coordinator.snooze(
          {
            activityId,
            idempotencyKey: randomUUID(),
            input: { ...scopeToWire(scope), until },
          },
          true,
          renderedDate,
          projectionClock(),
        ),
      );
      return result !== undefined && resultOk(result);
    },
    resolvePassed: (outcome, scope, onProjected) => {
      void targetsSeries(scope).then((blocked) => {
        if (blocked) return;
        const intentId = randomUUID();
        lastCompletion.current = intentId;
        setCompleting(true);
        void state.coordinator
          .complete(
            activityId,
            intentId,
            { outcome, ...scopeToWire(scope) },
            true,
            'scheduled',
            projectionClock(),
          )
          .then((result) => {
            setCompleting(false);
            if (!resultOk(result)) return;
            onProjected(true);
            useToast.getState().showUndo({
              message: 'Outcome recorded',
              onCommit: () => undefined,
              onUndo: () => {
                setUndoing(true);
                void state.coordinator
                  .undoCompletion(
                    intentId,
                    {
                      activityId,
                      idempotencyKey: randomUUID(),
                      input: scopeToWire(scope),
                    },
                    false,
                    'scheduled',
                    projectionClock(),
                  )
                  .then((undo) => {
                    setUndoing(false);
                    if (resultOk(undo)) onProjected(false);
                  });
              },
            });
          });
      });
    },
    undoResolution: (scope, onProjected) => {
      setUndoing(true);
      const original = lastCompletion.current;
      const inverse = {
        activityId,
        idempotencyKey: randomUUID(),
        input: scopeToWire(scope),
      };
      const request =
        original === undefined
          ? state.coordinator.complete(
              activityId,
              inverse.idempotencyKey,
              inverse.input,
              false,
              'scheduled',
              projectionClock(),
            )
          : state.coordinator.undoCompletion(
              original,
              inverse,
              false,
              'scheduled',
              projectionClock(),
            );
      void request.then((result) => {
        setUndoing(false);
        if (resultOk(result)) onProjected?.(false);
      });
    },
    isBusy: busy || completing || undoing,
    isCompleting: completing,
    isUndoing: undoing,
    errorMessage: error,
    dismissError: () => setError(undefined),
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
