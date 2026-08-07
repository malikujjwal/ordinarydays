# Design system

**Status:** canonical for tokens, colour, primitives, and layout. Gestures, states, undo and
accessibility behaviour are owned by
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md); this
document says what things look like and what they are built from. Where the two touch —
hit targets, contrast, motion — this document restates the requirement as a token so it
cannot be got wrong by accident.

Everything here lives in `packages/ui/src/theme/` and is consumed through
`useTheme()` / `useStyles()` (`coding-standards.md` §8.7).

---

## 1. What this should feel like

Ordinary Days is where someone puts dinner on Thursday and the show a friend recommended. It
is not a work tool and must not look like one.

Four rules that the tokens below encode:

| Rule | Consequence |
| --- | --- |
| **Quiet by default** | Ink and paper. Colour appears on one accent per row and nowhere else. No coloured backgrounds behind ordinary rows, no status bars of chips, no progress rings. |
| **Content is the interface** | The title of a row is the largest, darkest thing on it. Chrome — times, icons, avatars, type markers — is smaller and lighter, but never below 4.5:1. |
| **Warm, not corporate** | The neutral ramp is warm-tinted (a trace of yellow), not blue-grey. The accent is clay, not SaaS blue. |
| **Nothing celebrates** | No confetti, no streaks, no badges, no "Great job!". Completing something makes it quieter, not louder (`interaction-contract.md` §5.2). |

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
  6: 20,   // between a section header and its first row
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
| Gap between adjacent interactive elements | `space[3]` (8) minimum, never less |
| Between sections | `space[7]` (24) |
| Sheet content padding | `space[5]` horizontal, `space[6]` vertical |
| Between a label and its field | `space[2]` (4) |

---

## 3. Type

Sizes are in points and scale with the platform's dynamic type; `allowFontScaling` is never
`false` (`interaction-contract.md` §6.3). Line heights are the values at the default size.

Family: the platform system font — SF on iOS, the system stack on web
(`-apple-system, "Segoe UI", Roboto, sans-serif`). No custom font is bundled. A downloaded
font costs a network round trip on first web load, blocks text paint, and gains nothing an
everyday planner needs.

```ts
export const type = {
  display:    { size: 28, lineHeight: 34, weight: '700', letterSpacing: -0.4 },
  title:      { size: 22, lineHeight: 28, weight: '600', letterSpacing: -0.3 },
  heading:    { size: 17, lineHeight: 22, weight: '600', letterSpacing: -0.1 },
  body:       { size: 17, lineHeight: 22, weight: '400', letterSpacing: -0.1 },
  bodyStrong: { size: 17, lineHeight: 22, weight: '600', letterSpacing: -0.1 },
  subhead:    { size: 15, lineHeight: 20, weight: '400', letterSpacing: 0 },
  footnote:   { size: 13, lineHeight: 18, weight: '400', letterSpacing: 0 },
  footnoteStrong: { size: 13, lineHeight: 18, weight: '600', letterSpacing: 0 },
  caption:    { size: 11, lineHeight: 14, weight: '600', letterSpacing: 0.6 },
} as const;
```

| Role | Token | Used for |
| --- | --- | --- |
| Screen title | `display` | `TODAY`, `Plans`, `Lists`, a plan's name on its detail screen |
| Sheet and dialog title | `title` | Reschedule sheet, confirmation dialogs, UP NEXT card title |
| Card and group title | `heading` | Plan card title, list name on the Lists index, `Field` group labels |
| Row title, primary content | `body` | Every row's title, note bodies, update entries |
| Emphasised row title | `bodyStrong` | The UP NEXT row, an unread notification |
| Row subtitle, secondary content | `subhead` | Type-derived subtitles, participant summaries, empty-state guidance |
| Metadata | `footnote` | Time column, date chips, relative times, balance lines, `+n more` |
| Emphasised metadata | `footnoteStrong` | The time on the UP NEXT card, a balance figure |
| Section header | `caption`, uppercase | `UP NEXT`, `SCHEDULE`, `ANYTIME`, `EARLIER TODAY` |

