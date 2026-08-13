# Design system

**Status:** canonical for tokens, colour, primitives, and layout. Gestures, states, undo and
accessibility behaviour are owned by
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md); this
document says what things look like and what they are built from. Where the two touch —
hit targets, contrast, motion — this document restates the requirement as a token so it
cannot be got wrong by accident.

Everything here lives in `packages/ui/src/theme/` and is consumed through
`useTheme()` / `useStyles()` (`coding-standards.md` §8.7).

> **Decision — visual refresh from the founder's design reference (2026-08-08).** The
> founder produced a Claude Design mock ("Planner", four screens: Today, Plans, Lists,
> People) and directed the app to **loosely follow it**: adopt its visual language — the
> warm cream and olive-tinted neutrals, the mulberry accent, the serif display face, the
> per-screen presentation variety — while keeping every behavioural contract in the
> product docs unchanged. Where the mock and the specs disagree on *behaviour* (e.g. the
> mock shows date ranges and an Invitations tab), the specs win; where they disagree on
> *appearance*, the mock wins. The tokens below were extracted from the mock's source and
> contrast-checked; values that failed AA were nudged and are marked. The original dark-mode
> values were derived rather than designed and were reviewed through the P1-22 token gallery.
>
> **Dark-mode palette replacement — founder decision (2026-08-12, P2-40).** The founder
> replaced those derived values with the reviewed palette in §5.1 and §5.2. The exact supplied
> accent `#9F667F` does not meet the 4.5:1 body-text threshold on the new background or raised
> surface, so it is a non-text accent. Readable labels use semantic text tokens; filled
> controls use the accessible accent treatment specified below. This preserves every supplied
> colour without weakening the contrast gates.
>
> **Light-mode palette replacement — founder decision (2026-08-12, P2-40; newer note).**
> The founder also replaced the mock-derived light values with the warm paper palette in
> §5.1 and §5.2. Three supplied roles are deliberately narrower than their plain-language
> names: muted `#978F84` is disabled/nonessential decoration rather than readable hint text;
> border `#D3C9BC` is a decorative field/chip outline rather than the sole control boundary;
> and accent `#8B6374` is a fill/icon colour rather than body text on `surface`. Readable
> hints and required boundaries use `#6E675F`; accent text and focus use `#795565`. All
> founder-supplied values remain exact without weakening the 4.5:1 text or 3:1 control gates.

---

## 1. What this should feel like

Ordinary Days is where someone puts dinner on Thursday and the show a friend recommended. It
is not a work tool and must not look like one.

Five rules that the tokens below encode:

| Rule | Consequence |
| --- | --- |
| **Quiet by default** | Cream paper, warm ink. Colour appears in one accent per row or card and nowhere else. No coloured backgrounds behind ordinary rows, no status bars of chips, no rings of progress — the one sanctioned progress bar is the Today day-line (§7.1) and a list card's fill line (§7.2). |
| **Content is the interface** | The title of a row is the largest, darkest thing on it. Chrome — times, icons, avatars, type markers — is smaller and lighter, but never below 4.5:1. |
| **Warm, not corporate** | The neutral ramp is warm and faintly olive, never blue-grey. The accent is mulberry, not SaaS blue. Success is olive, warning is ochre — garden colours, not traffic lights. |
| **One serif moment per screen** | Screen titles and the wordmark are set in a serif (`display`/`title`, §3). Everything else is the system sans. The serif is what makes the product feel like a notebook instead of a dashboard; using it anywhere below `title` dilutes it. |
| **Nothing celebrates** | No confetti, no streaks, no badges, no "Great job!". Completing something makes it quieter, not louder (`interaction-contract.md` §5.2). |

The three tabs also **intentionally do not look alike**: Today is a timeline, Plans is a
column of event cards, Lists is a grid of collection cards (§7). They share every token, so
they read as one product — the variety is in the layout, never in the palette.

---

## 2. Spacing

A 4-point base. Every margin, padding, and gap in the product is one of these. There are no
intermediate values.

```ts
export const space = {
  0: 0,
  1: 2,    // hairline separation, icon-to-text nudges
  2: 4,    // inside a chip, between stacked metadata lines
  3: 8,    // minimum gap between adjacent hit targets (interaction-contract.md §2)
  4: 12,   // between a row's leading control and its title
  5: 16,   // standard horizontal screen gutter, standard row vertical padding
  6: 20,   // between a section header and its first row; card padding
  7: 24,   // between sections
  8: 32,   // above a screen's first section, around an empty state
  9: 40,
  10: 48,  // large vertical rhythm: between a sheet's header and its body
  11: 64,  // empty-state top offset
} as const;
```

| Use | Token |
| --- | --- |
| Screen horizontal gutter | `space[5]` (16) at `compact`, `space[7]` (24) at `medium` and above |
| Row vertical padding | `space[5]` top and bottom, giving a 56 pt row at body size |
| Card internal padding | `space[6]` (20) |
| Gap between cards in a column or grid | `space[4]` (12) |
| Gap between adjacent interactive elements | `space[3]` (8) minimum, never less |
| Between sections | `space[7]` (24) |
| Sheet content padding | `space[5]` horizontal, `space[6]` vertical |
| Between a label and its field | `space[2]` (4) |

---

## 3. Type

Sizes are in points and scale with the platform's dynamic type; `allowFontScaling` is never
`false` (`interaction-contract.md` §6.3). Line heights are the values at the default size.

**Two families.**

- **Serif — Newsreader**, for `display` and `title` only. Bundled via `expo-font` as a
  latin-subset variable font (one file, ~40 KB woff2); falls back to the platform serif
  (`Georgia, 'Times New Roman', serif` on web) until loaded, and text never blocks on it.
  Recorded in `tech-stack.md` in the P1-22 PR that adds the dependency. This is the mock's
  face and the product's one typographic signature.
