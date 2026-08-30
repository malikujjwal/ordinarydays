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

/** Neutral drag affordance: two columns of three dots. */
export const GripVertical = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01"
      stroke={color}
      {...stroke}
    />
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

export const ChevronLeft = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M15 5l-7 7 7 7" stroke={color} {...stroke} />
  </Frame>
);

/** A section that can be collapsed; the pair a disclosure toggles between. */
export const ChevronUp = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M5 15l7-7 7 7" stroke={color} {...stroke} />
  </Frame>
);

export const ChevronDown = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M5 9l7 7 7-7" stroke={color} {...stroke} />
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

/** A local or remote change that cannot currently reach the cloud. */
export const CloudOff = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M7.2 18H6a4 4 0 0 1-.7-7.9A6.7 6.7 0 0 1 17.8 9a4.5 4.5 0 0 1 .2 9h-1.2"
      stroke={color}
      {...stroke}
    />
    <Path d="M4 4l16 16" stroke={color} {...stroke} />
  </Frame>
);

/** Cloud work in progress. The arrows stay static; status text carries the live update. */
export const CloudSync = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M6.5 15H6a4 4 0 0 1-.7-7.9A6.7 6.7 0 0 1 17.8 6a4.5 4.5 0 0 1 1.4 8.8"
      stroke={color}
      {...stroke}
    />
    <Path d="M9 16a4 4 0 0 1 6.8-1.5M16 12.5v2.4h-2.4" stroke={color} {...stroke} />
    <Path d="M16 18a4 4 0 0 1-6.8 1.5M9 21.5v-2.4h2.4" stroke={color} {...stroke} />
  </Frame>
);

/** Cloud work completed successfully. */
export const CloudCheck = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M7.2 18H6a4 4 0 0 1-.7-7.9A6.7 6.7 0 0 1 17.8 9a4.5 4.5 0 0 1 .2 9h-1.2"
      stroke={color}
      {...stroke}
    />
    <Path d="M9 17l2.2 2.2L16 14.4" stroke={color} {...stroke} />
  </Frame>
);

/** The `⋯` overflow control (`interaction-contract.md` U6). Three dots, never a chevron. */
export const MoreHorizontal = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Circle cx={5} cy={12} r={1.4} stroke={color} {...stroke} />
    <Circle cx={12} cy={12} r={1.4} stroke={color} {...stroke} />
    <Circle cx={19} cy={12} r={1.4} stroke={color} {...stroke} />
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

// ── The List template catalogue (P3-46) ─────────────────────────────────────────────────

/**
 * The eleven glyphs `LIST_TEMPLATES` names and this registry did not have.
 *
 * P3-02 shipped a seventeen-entry catalogue naming fifteen icons; four existed. Nothing
 * surfaced it because no screen renders a list card yet, and P3-25 is the first that would
 * have — failing on eleven of the seventeen. Founder approval for new glyphs was given
 * 2026-08-25, which `plans-and-lists.md` §5.3 requires precisely so that adding a template
 * does not quietly become a design task.
 *
 * **Every one is distinct.** The catalogue's entries have to be tellable apart at a glance in
 * the style chooser, so none of them borrows another's shape to save drawing one — and the
 * three that carry things are separated by silhouette rather than by detail: the cart has
 * wheels, the bag is taller than it is wide under a round handle, and the suitcase is wider
 * than it is tall under a squared one. `templateIconSignatures` in the tests asserts it.
 */

/** `simple-list`. Plain lines — **not** {@link ListLines}, which is the Lists tab. */
export const List = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h10" stroke={color} {...stroke} />
  </Frame>
);

/**
 * `groceries`. A trolley: basket, handle and wheels.
 *
 * The wheels are what make it a cart rather than a bag at 24 px, which is the size the style
 * chooser renders it at.
 */
export const Cart = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M2.5 4.5h2.3l2.6 10.4h9.8l2.3-7.6H6.3" stroke={color} {...stroke} />
    <Circle cx={9.5} cy={19.3} r={1.4} stroke={color} {...stroke} />
    <Circle cx={17} cy={19.3} r={1.4} stroke={color} {...stroke} />
  </Frame>
);

/** `shopping`. A tote: tall tapered body under a round handle. */
export const Bag = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M6.4 8h11.2l1 11.1a1.6 1.6 0 0 1-1.6 1.8H7a1.6 1.6 0 0 1-1.6-1.8z"
      stroke={color}
      {...stroke}
    />
    <Path d="M9 8V6.4a3 3 0 0 1 6 0V8" stroke={color} {...stroke} />
  </Frame>
);

/** `packing`. Luggage: wide body, squared handle, two straps. */
export const Suitcase = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={2.5} y={7} width={19} height={13} rx={2.5} stroke={color} {...stroke} />
    <Path
      d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7"
      stroke={color}
      {...stroke}
    />
    <Path d="M8.2 7v13M15.8 7v13" stroke={color} {...stroke} />
  </Frame>
);