Rules: titles wrap to two lines before truncating and never truncate at one line at the
default size. There are exactly nine text styles; a tenth is a decision, not a preference.

---

## 4. Radius, elevation, motion

### 4.1 Radius

```ts
export const radius = {
  none: 0,
  sm: 6,     // chips, checkbox, small controls
  md: 10,    // buttons, fields, list rows when they become cards
  lg: 14,    // cards, plan cards, the UP NEXT card
  xl: 20,    // sheets (top corners), dialogs on web
  pill: 999, // avatars, RSVP pills, filter chips
} as const;
```

Rows on Today are not cards and have no radius. Only the UP NEXT card, plan cards, and
sheets are rounded — rounding everything produces the "corporate dashboard" look this
product avoids.

### 4.2 Elevation

Five levels. On iOS these are shadows; on web they compile to `boxShadow` through React
Native Web.

| Token | Use | Light shadow |
| --- | --- | --- |
| `e0` | Ordinary rows, screen background | none |
| `e1` | UP NEXT card, hovered row on web | `0 1px 2px rgba(28,25,20,0.06)` |
| `e2` | Plan card, expense card | `0 2px 6px rgba(28,25,20,0.08)` |
| `e3` | Sheets, menus, popovers | `0 8px 24px rgba(28,25,20,0.14)` |
| `e4` | Toast | `0 6px 16px rgba(28,25,20,0.18)` |

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

| Token | Light | Dark | Contrast (light / dark) | Use |
| --- | --- | --- | --- | --- |
| `surface` | `#FAFAF7` | `#121213` | — | Screen background |
| `surfaceRaised` | `#FFFFFF` | `#1C1C1E` | — | Rows, cards, sheets |
| `surfaceRaised2` | `#FFFFFF` | `#242427` | — | A card on a card; dark-mode `e2` |
| `surfaceOverlay` | `#FFFFFF` | `#2A2A2E` | — | Menus, toasts, dark-mode `e3`/`e4` |
| `surfaceSunken` | `#F2F1EC` | `#0C0C0D` | — | Grouped-list background, skeletons |
| `scrim` | `rgba(28,25,20,0.40)` | `rgba(0,0,0,0.60)` | — | Behind a modal sheet |
| `textPrimary` | `#16161A` | `#F4F3F0` | 17.4:1 / 15.9:1 | Row titles, body copy |
| `textSecondary` | `#5F5F68` | `#A6A6AE` | 6.3:1 / 7.0:1 | Subtitles, metadata, times |
| `textDisabled` | `#8A8A93` | `#6E6E77` | 3.6:1 / 3.3:1 | Disabled labels only — never carries meaning |
| `textInverse` | `#FFFFFF` | `#16161A` | — | On a filled accent or danger surface |
| `border` | `#E4E3DE` | `#2E2E33` | — | Separators, hairlines. Decorative only. |
| `borderStrong` | `#6E6E76` | `#8A8A94` | 4.6:1 / 4.9:1 | Control outlines, focus rings, checkbox border |
| `accent` | `#A24A1F` | `#E0975F` | 5.9:1 / 7.1:1 | Primary action, links, selected state, the FAB |
| `accentSurface` | `#F6EBE3` | `#33241A` | — | Selected-row tint, accent chip background |
| `success` | `#1F6B3A` | `#58C98A` | 6.5:1 / 9.0:1 | Completed outcome, RSVP going |
| `warning` | `#8A5A00` | `#E0B25A` | 5.9:1 / 9.5:1 | Overdue chip, pending sync, RSVP maybe |
| `danger` | `#B3261E` | `#F08579` | 6.5:1 / 7.4:1 | Destructive actions, error states |
| `focusRing` | `#A24A1F` | `#E0975F` | ≥ 3:1 against both surfaces | Keyboard focus, 2 px, never removed |