- **Sans — the platform system font** for everything else: SF on iOS, the system stack on
  web (`-apple-system, "Segoe UI", Roboto, sans-serif`). The mock uses Geist; the system
  stack is metrically close enough that bundling a second webfont buys nothing an everyday
  planner needs.

```ts
export const type = {
  display:    { family: 'serif', size: 34, lineHeight: 38, weight: '500', letterSpacing: -0.4 }, // lineHeight ≈ 1.1, per the mock's tight display setting
  title:      { family: 'serif', size: 24, lineHeight: 29, weight: '500', letterSpacing: -0.2 },
  heading:    { family: 'sans',  size: 17, lineHeight: 22, weight: '600', letterSpacing: -0.1 },
  body:       { family: 'sans',  size: 17, lineHeight: 22, weight: '400', letterSpacing: -0.1 },
  bodyStrong: { family: 'sans',  size: 17, lineHeight: 22, weight: '600', letterSpacing: -0.1 },
  subhead:    { family: 'sans',  size: 15, lineHeight: 20, weight: '400', letterSpacing: 0 },
  footnote:   { family: 'sans',  size: 13, lineHeight: 18, weight: '400', letterSpacing: 0 },
  footnoteStrong: { family: 'sans', size: 13, lineHeight: 18, weight: '600', letterSpacing: 0 },
  caption:    { family: 'sans',  size: 11, lineHeight: 14, weight: '600', letterSpacing: 0.8 }, // uppercase; the mock tracks its section labels wide (.06–.08em)
} as const;
```

| Role | Token | Used for |
| --- | --- | --- |
| Screen title | `display` (serif) | `Today`, `Plans`, `Lists`, `People`, a plan's name on its detail screen |
| Wordmark, sheet and dialog title | `title` (serif for the wordmark and screen-level surfaces; sheets may use `heading` when the sheet is a control, not a place) | `Ordinary Days` in the rail, reschedule sheet, confirmation dialogs |
| Card and group title | `heading` | Plan card title, list card title, `Field` group labels |
| Row title, primary content | `body` | Every row's title, note bodies, update entries |
| Emphasised row title | `bodyStrong` | The UP NEXT card title, an unread notification |
| Row subtitle, secondary content | `subhead` | Type-derived subtitles, participant summaries, empty-state guidance |
| Metadata | `footnote` | Time column, date chips, relative times, balance lines, `+n more`, `Updated 3 days ago` |
| Emphasised metadata | `footnoteStrong` | The time on the UP NEXT card, a balance figure, `2 of 6 done` |
| Section header | `caption`, uppercase | `UP NEXT · IN 2H 15M`, `EARLIER TODAY`, `SCHEDULE`, `NOW`, `THURSDAY, AUGUST 6` |

Rules: titles wrap to two lines before truncating and never truncate at one line at the
default size. There are exactly nine text styles; a tenth is a decision, not a preference.
The point sizes above are the **mobile** scale; the mock's web rendering is denser
(15–15.5 px body) and that density comes from the `expanded` layout (§8), not from a
different type scale.

---

## 4. Radius, elevation, motion

### 4.1 Radius

```ts
export const radius = {
  none: 0,
  sm: 8,     // chips, checkbox, small controls
  md: 12,    // buttons, fields, icon squircles, segmented-control track
  lg: 16,    // cards: plan cards, list cards, the People search field
  xl: 22,    // the UP NEXT card — the one hero surface
  sheet: 28, // sheets (top corners), dialogs on web
  pill: 999, // avatars, RSVP pills, filter chips, the Add button
} as const;
```

Rows on Today are not cards and have no radius. The mock is rounder than the previous
scale (cards 16, sheets 28) and that softness is part of its warmth — but the rule stands:
only cards, sheets, and the hero surface are rounded. Rounding everything produces the
"corporate dashboard" look this product avoids.

### 4.2 Elevation

Five levels, values from the mock (soft, large-blur, negative-spread shadows in warm ink —
never harsh). On iOS these are shadows; on web they compile to `boxShadow` through React
Native Web.

| Token | Use | Light shadow |
| --- | --- | --- |
| `e0` | Ordinary rows, screen background | none |
| `e1` | Hovered row on web, segmented control's active segment | `0 1px 2px rgba(38,42,40,0.05)` |
| `e2` | Plan card, list card, expense card | `0 1px 2px rgba(38,42,40,0.05), 0 10px 24px -16px rgba(38,42,40,0.28)` |
| `e3` | Sheets, menus, popovers, the UP NEXT card | `0 1px 2px rgba(38,42,40,0.04), 0 12px 24px -20px rgba(90,50,72,0.55)` on the UP NEXT card (mulberry-tinted); `0 10px 30px -12px rgba(38,42,40,0.35)` elsewhere |
| `e4` | Toast | `0 12px 30px -14px rgba(38,42,40,0.45)` |

The filled `primary` Button additionally carries the mock's accent glow —
`0 8px 18px -8px rgba(150,93,120,0.85)` — defined once as `eAccent` and used nowhere else.

> **Decision:** in dark mode, elevation is expressed as **surface lightening plus a 1 px
> border**, not as a shadow. A shadow on a near-black background is invisible, so a dark UI
> that relies on shadows loses all depth cues. `e1`–`e4` map to `surfaceRaised`,
> `surfaceRaised2`, `surfaceOverlay` and a `borderSubtle` outline. The `elevation()` helper
> in `theme/elevation.ts` returns the right style for the active scheme, so components ask
> for `e2` and never branch.

### 4.3 Motion

