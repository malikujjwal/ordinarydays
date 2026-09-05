import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PLANS_WINDOW_DAYS } from '../model/plansFeed';
import type { PlansView } from './usePlans';

export interface UnloadedBoundary {
  readonly from: string;
  readonly to: string;
}

/** Ordinary scrolling may load an unknown interval; a calendar landing may not. */
export function usePlansBoundaryNavigation(loadRange: PlansView['loadRange']) {
  const userScrolling = useRef(false);
  const visibleBoundary = useRef<UnloadedBoundary | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const failedRef = useRef<string | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const load = useCallback(
    (boundary: UnloadedBoundary) => {
      if (controller.current !== undefined) return;
      const next = new AbortController();
      controller.current = next;
      setPending(boundary.from);
      failedRef.current = undefined;
      setFailed(undefined);
      const end = addWallDays(boundary.from, PLANS_WINDOW_DAYS - 1);
      void loadRange(
        'upcoming',
        {
          from: boundary.from as WallDate,
          through: (end < boundary.to ? end : boundary.to) as WallDate,
        },
        next.signal,
      )
        .catch(() => {
          if (!next.signal.aborted) {
            failedRef.current = boundary.from;
            setFailed(boundary.from);
          }
        })
        .finally(() => {
          if (controller.current !== next) return;
          controller.current = undefined;
          if (!next.signal.aborted) setPending(undefined);
        });
    },
    [loadRange],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadVisible = useCallback(() => {
    const boundary = visibleBoundary.current;
    if (boundary !== undefined && boundary.from !== failedRef.current)
      loadRef.current(boundary);
  }, []);
  const beginScroll = useCallback(() => {
    userScrolling.current = true;
    loadVisible();
  }, [loadVisible]);
  const selectDate = useCallback(() => {
    userScrolling.current = false;
  }, []);
  const visible = useCallback(
    (boundary: UnloadedBoundary | undefined) => {
      visibleBoundary.current = boundary;
      if (userScrolling.current) loadVisible();
    },
    [loadVisible],
  );
  return { load, pending, failed, beginScroll, selectDate, visible };
}