**WCAG compliance, stated:** every `text*` token except `textDisabled` meets **AA at 4.5:1**
against `surface` and `surfaceRaised` in both schemes; `borderStrong`, `focusRing`, and every
control boundary meet **3:1**. `textDisabled` is exempt because disabled controls are exempt
from AA, and because disabled state is never the sole carrier of meaning
(`interaction-contract.md` §6.4). Contrast figures above are computed against
`surfaceRaised`, which is the background a row's text actually sits on. The
`packages/ui` test suite asserts every pair programmatically, so a token change that breaks
AA fails CI rather than shipping.

**Increase Contrast.** When the system setting is on, `border` is replaced by `borderStrong`,
`textSecondary` moves to `textPrimary`, and de-emphasis is carried by size and weight alone.

**Colour is never the only carrier of meaning.** Completion also has a checkmark and a struck
title; a pending RSVP also says `Awaiting reply`; overdue also shows its original date;
balance direction is always words.

### 5.2 Per-activity-type accent

One accent per type, used for the row's type marker, the detail header's tint, and the type
chip on the Add screen. It is never used as a row background.

| `type` | Icon | Light | Dark | Contrast (light/dark) |
| --- | --- | --- | --- | --- |
| `task` | `check-square` (a checkbox — tasks are the only type with one) | `#4C5C78` | `#93AEDB` | 7.0:1 / 9.6:1 |
| `meal` | `bowl` | `#8C5A16` | `#E0B45E` | 5.8:1 / 9.6:1 |
| `watch` | `play-rect` | `#6B4A9E` | `#B79AE8` | 6.8:1 / 8.5:1 |
| `event` | `ticket` | `#1F6B6B` | `#62C2C2` | 6.2:1 / 9.3:1 |
| `outing` | `map-pin` | `#A03E5C` | `#E88BA5` | 6.3:1 / 8.2:1 |
| `custom` | `diamond` | `#5C5C64` | `#A9A9B2` | 6.6:1 / 7.0:1 |

Non-task rows render a small non-interactive `◇`-scale marker in the type's accent, sized
`16 × 16` and `accessibilityElementsHidden` — its meaning goes into the row's label instead
(`interaction-contract.md` §6.2).

### 5.3 Row subtitle format per type

The `subtitle` field on `AgendaItem` (`api-contract.md` §2.2). Built server-side, one
format per type, `·` as the separator. Omitted entirely when there is nothing to say.

| `type` | Format | Example |
| --- | --- | --- |
| `task` | Parent plan name if it is a prep task, otherwise none | `New York Trip` |
| `meal` | `Meal · <mealSlot>` when a slot is set, otherwise `Meal` | `Meal · Dinner` |
| `watch` | `S<season> E<episode>` when both are set; else `<mediaKind>`; else `<service>` | `S2 E4` |
| `event` | `<organiser>` if set, else `<locationLabel>` | `Dr Patel` |
| `outing` | `<placeName>` if set, else `<locationLabel>` | `Zahav` |
| `custom` | None | — |

Any type with participants appends the avatar stack in the trailing slot, not the subtitle.

### 5.4 Icons