Nothing exceeds 300 ms (`interaction-contract.md` §6.5).

```ts
export const motion = {
  duration: { instant: 0, fast: 120, base: 180, slow: 260, max: 300 },
  easing: {
    standard:   'cubic-bezier(0.2, 0, 0, 1)',    // most transitions
    decelerate: 'cubic-bezier(0, 0, 0, 1)',      // something entering
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',    // something leaving
  },
  spring: { damping: 20, stiffness: 260, mass: 1 },  // checkbox, swipe release
} as const;
```

| Interaction | Duration | Easing |
| --- | --- | --- |
| Press feedback (opacity/scale) | `fast` | `standard` |
| Checkbox check | spring | — |
| Row insert / remove | `base` | `decelerate` in, `accelerate` out |
| Today completion relocation | `fast` checked/struck hold, then `base` fade out | `accelerate` out; no travel animation |
| Toast in / out | `base` | `decelerate` / `accelerate` |
| Sheet present / dismiss | `slow` | `decelerate` / `accelerate` |
| Screen transition | platform default, capped at `max` | platform |
| Swipe action tracking | none — it follows the finger | — |

**Reduce Motion.** `useReducedMotion()` from Reanimated gates every one of these:
transitions become cross-fades, insert/remove animations are removed, the toast appears
without sliding. Swipe tracking is unaffected — direct manipulation is not decorative
motion. Every animated component reads the hook; there is no component that animates
unconditionally.

---

## 5. Colour

### 5.1 Semantic tokens

Components never reference a hex value or a ramp step. They reference a semantic token. The
ramps exist inside `theme/colors.ts` and are not exported.

Light and dark values are the founder-approved P2-40 palettes. Values not supplied for
safety/status semantics (`danger`, `scrim`, and the light sage/ochre/type families) remain
independently contrast-checked.

| Token | Light | Dark | Contrast (light / dark) | Use |
| --- | --- | --- | --- | --- |
| `surface` | `#F1EDE5` | `#171613` | — | Screen background — warm cream, never white |
| `surfaceRaised` | `#F8F5EF` | `#211F1B` | — | Main paper surface: cards, sheets, the segmented control's active segment |
| `surfaceRaised2` | `#FCFAF6` | `#292620` | — | A card on a card; elevation-required surfaces |
| `surfaceOverlay` | `#FCFAF6` | `#292620` | — | Menus, toasts and `e3`/`e4` surfaces |
| `surfaceInput` | `#F0EBE3` | `#1C1B18` | — | Fields, selects and native/web picker surfaces |
| `surfaceSunken` | `#ECE7DE` | `#1C1B18` | — | Rail selection pill, segmented-control track, grouped areas, icon squircles' base, skeletons |
| `scrim` | `rgba(38,42,40,0.40)` | `rgba(0,0,0,0.60)` | — | Behind a modal sheet |
| `textDisplay` | `#292621` | `#F4F0E8` | 12.9:1 / 15.9:1 | Serif display and title ink — the darkest thing on any screen |
| `textPrimary` | `#292621` | `#F4F0E8` | 12.9:1 / 15.9:1 | Row titles and body copy |
| `textSecondary` | `#6E675F` | `#D0C9BE` | 4.8:1 / 11.0:1 | Subtitles, metadata and times |
| `textMuted` | `#6E675F` | `#9F988D` | 4.8:1 / 6.3:1 | Readable hints, placeholders and tertiary metadata; never a disabled state |
| `textDisabled` | `#978F84` | `#6E6C63` | 2.7:1 / 3.1:1 | Disabled labels and nonessential decoration only — never carries meaning |
| `textInverse` | `#FFFDF9` | `#171613` | — | On an accessible filled accent, sage, ochre, or danger surface |
| `textAction` | `#795565` | `#F4F0E8` | 5.4:1 / 15.9:1 | Readable text actions: light `accentDeep`, dark `textPrimary`; semantic alias, no new palette value |
| `border` | `#E1DAD0` | `#34312B` | — | Dividers, separators, hairlines and the timeline's connector line. Decorative only. |
| `borderSubtle` | `#D3C9BC` | `#34312B` | — | Decorative light field/chip outline; never the sole control boundary or focus indicator |
| `borderStrong` | `#6E675F` | `#9F988D` | 4.8:1 / 6.3:1 | Required control outlines and checkbox border |
| `accent` | `#8B6374` | `#9F667F` | 4.3:1 / 4.0:1 | Non-text fills, icons, progress and decoration. **Never text, in either scheme** — the ratios are why |
| `accentDeep` | `#795565` | `#AD748C` | 5.4:1 / 4.9:1 | Light: hover/pressed and readable accent text. Dark: pressed emphasis only — it is 4.4:1 on dark `surfaceRaised`, so dark text actions use `textPrimary`/`textSecondary` |
| `accentSurface` | `#EEE3E7` | `#2D2026` | — | UP NEXT card fill, selected-row tint, accent chip background |
| `accentBorder` | `#C7AAB6` | `#5A3A49` | — | Decorative accent-surface outline; never a control boundary |
| `accentControl` | `#8B6374` | `#AD748C` | 5.0:1 / 4.9:1 with `textInverse` | The filled primary control's surface. Light resolves to `accent`, dark to `accentDeep`, because dark `accent` carries a label at only 4.0:1 |
| `success` | `#616F45` | `#A7B690` | 4.7:1 / 8.4:1 | Sage. Completed check, RSVP going, `Owes you $42.50`. Darkened from the supplied `#667747` (4.19:1) on the founder's 2026-08-12 decision, because it carries a balance figure |
| `successSurface` | `#EDF0E2` | `#252A20` | — | Completed check fill, sage icon squircles |
| `warning` | `#8A6520` | `#E3C07A` | 5.0:1 / 10.4:1 | Ochre. Overdue chip, pending sync, RSVP maybe, `You owe $18.00`, feed-note lines on cards |
| `warningSurface` | `#F6F0E2` | `#332B1C` | — | Overdue chip fill, ochre icon squircles |
| `danger` | `#B3261E` | `#F08579` | 6.2:1 / 7.3:1 | Destructive actions, error states. Not in the mock — it has nothing destructive on screen — carried over unchanged. |
| `focusRing` | `#795565` | `#9F667F` | ≥ 3:1 against both surfaces | Keyboard focus, 2 px, never removed |

