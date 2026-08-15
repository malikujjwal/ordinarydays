import type { Instant } from '@od/shared/time';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useClock } from '@/hooks/useClock';

const ONE_MINUTE_MS = 60_000;

function millisecondsToNextMinute(instant: Instant): number {
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) return ONE_MINUTE_MS;
  const remainder = epoch % ONE_MINUTE_MS;
  return remainder === 0 ? ONE_MINUTE_MS : ONE_MINUTE_MS - remainder;
}

/**
 * Reads the injected clock at minute boundaries and on foreground. The recursive timer is
 * stopped whenever the app is inactive, so it cannot wake the JS thread in the background.
 */
export interface MinuteTick {
  instant: Instant;
  /** Zero is the server-authored initial paint; later revisions are locally recomputed. */
  revision: number;
}

/**
 * `enabled` exists so a screen that needs the minute only while something is open does not pay
 * for a re-render every sixty seconds while it is closed. Today ticks always — UP NEXT and
 * EARLIER TODAY are defined against the current minute — whereas activity detail needs it only
 * for the snooze sheet's option pruning.
 */
export function useMinuteTicker(enabled = true): MinuteTick {
  const clock = useClock();
  const [tick, setTick] = useState(() => ({ instant: clock.now(), revision: 0 }));

  useEffect(() => {
    if (!enabled) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    };
    const schedule = () => {
      stop();
      timeout = setTimeout(() => {
        setTick((current) => ({ instant: clock.now(), revision: current.revision + 1 }));
        schedule();
      }, millisecondsToNextMinute(clock.now()));
    };
    const refreshAndSchedule = () => {
      setTick((current) => ({ instant: clock.now(), revision: current.revision + 1 }));
      schedule();
    };

    if (AppState.currentState === 'active') schedule();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAndSchedule();
      else stop();
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [clock, enabled]);

  return tick;
}