> **Decision: hand-authored SVG components in `packages/ui/src/icons/`, rendered with
> `react-native-svg`.** An icon font (`@expo/vector-icons`) ships 60–200 KB of glyphs to load
> a dozen shapes, does not scale correctly with dynamic type on web, and cannot take a
> per-instance colour without a wrapper. The product needs roughly 30 icons. Each is a
> ~15-line component taking `size` and `color`, tree-shaken per import.
> `react-native-svg` is an Expo-managed package installed with `npx expo install`, so it is
> SDK-pinned like the other RN packages (`tech-stack.md` §6 version policy). It is recorded
> in `tech-stack.md` §2.2.

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
| `Text` | `variant` (the nine type roles), `color` (`textPrimary` \| `textSecondary` \| `textDisabled` \| `accent` \| `danger` \| `success` \| `warning` \| `inverse`), `numberOfLines`, `align` | — |
| `Button` | `variant` (`primary` \| `secondary` \| `ghost` \| `danger`), `size` (`md` 44 \| `lg` 52), `label`, `icon?`, `onPress`, `loading`, `disabled`, `fullWidth` | default, pressed, loading (spinner after 400 ms), disabled, focus-visible |
| `IconButton` | `icon`, `label` (required — it is the accessible name), `onPress`, `variant` (`ghost` \| `filled`), `disabled` | default, pressed, disabled, focus-visible. Always 44 × 44. |
| `Row` | `onPress?`, `leading?`, `title`, `subtitle?`, `trailing?`, `accent?`, `dimmed`, `struck`, `swipeActions?`, `accessibilityActions` | default, pressed, hovered (web), focused, dimmed (completed), disabled |
| `Card` | `elevation` (`e1` \| `e2`), `padding` (a `space` token), `onPress?` | default, pressed, focused |
| `Sheet` | `open`, `onClose`, `title?`, `detents` (`['medium','large']`), `dismissible` | closed, presenting, open, dismissing. Focus trapped; returns focus on close. |
| `Field` | `label`, `value`, `onChangeText`, `placeholder?`, `error?`, `hint?`, `required`, `multiline`, `keyboardType`, `maxLength` | default, focused, filled, error, disabled |
| `DatePicker` | `value` (`WallDate \| null`), `onChange`, `min?`, `max?`, `quickOptions` (`Today`, `Tomorrow`, `This weekend`) | default, open, cleared. Native wheel on iOS, `<input type="date">` on web. |
| `TimePicker` | `value` (`WallTime \| null`), `onChange`, `minuteInterval` (5) , `allowClear` | default, open, cleared (meaning "anytime that day") |
| `Checkbox` | `checked`, `onChange`, `label` (accessible name), `disabled` | unchecked, checked (spring), disabled, focus-visible. 44 × 44 target, 24 × 24 visual. |
| `Avatar` | `displayName`, `imageUrl?`, `size` (`sm` 24 \| `md` 32 \| `lg` 48) | image, initials fallback, loading |
| `AvatarStack` | `people`, `max` (3), `size` | Renders up to `max` overlapped by 8 pt plus a `+n` disc. Non-interactive on rows. |
| `Chip` | `label`, `icon?`, `tone` (`neutral` \| `accent` \| `warning` \| `danger` \| `success`), `onPress?`, `selected` | default, selected, pressed, disabled |
| `SectionHeader` | `title`, `count?`, `action?` | default only. `caption` type, uppercase, `accessibilityRole="header"`. |
| `EmptyState` | `heading`, `body?`, `action?` | One heading line, at most one body line, at most one action. No illustration. |
| `Toast` | `message`, `action?` (`{ label, onPress }`), `tone` (`neutral` \| `error`), `duration` (6000 \| 10000) | entering, visible, exiting. One at a time; a new one commits the previous. `accessibilityLiveRegion="polite"`. |
| `Skeleton` | `shape` (`row` \| `card` \| `text`), `count` | Shimmer off under Reduce Motion. Minimum display 200 ms. |

Two rules for all of them: every interactive primitive has a minimum 44 × 44 hit target
regardless of its visual size, and none of them reads the API or the navigation stack.

---

## 7. Anatomies