**WCAG compliance, stated:** every readable `text*` token except `textDisabled` meets **AA at
4.5:1** against both `surface` and `surfaceRaised` in both schemes; `borderStrong`,
`focusRing`, and every control boundary meet **3:1**. `textDisabled` is exempt because
disabled controls are exempt from AA, and because disabled state is never the sole carrier
of meaning (`interaction-contract.md` §6.4). The `packages/ui` test suite asserts every
pair programmatically, so a token change that breaks AA fails CI rather than shipping —
including any adjustment made to either founder-approved palette.

**Accent and quiet-border usage.** The founder-approved `accent` values are deliberately not
body-text tokens on any page surface. Light text actions and focus use `accentDeep`; dark
text actions and labels use `textPrimary` or `textSecondary` according to hierarchy. Filled
controls use `accentControl` with `textInverse` — one token, so no component branches on the
scheme to pick a fill.

**Text on `accentSurface` is `textPrimary` in light.** `textSecondary` measures 4.45:1 there,
so on the founder's 2026-08-12 decision the supplied `accentSurface` is kept exactly and the
role narrows instead of the value moving. Dark carries both (13.7:1 and 9.5:1) and keeps its
primary/secondary hierarchy.

`accentBorder` and `borderSubtle` are decorative and cannot replace `borderStrong` or
`focusRing`; the test suite asserts they stay **below** 3:1 so that promoting one is a
deliberate act rather than an accident. The role, underline, label or control shape still
communicates interactivity without colour alone.

**Increase Contrast.** When the system setting is on, `border` is replaced by
`borderStrong`, `textSecondary` moves to `textPrimary`, and de-emphasis is carried by size
and weight alone.

**Colour is never the only carrier of meaning.** Completion also has a checkmark and a
struck title; a pending RSVP also says `Awaiting reply`; overdue also shows its original
date; balance direction is always words (`Owes you` / `You owe` / `Settled up`), with
olive/ochre as reinforcement only.

### 5.2 Per-activity-type accent

One accent per stored activity type, drawn from the refreshed families (mulberry, olive,
ochre, rosewood, stone — no blues). Used for the row's type marker, the icon squircle on
cards, the detail header's tint, and the explicit Plan-kind choice after the user taps
**Plan**. The global Add sheet uses neutral **Task / Plan / List item** destinations; it
does not present type inference as an accent choice. Type colour is never used as a row
background.

| `type` | Icon | Light | Dark | Contrast (light/dark) |
| --- | --- | --- | --- | --- |
| `task` | `check-square` (a checkbox — tasks are the only type with one) | `#6E675F` | `#9F988D` | 4.8:1 / ≥ 3:1 |
| `meal` | `bowl` | `#8A6520` | `#E3C07A` | 5.0:1 / ≥ 3:1 |
| `watch` | `play-rect` | `#616F45` | `#A7B690` | 4.7:1 / ≥ 3:1 |
| `event` | `map-pin` | `#8C4A5E` | `#AD748C` | 6.1:1 / ≥ 3:1 |
| `custom` | `diamond` | `#6E675F` | `#9F988D` | 4.8:1 / ≥ 3:1 |

