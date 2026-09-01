import { Path, Rect, Svg } from 'react-native-svg';
import type { IconProps } from './index';

/**
 * The 16 pt **row markers** for the four Plan kinds (`design-system.md` §5.2, P3-49).
 *
 * ## Why these are separate from the registry glyphs
 *
 * Every registry icon is authored on a 24 viewBox at `strokeWidth: 1.5`, and §5.2 asks for a
 * `16 × 16` marker. Scaling the SVG scales the stroke with it, so a 16 pt marker drawn from
 * the registry renders at 1.0 px — thinner than the 1.5 px checkbox border directly above it
 * in the same column — and the interior detail turns to noise: the pin's inner circle lands
 * at r = 1.7 px, the bowl's steam at 2 px long.
 *
 * So the marker forms compensate the stroke to **1.9 viewBox units**, which renders at
 * ~1.27 px at 16 pt: present, and still visibly lighter than the checkbox, which is what
 * keeps a non-interactive mark from reading as a control. `bowl` and `map-pin` also drop
 * their interior and keep only the silhouette — a pin is still a pin without its dot, a bowl
 * still a bowl without steam. The full forms stay in `index.tsx` for the 24 pt and 44 pt
 * surfaces (cards, the catalogue, the kind chooser). The Phase 3 screen board records the
 * measurements.
 *
 * The 1.9 weight is deliberate and asserted in `markers.test.tsx`; the registry's own
 * grammar test pins the shared 1.5 and does not see this module.
 */

/** Rendered stroke ≈ 1.27 px at 16 pt; lighter than the 1.5 px checkbox border. */
export const MARKER_STROKE_WIDTH = 1.9;

/** The one size a marker is drawn at (§5.2). */
export const MARKER_SIZE = 16;

const stroke = {
  strokeWidth: MARKER_STROKE_WIDTH,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const Frame = ({
  size = MARKER_SIZE,
  children,
}: {
  size?: number | undefined;
  children: React.ReactNode;
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {children}
  </Svg>
);

/** `meal` — the bowl's silhouette, no steam. */
export const BowlMarker = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M3.5 11h17a8.5 8.5 0 0 1-8.5 8.5A8.5 8.5 0 0 1 3.5 11z"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** `watch` — the play triangle survives; it is the whole meaning of the glyph. */
export const PlayRectMarker = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={2.5} y={4.5} width={19} height={15} rx={3} stroke={color} {...stroke} />
    <Path d="M10.5 9.5l4.5 2.5-4.5 2.5z" stroke={color} {...stroke} />
  </Frame>
);

/** `event` — the pin's outline, no inner dot. */
export const MapPinMarker = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** `custom` — the visible **General** kind. The only diamond of the four. */
export const DiamondMarker = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z" stroke={color} {...stroke} />
  </Frame>
);