### 7.1 Today row

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │                                                                       │
 │  6:00 PM   □    Gym                                        ↻   ● ● +2 │
 │  └──┬───┘  └┬┘  └─────────────┬──────────────┘            └┬┘  └──┬──┘│
 │   time    check      title (body) + subtitle (subhead)   repeat  avatars
 │  56 pt    44×44         flex: 1, wraps to 2 lines         16px   md=32
 │  footnote  hit          space[4] from the control                     │
 │                                                                       │
 └───────────────────────────────────────────────────────────────────────┘
   ├─ space[5] ─┤                                          ├─ space[5] ─┤

  Vertical: space[5] top + content + space[5] bottom → 56 pt minimum.
  Separator: 1 px `border`, inset to the title's left edge, none after the last row.
  Non-task rows replace □ with a 16 pt ◇ in the type accent (non-interactive).
  Completed rows: `dimmed` + `struck`, outcome verb replaces the trailing slot.
  Overdue rows: a `warning` Chip in the time column showing the original date.
```

### 7.2 List row

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │  ☑   Chicken                                                       ⠿ │
 │      from Sunday dinner                                               │
 │  └┬┘ └────────────────┬────────────────┘                            └┬┘
 │ check    title (body, struck when checked)                      drag handle
 │ 44×44    source label (footnote, textSecondary)              hover/long-press
 └───────────────────────────────────────────────────────────────────────┘

 ┌───────────────────────────────────────────────────────────────────────┐
 │  ◇   Severance                                                        │
 │      Planned Saturday · 7:00 PM                          ← its own    │
 │      └────────────────┬─────────────────┘                  hit target │
 │                  state line: tapping it opens the linked Activity     │
 └───────────────────────────────────────────────────────────────────────┘

  Non-checkable lists (meals, restaurants, places, watchlist) omit the checkbox.
  The state line is a separate accessibility element (interaction-contract.md §3.2).
```

### 7.3 Plan card

```
 ┌───────────────────────────────────────────────────────────────┐  radius.lg
 │                                                               │  e2
 │   Sat 9 Aug · 7:00 PM                             ● ● ● +2    │  footnote /
 │                                                               │  AvatarStack
 │   Dinner at Zahav                                             │  heading
 │   Outing · Zahav                                              │  subhead
 │                                                               │
 │   ─────────────────────────────────────────────────────────   │  border
 │   ◈ 237 Saint James Pl                            Going  ▾    │  footnote /
 │                                                               │  RSVP Chip
 └───────────────────────────────────────────────────────────────┘
   ├── space[5] ──┤                                ├── space[5] ──┤

  Padding: space[5] all round. Gap between blocks: space[4].
  The whole card is one tap target → plan detail. The RSVP chip and the address
  line are separate targets (U1: the card body never mutates).
  On Today, plan cards are not used — Today uses rows. Cards appear on Plans.
```

---

## 8. Responsive

The breakpoints are the three in `tech-stack.md` §3.5 and are not extended. Device classes
map onto them:

| Device class | Width | Breakpoint | Layout |
| --- | --- | --- | --- |
| Phone | 320–429 | `compact` | Single column, 16 pt gutters, bottom tab bar, modals as full-screen sheets. Verified at 320 with no horizontal scroll and no clipping. |
| Large phone | 430–767 | `compact` | Identical structure. The extra width goes to the title column, not to new elements. Avatar stack may show 4 instead of 3. |
| Tablet | 768–1199 | `medium` | Single column capped at 720 pt and centred; 24 pt gutters; the tab bar becomes a left rail. Sheets present as centred cards at 480 pt wide. |
| Web, wide | ≥ 1200 | `expanded` | **Two panes.** |

**What the web layout does differently at `expanded` (≥ 1200 px):**

| Aspect | Behaviour |
| --- | --- |
| Structure | Left pane 400 pt fixed (the list: Today, Plans, Lists, People), right pane flexible (the detail). Selecting a row fills the right pane instead of pushing a screen. |
| Navigation | A left rail replaces the tab bar. The URL still changes on selection — the detail pane has a real, linkable URL. |
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
| Dynamic type | Every size in §3 is a scalable point value. `allowFontScaling` is never `false`. Above `xxxLarge`, `Row` switches to a vertical layout: time above title, avatars below. |
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
<Card elevation="e2" padding={space[5]}>
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