Non-task rows render a small non-interactive marker in the type's accent — outlined, in
the mock's style (a diamond outline for events, a ring for meals), sized `16 × 16` and
`accessibilityElementsHidden` — its meaning goes into the row's label instead
(`interaction-contract.md` §6.2). On cards the same accent tints a `44 × 44` icon
**squircle** (`radius.md`, the type's `*Surface` tint as fill, the accent as glyph).

### 5.3 Row subtitle format per type

The `subtitle` field on `AgendaItem` (`api-contract.md` §2.2). Built server-side, one
format per type, `·` as the separator. Omitted entirely when there is nothing to say.

| `type` | Format | Example |
| --- | --- | --- |
| `task` | Parent plan name if it is a prep task, otherwise none | `New York Trip` |
| `meal` | `Meal · <mealSlot>` when a slot is set, otherwise `Meal` | `Meal · Dinner` |
| `watch` | `S<season> E<episode>` when both are set; else `<mediaKind>`; else `<service>` | `S2 E4` |
| `event` | `<organiser>` if set, else `<locationLabel>` | `Dr Patel` |
| `custom` | None | — |

Any Plan with explicitly selected participants appends the avatar stack in the trailing
slot, not the subtitle. Tasks do not have direct participants.

### 5.4 Icons

> **Decision: hand-authored SVG components in `packages/ui/src/icons/`, rendered with
> `react-native-svg`.** An icon font (`@expo/vector-icons`) ships 60–200 KB of glyphs to load
> a dozen shapes, does not scale correctly with dynamic type on web, and cannot take a
> per-instance colour without a wrapper. The product needs roughly 30 icons. Each is a
> ~15-line component taking `size` and `color`, tree-shaken per import.
> `react-native-svg` is an Expo-managed package installed with `npx expo install`, so it is
> SDK-pinned like the other RN packages (`tech-stack.md` §6 version policy). It is recorded
> in `tech-stack.md` §2.2. Icons follow the mock's weight: thin outlines, geometric, no
> filled glyphs except the completed check.

Icons are 24 × 24 at the default type size and scale with it when paired with text. Icon-only
controls keep a fixed 44 pt target and do not scale
(`interaction-contract.md` §6.3).

---

## 6. Component inventory

Everything in `packages/ui/src/primitives/`. These know nothing about activities, lists, or
people (`repo-structure.md` §2.2). Props below are the required surface; each also takes
`testID` and passes through accessibility props.

| Component | Props | States |
| --- | --- | --- |
| `Text` | `variant` (the nine type roles), `color` (`textDisplay` \| `textPrimary` \| `textSecondary` \| `textMuted` \| `textDisabled` \| `textAction` \| `accent` \| `danger` \| `success` \| `warning` \| `inverse`), `numberOfLines`, `align` | — |
| `Button` | `variant` (`primary` — accent pill with `eAccent` \| `secondary` \| `ghost` \| `danger`), `size` (`md` 44 \| `lg` 52), `label`, `icon?`, `onPress`, `loading`, `disabled`, `fullWidth` | default, pressed, loading (spinner after 400 ms), disabled, focus-visible |
| `IconButton` | `icon`, `label` (required — it is the accessible name), `onPress`, `variant` (`ghost` \| `filled`), `tone` (`neutral` \| `accent`), `disabled` | default, pressed, disabled, focus-visible. Always 44 × 44. |
| `Row` | `onPress?`, `leading?`, `title`, `subtitle?`, `trailing?`, `accent?`, `dimmed`, `struck`, `swipeActions?`, `accessibilityActions` | default, pressed, hovered (web), focused, dimmed (completed), disabled |
| `Card` | `elevation` (`e1` \| `e2` \| `e3`), `radius` (`lg` \| `xl`), `padding` (a `space` token), `onPress?` | default, pressed, focused |
| `IconTile` | `icon`, `tint` (a type or template accent), `size` (44) | The squircle on plan and list cards. Non-interactive; `accessibilityElementsHidden`. |
| `SegmentedControl` | `segments` (`{ label, count? }[]`), `selectedIndex`, `onChange` | `surfaceSunken` pill track (`radius.md`), active segment `surfaceRaised` + `e1`. Counts render as a `footnote` beside the label. |
| `ProgressBar` | `value` (0–1), `tone` (`accent` \| `neutral`) | 4 pt tall, `radius.pill`, track `border`, fill `accent`. No animation beyond `base` width easing; no percentage text of its own. |
| `Sheet` | `open`, `onClose`, `title?`, `detents` (`['medium','large']`), `dismissible` | closed, presenting, open, dismissing. `radius.sheet` top corners. Focus trapped; returns focus on close. |
| `Field` | `label`, `value`, `onChangeText`, `placeholder?`, `error?`, `hint?`, `required`, `multiline`, `keyboardType`, `inputAccessoryViewID?`, `maxLength` | default, focused, filled, error, disabled. `surfaceInput` fill, `radius.lg`, decorative `borderSubtle` at rest and the accessible `focusRing` on focus. A number-pad field in a sheet links an iOS Done accessory because that keyboard has no Return key. |
| `SelectField` | `label`, `value`, `options`, `onChange`, `error?`, `hint?`, `disabled` | collapsed, focused, open, selected, error, disabled. Uses the same `surfaceInput` / `borderSubtle` / `focusRing` treatment as `Field`; native opens one accessible option sheet and web uses one styled platform `<select>`. |
| `DatePicker` | `label`, `value` (`WallDate \| null`), `onChange`, **`today`**, `quickOptions`, `min?`, `max?`, `disabled` | default, open, cleared. Native wheel on iOS, `<input type="date">` on web. |
| `TimePicker` | `label`, `value` (`WallTime \| null`), `onChange`, `minuteInterval` (5), `allowClear`, `openAt?`, `presentation?` (`sheet` \| `inline`), `disabled` | default, open, cleared (meaning "anytime that day"). A picker inside an existing native sheet uses `inline`, so it never presents a nested modal. |
| `Checkbox` | `checked`, `onChange`, `label` (accessible name), `disabled` | unchecked (borderStrong ring), checked (olive fill, white check, spring), disabled, focus-visible. 44 × 44 target, 24 × 24 visual. |
| `Avatar` | `displayName`, `imageUrl?`, `size` (`sm` 24 \| `md` 28 \| `lg` 48) | image, **tinted-initials fallback** (two letters, `footnoteStrong`, disc filled with a stable per-person tint drawn from the `*Surface` family), loading |
| `AvatarStack` | `people`, `max` (4), `size` | Renders up to `max` overlapped by 6 pt plus a `+n` disc. Non-interactive on rows. |
| `Chip` | `label`, `accessibilityLabel?`, `icon?`, `tone` (`neutral` \| `accent` \| `warning` \| `danger` \| `success`), `onPress?`, `selected` | default, selected (accent tint fill), pressed, disabled. Default neutral chips may use decorative `borderSubtle`; focus still uses `focusRing`. Also carries provenance labels (`From screenshot`, `From link`) in `neutral`, `surfaceSunken` fill. |
| `SectionHeader` | `title`, `count?`, `action?` | default only. `caption` type, uppercase, wide-tracked, `accessibilityRole="header"`. |
| `EmptyState` | `heading`, `body?`, `action?` | One heading line, at most one body line, at most one action. No illustration. |
| `Toast` | `message`, `action?` (`{ label, onPress }`), `tone` (`neutral` \| `error`), `duration` (6000 \| 10000) | entering, visible, exiting. One at a time; a new one commits the previous. `accessibilityLiveRegion="polite"`. |
| `Skeleton` | `shape` (`row` \| `card` \| `text`), `count` | Shimmer off under Reduce Motion. Minimum display 200 ms. |

Two rules for all of them: every interactive primitive has a minimum 44 × 44 hit target
regardless of its visual size, and none of them reads the API or the navigation stack.

> **Amended 2026-08-09 (P1-22), two rows.** `DatePicker`'s `quickOptions` listed three chips
> where [`../01-product/activities.md`](../01-product/activities.md) §3.4 lists five —
> `Today`, `Tomorrow`, `This weekend`, `Next week`, `Pick a date`. The product doc owns
> behaviour and wins ([`agent-playbook.md`](agent-playbook.md) §2), so the component ships
> all five and this table no longer names a subset.
>
> Both pickers also take a **`today`** / **`openAt`** value rather than reading a clock.
> `packages/ui` has no time source by design: a primitive that called `new Date()` would
> resolve `This weekend` differently under test than on a device, which is the failure
> [`coding-standards.md`](coding-standards.md) §11 smell 6 names. The screen supplies the
> user's own wall date in their own zone, because it is the only layer that knows it.

---

## 7. Anatomies

### 7.1 Today — the timeline

The day header, the hero, and the rows. From the top:

```
 THURSDAY, AUGUST 6                                      ← caption, textSecondary
 Today                              2 of 6 done  (+ Add) ← display (serif) · footnoteStrong · primary Button (pill)
 ━━━━━━━━━━━━━━━━──────────────────────────────          ← ProgressBar: accent fill, border track
```

The date caption, the serif screen title, the day's completion count, and the one
sanctioned progress bar. `2 of 6 done` counts everything on Today; the bar fills with
`accent`. This is information, not celebration — it never animates on completion beyond
the `base` width ease, and at `0 of n` it renders empty, not hidden.

**The UP NEXT card** — the single hero surface:

```
 ┌────────────────────────────────────────────────────┐  radius.xl · e3 (mulberry shadow)
 │ UP NEXT · IN 2H 15M                                │  caption, accentDeep
 │  ◇  Dentist appointment                            │  type marker · bodyStrong, textDisplay
 │     2:30 PM · Jefferson Dental Center              │  subhead, textSecondary
 │     Directions   Snooze                            │  footnoteStrong text actions, accent
 └────────────────────────────────────────────────────┘
   accentSurface fill · 3 pt accentDeep left border
```

One card, always the next timed thing, per `today-and-tasks.md` §2.1. Its actions are the
row's own quick actions as text buttons — no icons, no chrome.

**Timeline rows.** Rows are not cards. A time rail on the left, a marker column with a
hairline connector, content to the right:

```
 2:30 PM   ◇   Dentist appointment                       title: body, textPrimary
           │   Jefferson Dental Center                   subtitle: subhead, textSecondary
 5:30 PM   □   Pick up groceries
           │   Task · 4 items on Groceries
```

- Time rail: `footnote`, `textSecondary`, right-aligned, fixed column.
- Marker column: the task checkbox or the 16 pt type marker; a 1 px `border` connector
  line runs vertically between markers — it is what makes the day read as a timeline.
- The **NOW divider** sits between EARLIER TODAY and what remains: `NOW` in `caption`
  `accent`, a 1 px `accent` hairline across, the current time right-aligned in
  `footnoteStrong` `accent`. It is rendered by the same one-minute ticker that maintains
  UP NEXT (`today-and-tasks.md` §2) and is purely presentational.
- EARLIER TODAY rows are `dimmed`; completed rows additionally `struck` with the olive
  check in the marker column. The section header carries `2 done ⌃` as its collapse
  affordance.
- A completion first renders checked and struck where the row was. After the `fast` hold it
  fades over `base`, then the ordinary projection places it in EARLIER TODAY. Do not animate
  the row travelling through the intervening screen; Reduce Motion removes the hold and
  insert/remove transition.
- Overdue rows: a `warning` Chip in the time rail showing the original date.
- Vertical: `space[5]` top and bottom per row → 56 pt minimum; separator is the connector
  line, not a horizontal rule.

### 7.2 Lists — collection cards

The Lists index is a grid of cards (2-up from `medium`, 1-up at `compact`), each list one
card:

```
 ┌──────────────────────────┐  radius.lg · e2 · surfaceRaised
 │  [icon squircle 44]      │  IconTile, template-family tint
 │  Groceries               │  heading, textPrimary
 │  7 remaining             │  subhead, textSecondary
 │  ────────                │  ProgressBar (neutral) — only when the list is checkable
 │  Updated today           │  footnote, textDisabled
 └──────────────────────────┘
```

The count line is the list's own vocabulary (`7 remaining`, `6 shows`, `9 meals`,
`4 of 12 packed`, `12 places`, `4 ideas`) — supplied by the template's copy, never
computed wording. `+ New list` is a `footnoteStrong` accent text action in the screen
header, not a FAB. Tapping a card opens the list (U1); nothing on the card mutates.

