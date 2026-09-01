import type { ActivityType } from '@od/shared/types';
import {
  BowlMarker,
  DiamondMarker,
  type IconProps,
  MapPinMarker,
  PlayRectMarker,
} from '@od/ui';

/**
 * `type → marker glyph` for the leading column of an agenda row (`design-system.md` §5.2,
 * P3-49). Pure: no theme, no capability, no `hasCheckbox`.
 *
 * The four Plan kinds each get their own glyph — the §5.2 table, which is what the icon
 * registry implements — and `custom` (the visible **General** kind) is the only diamond.
 *
 * `task` resolves to **no glyph**. A task's §5.2 icon is the checkbox itself, and the only
 * way a task reaches the marker branch at all is P2-50's unacknowledged create, where the
 * checkbox is deliberately *absent rather than disabled* so a capability probe finds nothing.
 * Drawing a check-square outline there would put back, as decoration, the control that rule
 * removed. The column stays reserved so the title does not shift when the checkbox arrives.
 */
export type MarkerGlyph = 'bowl' | 'play-rect' | 'map-pin' | 'diamond';

export interface TypeMarker {
  glyph: MarkerGlyph;
  Icon: (props: IconProps) => React.ReactElement;
}

const MARKERS: Record<Exclude<ActivityType, 'task'>, TypeMarker> = {
  meal: { glyph: 'bowl', Icon: BowlMarker },
  watch: { glyph: 'play-rect', Icon: PlayRectMarker },
  event: { glyph: 'map-pin', Icon: MapPinMarker },
  custom: { glyph: 'diamond', Icon: DiamondMarker },
};

export function typeMarker(type: ActivityType): TypeMarker | undefined {
  return type === 'task' ? undefined : MARKERS[type];
}
