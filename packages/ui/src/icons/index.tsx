import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * Hand-authored SVG icons (`design-system.md` §5.4).
 *
 * > **Decision: SVG components, not an icon font.** A font ships 60–200 KB of glyphs to load
 * > a dozen shapes, does not scale correctly with dynamic type on web, and cannot take a
 * > per-instance colour without a wrapper.
 *
 * They follow the mock's weight: **thin outlines, geometric, no filled glyphs** — the one
 * exception being the completed check, which is filled because completion is the single
 * state the product does render as solid.
 *
 * Named exports from one module rather than a file each: ESM tree-shaking is per-export, so
 * an unused icon still costs nothing, and thirty ten-line files is thirty files to open.
 *
 * This is the subset the primitives and the token gallery need. The rest of the ~30 arrive
 * with the screens that use them — an icon with no caller is a shape nobody has agreed on.
 */

export interface IconProps {
  /** 24 at the default type size; scales with it when paired with text. */
  size?: number;
  color: string;
}

const stroke = {
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/**
 * `size` is `| undefined` explicitly: under `exactOptionalPropertyTypes` an optional prop and
 * a prop that may be `undefined` are different types, and every icon forwards its own
 * possibly-absent `size` straight through.
 */
const Frame = ({
  size = 24,
  children,
}: {
  size?: number | undefined;
  children: React.ReactNode;
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {children}
  </Svg>
);

/** The completed check. **Filled** — see the note above. */
export const Check = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M4.5 12.5l5 5L19.5 7"
      stroke={color}
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Frame>
);

/** The `task` type marker. Tasks are the only type with a checkbox. */
export const CheckSquare = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={3.5} y={3.5} width={17} height={17} rx={4} stroke={color} {...stroke} />
    <Path d="M8 12.2l2.8 2.8L16.2 9.6" stroke={color} {...stroke} />
  </Frame>
);

/** `meal`. */
export const Bowl = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M3.5 11h17a8.5 8.5 0 0 1-8.5 8.5A8.5 8.5 0 0 1 3.5 11z"
      stroke={color}
      {...stroke}
    />
    <Path
      d="M9 7.5c0-1.5 1.5-1.5 1.5-3M14 7.5c0-1.5 1.5-1.5 1.5-3"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** `watch`. */
export const PlayRect = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={2.5} y={4.5} width={19} height={15} rx={3} stroke={color} {...stroke} />
    <Path d="M10.5 9.5l4.5 2.5-4.5 2.5z" stroke={color} {...stroke} />
  </Frame>
);

/** `event`. */
export const Ticket = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M3.5 8.5V6.8c0-.7.6-1.3 1.3-1.3h14.4c.7 0 1.3.6 1.3 1.3v1.7a2.5 2.5 0 0 0 0 7v1.7c0 .7-.6 1.3-1.3 1.3H4.8c-.7 0-1.3-.6-1.3-1.3v-1.7a2.5 2.5 0 0 0 0-7z"
      stroke={color}
      {...stroke}
    />
    <Path d="M14 6.5v11" stroke={color} strokeWidth={1.5} strokeDasharray="2 2.5" />
  </Frame>
);

/** `outing`. */
export const MapPin = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"
      stroke={color}
      {...stroke}
    />
    <Circle cx={12} cy={10} r={2.6} stroke={color} {...stroke} />
  </Frame>
);

/** `custom` — the visible **General** Plan kind. */
export const Diamond = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z" stroke={color} {...stroke} />
  </Frame>
);

export const Plus = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M12 5v14M5 12h14" stroke={color} {...stroke} />
  </Frame>
);

export const Close = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M6 6l12 12M18 6L6 18" stroke={color} {...stroke} />
  </Frame>
);

export const ChevronRight = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M9 5l7 7-7 7" stroke={color} {...stroke} />
  </Frame>
);

export const Search = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Circle cx={11} cy={11} r={6.5} stroke={color} {...stroke} />
    <Path d="M16 16l4.5 4.5" stroke={color} {...stroke} />
  </Frame>
);

export const Calendar = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={3.5} y={5} width={17} height={15.5} rx={3} stroke={color} {...stroke} />
    <Path d="M3.5 9.5h17M8 3.5V6M16 3.5V6" stroke={color} {...stroke} />
  </Frame>
);

export const Clock = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Circle cx={12} cy={12} r={8.5} stroke={color} {...stroke} />
    <Path d="M12 7.5V12l3 1.8" stroke={color} {...stroke} />
  </Frame>
);

export const Repeat = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M4 9.5A5 5 0 0 1 9 5h11m0 0l-3-3m3 3l-3 3" stroke={color} {...stroke} />
    <Path d="M20 14.5a5 5 0 0 1-5 4.5H4m0 0l3 3m-3-3l3-3" stroke={color} {...stroke} />
  </Frame>
);

/**
 * The Today tab. A sun rather than another calendar: Plans is already a calendar, and two
 * calendars side by side in a three-tab bar is two tabs a user cannot tell apart at a glance.
 */
export const Sun = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Circle cx={12} cy={12} r={4.5} stroke={color} {...stroke} />
    <Path
      d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** The Lists tab. Three lines with leading dots — a list, not a checklist. */
export const ListLines = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M9 6.5h11M9 12h11M9 17.5h11" stroke={color} {...stroke} />
    <Circle cx={4.8} cy={6.5} r={1.1} stroke={color} {...stroke} />
    <Circle cx={4.8} cy={12} r={1.1} stroke={color} {...stroke} />
    <Circle cx={4.8} cy={17.5} r={1.1} stroke={color} {...stroke} />
  </Frame>
);

/** The three nouns, in tab order. Keyed by route name so the layout does not switch on it. */
export const navIcons = {
  index: Sun,
  plans: Calendar,
  lists: ListLines,
} as const;

/** The per-type marker map, so a row does not switch on the type itself. */
export const typeIcons = {
  task: CheckSquare,
  meal: Bowl,
  watch: PlayRect,
  event: Ticket,
  outing: MapPin,
  custom: Diamond,
} as const;