### 7.3 Plans — event cards

> **Decision — reversed (2026-08-08).** The previous rule ("all three Plans stages render
> rows") is withdrawn in favour of the founder's design reference: **the Plans tab renders
> event cards**, one per plan, in a single column. The 2026-08-07 rows decision optimised
> for scan density and for reusing the Today `AgendaRow`; the mock optimises for the three
> tabs feeling deliberately different — a timeline, a column of events, a shelf of
> collections — and the founder chose that. Behaviour is unchanged: the three stages
> (Needs a date / Upcoming / Past), their ordering, contents, and every row-level fact
> (`plans-and-lists.md` §1.3) simply render on cards now. The identical `AgendaItem` data
> feeds both surfaces. (The mock's "Invitations" tab is its rendering of pending-RSVP
> plans; the product keeps its three stages and shows pending invitations with badges
> within them, per `sharing-and-people.md` §3.1.)

> **P2-32 presentation amendment (2026-08-11).** In Upcoming, each interior run of dates
> with no entries is one uncarded, quiet line: `Aug 20 · nothing planned` for one day or
> `Aug 20 – 24 · nothing planned` for a longer run. Its text is `footnote` / `textSecondary`;
> because the line opens the schedule date picker, its full-width hit area remains at least
> 44 pt and exposes button semantics even though its visual treatment is subdued. Month
> headers use the existing `SectionHeader` treatment and stick to the scroll edge until the
> next month replaces them. The precise interior-only rendering and no-write tap behavior
> are canonical in `plans-and-lists.md` §1.3. The week-strip and date-scrubber concepts are
> still deferred as open-decisions item #52.

```
 ┌───────────────────────────────────────────────────────┐  radius.lg · e2
 │ [squircle]  Philadelphia Food Festival                │  IconTile · heading, textDisplay
 │             Sat, Aug 8 · 12:00 PM                     │  subhead, textSecondary
 │             Penn's Landing                            │  subhead, textSecondary
 │             (UJ)(AL)(SR)(MK)          [From screenshot]│  AvatarStack (initials) · provenance Chip
 │  Time changed by Sarah · now 7:30 PM                  │  footnote, warning — at most ONE feed line
 └───────────────────────────────────────────────────────┘
```

- The stage switcher is the `SegmentedControl` (`Needs a date · Upcoming · Past`), with
  counts where a stage carries a badge-worthy number; below it, the `All · Personal ·
  Shared` filter Chips.
- The whole card is one tap target → plan detail (U1). The RSVP pill, when present, is a
  separate target.
- At most one system-feed line renders at a card's foot (the most recent unseen entry, in
  `warning` when it is a change, `textSecondary` otherwise); everything else lives in the
  detail's Updates section. A card never stacks notifications.
