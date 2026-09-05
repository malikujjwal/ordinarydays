import type { WallDate } from '@od/shared/time';

interface WindowProgress {
  readonly from: WallDate;
  readonly through: WallDate;
  readonly nextFrom: WallDate | null;
}

/** Calendar coverage may extend the rendered extent without exhausting the scrolling cursor. */
export function mergeWindowProgress(
  held: WindowProgress | undefined,
  incoming: WindowProgress,
): WindowProgress {
  if (held === undefined) return incoming;
  const advancesCursor =
    held.nextFrom !== null &&
    incoming.from <= held.nextFrom &&
    incoming.through >= held.nextFrom;
  return {
    from: held.from,
    through: held.through > incoming.through ? held.through : incoming.through,
    nextFrom: advancesCursor ? incoming.nextFrom : held.nextFrom,
  };
}