/** `bars-to-try`. A stemmed cocktail glass — nothing else in the set has a foot. */
export const Glass = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path d="M4.2 4.5h15.6L12 13.2z" stroke={color} {...stroke} />
    <Path d="M12 13.2v6.3M8.2 19.5h7.6" stroke={color} {...stroke} />
  </Frame>
);

/**
 * `coffee-shops`. A takeaway cup: lid, tapered body, sleeve.
 *
 * Deliberately **not** a steaming vessel. {@link Bowl} is already a rounded container with
 * two wisps above it, and a second one would be two catalogue entries a user cannot tell
 * apart — which is the failure §P3-46's edge case names.
 */
export const Cup = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={5} y={4.2} width={14} height={3.3} rx={1.2} stroke={color} {...stroke} />
    <Path
      d="M6.4 7.5l1.2 10.9a1.6 1.6 0 0 0 1.6 1.4h5.6a1.6 1.6 0 0 0 1.6-1.4l1.2-10.9"
      stroke={color}
      {...stroke}
    />
    <Path d="M7.3 13.2h9.4" stroke={color} {...stroke} />
  </Frame>
);

/** `date-ideas`. */
export const Heart = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M12 20.4l-1.7-1.6C5.2 14.2 2.8 11.9 2.8 9.1A5.3 5.3 0 0 1 8.1 3.8c1.6 0 3.1.8 4 2a4.8 4.8 0 0 1 3.9-2 5.3 5.3 0 0 1 5.2 5.3c0 2.8-2.4 5.1-7.5 9.7z"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** `favourite-restaurants`. Five points — {@link Diamond} is the four-point rhombus. */
export const Star = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M12 3.3l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17.1l-5.38 2.85 1.03-6L3.3 9.7l6-.9z"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/** `books-to-read`. Open, so the silhouette is not another rounded rectangle. */
export const Book = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Path
      d="M12 6.6C10.2 5.2 7.7 4.7 4.3 5.1v12.5c3.4-.4 5.9.1 7.7 1.5"
      stroke={color}
      {...stroke}
    />
    <Path
      d="M12 6.6c1.8-1.4 4.3-1.9 7.7-1.5v12.5c-3.4-.4-5.9.1-7.7 1.5"
      stroke={color}
      {...stroke}
    />
    <Path d="M12 6.6v12.5" stroke={color} {...stroke} />
  </Frame>
);

/** `gift-ideas`. Lid, box, ribbon and bow. */
export const Gift = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={3} y={7.6} width={18} height={4} rx={1.2} stroke={color} {...stroke} />
    <Path
      d="M4.6 11.6v7.4A1.9 1.9 0 0 0 6.5 20.9h11A1.9 1.9 0 0 0 19.4 19v-7.4"
      stroke={color}
      {...stroke}
    />
    <Path d="M12 7.6v13.3" stroke={color} {...stroke} />
    <Path
      d="M12 7.6c-1.6 0-3.6-.6-3.6-2.2A1.9 1.9 0 0 1 12 4.8a1.9 1.9 0 0 1 3.6.6c0 1.6-2 2.2-3.6 2.2z"
      stroke={color}
      {...stroke}
    />
  </Frame>
);

/**
 * `movies-to-watch`. A film strip: side rails and perforations.
 *
 * A **taller** frame than {@link PlayRect}'s deliberately, so the two do not share a
 * silhouette — `watchlist` and `tv-shows` already use `play-rect`, and this sits beside them
 * in the chooser.
 */
export const Film = ({ size, color }: IconProps) => (
  <Frame size={size}>
    <Rect x={2.5} y={3.5} width={19} height={17} rx={2} stroke={color} {...stroke} />
    <Path d="M7.6 3.5v17M16.4 3.5v17" stroke={color} {...stroke} />
    <Path
      d="M2.5 8.2h5.1M2.5 15.8h5.1M16.4 8.2h5.1M16.4 15.8h5.1"
      stroke={color}
      {...stroke}
    />
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
  event: MapPin,
  custom: Diamond,
} as const;

/**
 * The List template catalogue's markers, keyed by the exact `icon` string
 * `LIST_TEMPLATES` stores (P3-46).
 *
 * A map rather than a naming convention, for the reason `navIcons` and `typeIcons` are maps:
 * a renderer looks a value up instead of switching on it, and a template whose icon has no
 * glyph fails **here**, in one place, rather than as a blank square on a card. It is what
 * `apps/mobile`'s catalogue test asserts against — the assertion that would have caught this
 * gap at P3-02.
 *
 * Keyed by plain strings and not by a shared type: `packages/ui` may import no workspace
 * package (`repo-structure.md` §2.2), so the catalogue's own type cannot reach this file.
 * That is exactly why the test that pins the two together lives in `apps/mobile`, which can
 * see both.
 */
export const templateIcons = {
  bag: Bag,
  book: Book,
  bowl: Bowl,
  cart: Cart,
  'check-square': CheckSquare,
  cup: Cup,
  film: Film,
  gift: Gift,
  glass: Glass,
  heart: Heart,
  list: List,
  'map-pin': MapPin,
  'play-rect': PlayRect,
  star: Star,
  suitcase: Suitcase,
} as const;