- Undated (Needs a date) cards render `No date yet — 2 suggestions` in the date slot,
  `footnote`, `textSecondary`. Past cards render their outcome verb.
- The plan card also remains the header of the plan detail screen and the public invite
  page, as before — one plan, given room.

### 7.4 People

A quiet modal-weight screen: serif `display` title, one-line `subhead` purpose statement,
a search `Field`, then rows:

```
 (AL)   Alex Rivera                        Owes you $42.50   ← success, footnoteStrong
        3 upcoming                                            ← subhead, textSecondary
 (SR)   Sarah Mendes                       You owe $18.00    ← warning, footnoteStrong
 (MK)   Mika Okada                         Settled up        ← footnote, textSecondary
```

Balance direction is always words plus tone — olive toward you, ochre from you, quiet
when even (`expenses.md` §5). The initials discs are the `Avatar` tinted fallback.

### 7.5 Activity detail

One header grammar for every activity type, from a one-off task to a shared event. Added
2026-08-12 from the founder's `Activity Detail Restructure` design document; built by P2-41,
and the reference for every later task that adds a capability to this screen.

```
 ‹                                          ⋯     ← back, overflow
 Chicken tacos                                     ← display, serif
 Meal · Alice + 2                                  ← subhead, textSecondary
 Wed, Aug 12 · 7:30 PM  Tap to edit                ← bodyStrong, tap target → reschedule
 Repeats daily · Reminder 1 hour before            ← footnote, textSecondary
 ┌───────────────────────────────────────────┐
 │                 Had it                    │     ← primary, type-derived verb
 └───────────────────────────────────────────┘
 ─────────────────────────────────────────────
 People                             + Add          ← collapsed: label / value / action
 Alice, Ben, Mia
 ─────────────────────────────────────────────
 PREPARATION                        0 of 2         ← expanded: caption header + content
 ☐ Pick up tortillas
 ☐ Defrost chicken
 + Add task
```

**Three rules hold the whole screen.**

1. **The top says what it is, when it is, and what to do next** — in that order, in one
   grammar, for every type. Title, then type-and-audience, then the schedule as a tap target,
   then the primary action. Nothing else competes for the top of the screen.
2. **A capability is one compact disclosure row until opened.** The collapsed row presents its
   label, current summary and a trailing chevron. Tapping the whole row expands it inline to
   show either the current content or its real add controls, and the row exposes its expanded
   state to assistive technology. Empty functional capabilities stay discoverable.
3. **A named future Plan capability may be discoverable without pretending to work.** People,
   Preparation, Related lists and Attachments — plus Ingredients on a Meal — render as
   non-interactive rows ending in `Coming later` until their owning phase builds them. They
   have no chevron, disabled action, expansion or tap behaviour. All other unbuilt
   capabilities remain absent. A task still renders no Plan-only future rows.

**The completion action.** One component, one position, one accessibility pattern for both
object kinds — there is no Task treatment and no Plan treatment. Its label is derived from the
activity's type (`Done`, `Had it`, `Watched`, `Attended`), which is `overview.md` §4.1's "type
guides, never restricts" applied to a verb, and it must match the verb the row's trailing slot
and the passed-plan sheet render for the same activity. The button is **absent** when the
caller lacks the completion capability; it is never shown disabled. On an occurrence of a
series, `Snooze` and `Skip today` follow as a secondary pair.

**The schedule line is a tap target and never an inline field** (U4). This holds wherever a
date is rendered in the product; the detail screen is not an exception to it. It uses
`EEE, MMM d · h:mm a` in the current year (adding the year otherwise), carries the visible
hint `Tap to edit`, and is immediately followed by the combined recurrence/reminder summary.
The bottom time-actions block contains `Edit recurrence` when recurrence is available.
Delete remains only in the `⋯` menu.

**Capability order**, when each is built: People, Preparation, Related lists, Expenses, Notes,
Attachments. A task shows only Notes and Related plan and renders no placeholder for anything
it lacks — a Task is not a Plan with things hidden (`today-and-tasks.md` §5.6).

---

## 8. Responsive

The breakpoints are the three in `tech-stack.md` §3.5 and are not extended. Device classes
map onto them:

| Device class | Width | Breakpoint | Layout |
| --- | --- | --- | --- |
| Phone | 320–429 | `compact` | Single column, 16 pt gutters, bottom tab bar, modals as full-screen sheets. List cards 1-up. Verified at 320 with no horizontal scroll and no clipping. |
| Large phone | 430–767 | `compact` | Identical structure. The extra width goes to the title column, not to new elements. Avatar stack may show 4. |
| Tablet | 768–1199 | `medium` | Single column capped at 720 pt and centred; 24 pt gutters; the tab bar becomes a left rail. List cards 2-up. Sheets present as centred cards at 480 pt wide. |
| Web, wide | ≥ 1200 | `expanded` | **Two panes.** |

**The left rail** (from `medium` up) is the mock's: the `Ordinary Days` wordmark in serif
`title` at top, then `Today / Plans / Lists` — and `People` after a gap, because People is
a layer, not a tab (`sharing-and-people.md` §6) — each a `body` label, the active one
carried on a `surfaceSunken` pill (`radius.md`). The signed-in name sits at the rail's
foot in `footnote`, `textDisabled`. At `compact` the same three tabs render as the bottom
tab bar and People stays under Profile.

**What the web layout does differently at `expanded` (≥ 1200 px):**

| Aspect | Behaviour |
| --- | --- |
| Structure | Left rail + content column ~620 pt (the mock's measure) with the detail pane beyond it where selected. Selecting a row or card fills the right pane instead of pushing a screen. |
| Navigation | The rail replaces the tab bar. The URL still changes on selection — the detail pane has a real, linkable URL. |
| Modals | Centred dialogs at 480 pt, not bottom sheets. No drag-to-dismiss. |
| Row actions | Revealed on hover at the row's right edge (`interaction-contract.md` §7.1), never hover-only — everything is keyboard-reachable. |
| Empty right pane | An `EmptyState` reading `Select something to see it here.` |
| Below 1200 | Falls back to `medium`: single column, detail pushes as a route. Nothing is lost, only rearranged. |

Layout is flexbox with `maxWidth` constraints. No absolute pixel positioning and no
`Dimensions.get()` at module scope — it is wrong after rotation and wrong on a browser
resize. Breakpoints are read through `useBreakpoint()`, backed by `useWindowDimensions()`.

The public invite page (`/invite/:token`) is single-column at every width, capped at 560 pt
and centred. It is read by strangers on phones, not used as an app.

---

## 9. Accessibility, encoded in the tokens

Each requirement from `interaction-contract.md` §6 has a token or a helper so it is the
default rather than a thing to remember.

| Requirement | Token / mechanism |
| --- | --- |
| Minimum hit target 44 × 44 | `layout.hitTarget = 44`. `Pressable`, `IconButton` and `Checkbox` apply `minWidth`/`minHeight` from it unconditionally, plus `hitSlop` where the visual is smaller. |
| ≥ 8 pt between adjacent targets | `space[3]` is the minimum gap token; `Row` applies it between its leading control, body, and trailing slot. |
| Body text ≥ 4.5:1, large text ≥ 3:1 | The colour table in §5.1, asserted by a contrast test over every token pair in both schemes. |
| Control boundaries and focus rings ≥ 3:1 | `borderStrong` and `focusRing`. |
| Focus ring always visible, ≥ 2 px | `layout.focusRingWidth = 2`, applied via `:focus-visible` in the `Pressable` wrapper. Never overridable by a prop. |
| Dynamic type | Every size in §3 is a scalable point value. `allowFontScaling` is never `false`. Above `xxxLarge`, `Row` switches to a vertical layout: time above title, avatars below; the Today time rail collapses into the row. |
| Reduced motion | `motion` durations are read through `useMotion()`, which returns `instant` for every duration when the system setting is on. A component cannot animate around it. |
| Minimum row height | `layout.rowMinHeight = 56`, content-sized above it. Fixed-height rows do not exist. |
| Text truncation | `Text` defaults to `numberOfLines={2}` in the `body` variant used by rows. |

---

## 10. The token rule

> **No screen, component, or style introduces a colour, spacing value, radius, font size,
> shadow, or duration that is not in this document.**

Concretely:

```tsx
// Rejected
<View style={{ padding: 14, backgroundColor: '#fff', borderRadius: 12 }}>
  <Text style={{ fontSize: 16, color: '#888' }}>Chicken tacos</Text>
</View>

// Accepted
<Card elevation="e2" radius="lg" padding={space[6]}>
  <Text variant="subhead" color="textSecondary">Chicken tacos</Text>
</Card>
```

Enforcement:

| Mechanism | Catches |
| --- | --- |
| The theme is the only export path for values; ramps are module-private in `theme/colors.ts` | A component cannot reach a raw hex |
| Biome `noRestrictedSyntax` on hex literals and on numeric `padding`/`margin`/`fontSize`/`borderRadius` in `.tsx` outside `packages/ui/src/theme/` | Inline magic numbers |
| Contrast test over every semantic pair in both schemes | An added colour that fails AA |
| Review checklist item 9 (`git-workflow.md` §3.3) | Everything else |

If a design genuinely needs a value the scale does not have, the value is added to the scale
here, in the same PR, with a one-line reason — it is not written inline "just this once".
That is how a token system dies.
