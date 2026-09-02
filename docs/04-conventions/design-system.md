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

## 0. System invariants

**Four rules. Everything below is how they are expressed** — added 2026-08-13 (P2-51), after a
review found the same defect reported four different ways. The rest of this document is
detailed enough to answer most questions and long enough that nobody reads it end to end; what
it lacked was a short statement of which violations are *architectural* rather than matters of
taste. These four are architectural. A change that breaks one of them is wrong even if it looks
better.

**1. Affordance truth.** Every visible affordance describes what will happen.

| Sign | Means, and may not mean anything else |
| --- | --- |
| Chevron | Navigates, or discloses in place |
| Check | Selected, or complete |
| Accent text | An action |
| Muted text | Information |
| Reduced emphasis | Unavailable |
| Nothing | Nothing happens |

No symbol is ever placed for visual balance. An unchecked toggle that renders a chevron is a
bug, not a style preference — it promises navigation that does not exist.

**2. Ownership.** Screens compose primitives and supply content. **A screen decides which
components appear, what they contain and in what order. A screen does not decide** row height,
divider colour, card radius, chevron colour, the type scale, checkbox appearance, sheet padding,
elevation, or button anatomy. Those belong to `packages/ui`. A screen that needs a shape the
system lacks adds it to the system and to the gallery first.

**3. Hierarchy.** Three visual levels — hero, content, controls — and ordinarily **one hero
surface visible at a time**. Content is quieter than the hero; controls and metadata recede.
Elevation, radius and accent are earned. A screen that wraps itself in a raised card has made
the whole page a hero and has none.

**4. Accessibility is a construction constraint, not a final check.** Body text meets 4.5:1,
large text 3:1, control boundaries and focus indicators 3:1. `textDisabled` is the one
deliberate exception and may never be the sole carrier of meaning — nor may colour, anywhere
(completion is a check **and** a strike **and** a dimmed row). Hit targets are ≥ 44 pt, and the
*hit area* grows rather than the glyph. **Rows are content-sized above their family minimum and
are never fixed-height**; at accessibility text sizes a row may **reflow from horizontal to
vertical composition** where necessary, rather than compressing, clipping, or leaning on
aggressive truncation. Growth and reflow solve different problems and both stay legal — the
acceptance criterion is *no clipping, no unusable truncation, no crushed controls, sensible
reflow*, not "the row stops growing". The contrast matrix is CI-enforced in
`packages/ui/src/theme/contrast.test.ts`, so a palette change that breaks it does not ship.

> **A visible grabber is a behavioural promise.** A sheet that cannot be dragged must not render
> one. This is invariant 1 applied to the surface that most often breaks it.

**Two row families, two regular floors.** `layout.rowMinHeight` = **56** for the content `Row`;
`layout.settingRowMinHeight` = **72** for a regular `SettingRow`. There is no reason every family
shares a floor: a settings group is a regular configuration measure, and at 56 its rhythm would
be set by content length — `Repeat` alone beside `Notes`-with-summary. A transient action menu is
the compact density of `SettingRow`: it uses the 56 pt floor, aligned optional icon, disclosure,
selection and danger roles without creating a third row family. All are minima; all grow.

> **On "one value token for a role".** Semantic role first, contrast gate second, exact token
> third — in that order. `SettingRow`'s value is `textSecondary` on `surface` and
> `surfaceRaised`; the same role on light `accentSurface` takes `textPrimary`, because
> `textSecondary` measures 4.45:1 there. A rule stated as a token rather than as a role is a
> rule that will be applied where it fails.

> **The selected tint — 2026-08-16 (P2-43).** A `SettingRow` whose `selected` is `true` carries
> an `accentSurface` fill **and** the trailing check, and its secondary ink steps up to
> `textPrimary` by the rule above. Two carriers, never one: colour is not a meaning-carrier
> anywhere in this system. It lives on the component rather than on the three screens that pick
> one of a set — the reschedule sheet, the reminder menu, the Add form's menus — because that is
> the whole point of having a row family. There is **no radio column**: the check is the mark.
>
> `ScreenShell` gains a **`footer`** slot in the same task, the screen-level counterpart of
> §6.1's `actions`. A screen supplies the control; the shell decides where it sits, how clear of
> the home indicator it is, and that the keyboard lifts it rather than covering it. A named write
> that scrolls away with the form it commits is the failure it exists against.

> **The value takes `textAction` when the row opens — 2026-08-16 (P2-43).** The rule above used
> to end "the value is state, not an action — `textSecondary` in both schemes", on the reasoning
> that `textAction` "resolved plum in light and near-white in dark, so the two themes disagreed
> about which part of the row was the loud one". **The second half is no longer true**: §5.1's
> dark `textAction` is now a readable mulberry, so the token means one thing in both schemes and
> the objection it rested on is gone.
>
> What survives is the distinction, and `opens` is exactly it, per §0's affordance table —
> accent text means an action. A row that **opens** something is offering to change the value
> beside it, so the value is inked as part of that affordance. A row that **commits** — the
> reschedule sheet's date rows, which render no chevron — keeps `textSecondary`, because its
> value is a report and not a thing the row will edit. On a selected row the ground is
> `accentSurface` and the ink steps up to `textPrimary`.

> **Two subtitle roles on `Row` — 2026-08-16 (P2-43, founder report).** §7.1 pins the timeline
> row's subtitle at `subhead`, `textSecondary`, and that stays: an agenda subtitle is the user's
> own data — `Meal · Dinner`, the location, `S2 E4`. A **chooser** row's subtitle is not content;
> it is a line explaining the control, which §0's affordance table calls information. That takes
> `textMuted` (`subtitleTone="explanatory"`). In dark it is a real step down — 6.33:1 against the
> title's 15.92 — which is the report: the subtext read almost as loud as the label. In light the
> two tokens are the same value, because §5.1 collapses muted into secondary rather than ship the
> supplied `#978F84` at 2.7:1.

> **A `RowGroup` sits flush against what precedes it — 2026-08-16 (P2-43, founder report).** A
> form gap and a row group cannot share one container. `SettingRow` already carries `space[5]`
> and centres its label inside `layout.settingRowMinHeight`, so a flow gap above the group lands
> **on top of** that padding: the first row gets far more air above its label than below, while
> every row beneath it is even. The group's own padding is the separation, and a screen laying out
> mixed controls spaces the non-row ones and leaves the group alone.

> **An input's rest border is `borderStrong` — 2026-08-16 (P2-43, founder report).** Both
> primitives drew it in `borderSubtle` — and `Field` drew it in **`transparent`**, leaving the
> `surfaceInput` fill as the whole boundary. That fill is **1.02:1 against `surface`** in light
> and 1.05:1 in dark, so a text input had no perceivable edge in either scheme: WCAG 1.4.11's
> 3:1 control-boundary requirement missed outright, not narrowly. §5.1 already answered it —
> `borderSubtle` "may never be the sole required control indicator" — so this is that rule
> applied rather than a new one. 4.77:1 light, 6.33:1 dark. A `bare` field stays borderless: it
> is inline text on a detail screen, not a boxed control.

> **`Button` gains `flush` — 2026-08-16 (P2-43).** A `ghost` button has no fill, so its
> `space[6]` horizontal padding is invisible ink that indents the label from whatever column it
> sits in; on the Add screen `Back` and `Change` were 20 pt out of line with the `Title` beneath
> them. `flush` pulls the box outward by exactly that padding, so the **label** aligns and the
> padding becomes hit target reaching into the gutter. Dropping the padding instead would have
> taken a short label like `Back` under the 44 pt minimum, which is the trade this avoids.

**Component families, not component sprawl.** One implementation per family; the roles are
gallery states, not separate primitives. `Row` and `SettingRow` are the two row families —
"navigation row", "choice row", "check row", "disclosure row", "content row" are *roles* of
those. `TaskRow` is a domain composition of the row family, not a new visual primitive.
`Button` is one component with `primary / secondary / ghost / danger / dangerGhost`, and a "text action" is
its `ghost` role rather than a separate component. `IconButton` stays separate because its
geometry and accessibility contract genuinely differ. Six implementations independently
remembering radius, pressed state, focus, disabled state and accessibility is the failure this
rule exists to prevent, and it is the failure P2-51 was created to undo.

---

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

> **The body sizes are 16/21, down from 17/22 — founder, 2026-08-17 (P2-44).** The report was
> that "the screen feels visually large", with the agenda row given explicitly as 16 pt semibold
> over 13–14 pt. Changed here on the scale rather than at the row: §10 admits no font size that is
> not in this table, and a one-off row token would have left every other body string at the old
> measure when the complaint was about the screen. 17 was the iOS body convention; 16 is a
> deliberate step away from it. **No contrast threshold moves** — 16 is still normal text owing
> 4.5:1, well under `interaction-contract.md` §6.4's 19 pt bold / 24 pt large-text boundary.

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
  heading:    { family: 'sans',  size: 16, lineHeight: 21, weight: '600', letterSpacing: -0.1 },
  body:       { family: 'sans',  size: 16, lineHeight: 21, weight: '400', letterSpacing: -0.1 },
  bodyStrong: { family: 'sans',  size: 16, lineHeight: 21, weight: '600', letterSpacing: -0.1 },
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

**The accent glow belongs to the Add button, and to nothing else** (amended 2026-08-13,
P2-51). `accentGlow` — `0 8px 18px -8px rgba(139,99,116,0.85)` — used to sit under every filled
`primary` Button. No frame in either palette puts a glow under a filled control, and on a 52 pt
primary it rendered as a smudge, so `Button` no longer applies it. The floating Add button keeps
it: it is the one control with nothing behind it to sit on.

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

Recognition and persistence delays are not motion and remain unchanged under Reduce Motion:

| Delay | Token | Value | Reason |
| --- | --- | --- | --- |
| List-item field autosave | `interactionTiming.fieldAutosave` | 350 ms | Persist shortly after typing pauses without requiring blur or writing on every keystroke. |
| List-card long press | `interactionTiming.longPress` | 500 ms | Match the platform hold gesture through the shared `Card` Pressable before opening its actions sheet. |
| Duplicate navigation guard | `interactionTiming.duplicateActivationWindow` | 500 ms | Coalesce one physical double activation while allowing the next deliberate tap. |

These delays do not animate a visual property. Reducing them would change input recognition,
write frequency or activation semantics rather than reduce motion.

> **Sheet present / dismiss is `Sheet`'s own** — recorded 2026-08-27 (P3-26), built by
> P3-51. The animation was never this component's: it was React Native Web's `Modal` fading
> its own container, at RNW's 250 ms rather than `slow`, and outside `useMotion()`'s reach.
> That `Modal` also withholds `role="dialog"` and its focus trap until the fade ends, and the
> end event never arrives — measured in Chromium, `role: null` two seconds after mount, which
> axe reports as a **critical** `aria-allowed-attr` on every sheet. `Sheet` therefore passes
> **no animation type on either platform** and animates its own surface and scrim from
> `useMotion()`: `slow`/`decelerate` in, `slow`/`accelerate` out, `instant` under Reduce
> Motion. A `compact` bottom sheet travels; the centred dialog fades and settles from a slight
> scale. Dismissal waits for the exit before `onClose` reaches the caller, a drag-dismissed
> sheet fades from wherever the finger left it rather than snapping back, and a `dirty` sheet
> does not animate out until its discard prompt resolves. The dialog role and focus trap are
> pinned by `Sheet.test.tsx`; the lifecycle by the same file and `sheetMotion.test.ts`.

> **A frame in a product doc does not place a control** — settled 2026-08-27 (founder), on
> the divergence raised in P3-26's PR and recorded in
> [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §5.4. Those drawings
> are canonical for which controls exist and what they say; where a modal's dismissal and
> commit controls sit is §6.1's, so they go in the sheet's fixed `actions` slot and dismissal
> stays the one `✕` every exit path converges on.

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
| `textAction` | `#795565` | `#B58298` | 5.4:1 / 5.7:1 | Readable text actions. Light is `accentDeep`; **dark is a lifted mulberry, amended 2026-08-16 (P2-43)** — it was `textPrimary` `#F4F0E8`, which made every text action in dark mode indistinguishable from a heading. `accentDeep` `#AD748C` is what the frames draw but is 4.06:1 on `surfaceOverlay`, so the value is that hue lifted 10% toward white: the smallest change clearing 4.5:1 on **every** surface a text action lands on — 5.70 `surface`, 5.18 `surfaceRaised`, 4.75 `surfaceOverlay`, 5.42 `surfaceInput`, 4.91 `accentSurface`, all asserted |
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
**Plan**. The global Add sheet uses neutral **Task / Plan / Add list** destinations; it
does not present type inference as an accent choice. Type colour is never used as a row
background.

| `type` | Icon | Light | Dark | Contrast (light/dark) |
| --- | --- | --- | --- | --- |
| `task` | `check-square` (a checkbox — tasks are the only type with one) | `#6E675F` | `#9F988D` | 4.8:1 / ≥ 3:1 |
| `meal` | `bowl` | `#8A6520` | `#E3C07A` | 5.0:1 / ≥ 3:1 |
| `watch` | `play-rect` | `#616F45` | `#A7B690` | 4.7:1 / ≥ 3:1 |
| `event` | `map-pin` | `#8C4A5E` | `#AD748C` | 6.1:1 / ≥ 3:1 |
| `custom` | `diamond` | `#6E675F` | `#9F988D` | 4.8:1 / ≥ 3:1 |

Non-task rows render a small non-interactive marker in the type's accent — outlined, sized
`16 × 16` and `accessibilityElementsHidden` — its meaning goes into the row's label instead
(`interaction-contract.md` §6.2).

> **Corrected 2026-08-25 (founder), P3-49.** This paragraph named abstract shapes — "a
> diamond outline for events, a ring for meals" — which contradicted the table directly above
> it, and `RowLeading.tsx` shipped neither: every non-task type rendered one 8 pt filled grey
> square rotated 45°, ignoring both the glyph and the accent. **The table is correct and is
> what the icon registry implements.** The marker is the type's own glyph — `bowl`,
> `play-rect`, `map-pin`, and `diamond` for `custom`, which is the visible **General** Plan
> kind. The diamond is one mark of four, not the mark for all of them.
>
> Cards were already right: an icon squircle renders the type's glyph, so before this
> correction the same plan showed a map-pin on one surface and a grey diamond on another.
> Keep the marker's stroke visibly lighter than the checkbox border on the adjacent row —
> it has no hit target and must not start reading as a control.
>
> **Marker forms (P3-49, per the Phase 3 screen board).** The registry authors every glyph on
> a 24 viewBox at `strokeWidth: 1.5`, so scaling one to `16 × 16` renders its stroke at 1.0 px
> — thinner than the 1.5 px checkbox border in the same column — and turns interior detail
> (the pin's dot, the bowl's steam) into noise. The four markers are therefore separate
> **marker forms** (`packages/ui/src/icons/markers.tsx`): the same silhouettes at **1.9**
> viewBox units, which renders at ~1.27 px at 16 pt — present, and still lighter than the
> checkbox — with `bowl` and `map-pin` dropping their interior. The full 1.5 forms stay on the
> 24 pt and 44 pt surfaces (cards, the catalogue, the kind chooser). A `task` never draws a
> marker: its icon is the checkbox, and the one case that withholds it (P2-50's unacknowledged
> create) leaves the column reserved and empty rather than decorating it with a check-square.
>
> On cards the same accent tints a `44 × 44` icon
**squircle** (`radius.md`, the type's `*Surface` tint as fill, the accent as glyph).

#### 5.2a Collection-card surfaces

Lists use a separate, presentation-only collection palette. Unlike Activity accents, these
tones fill the whole card: the variation is what makes the Lists index read as a shelf of
distinct collections rather than a grid of identical controls. They never imply state, type,
priority or completion, and they are never used to infer a List's configuration.

| Tone | Light surface | Dark surface | `textPrimary` contrast (light / dark) |
| --- | --- | --- | --- |
| rose | `#F2DFE2` | `#593942` | 11.79:1 / 8.85:1 |
| sand | `#EFE4D3` | `#514534` | 11.99:1 / 8.21:1 |
| blue | `#DCE9EB` | `#374B4F` | 12.13:1 / 8.10:1 |
| olive | `#E4EADF` | `#3B483C` | 12.30:1 / 8.48:1 |

The renderer derives a stable tone from `listId`; it does not add a stored colour field and
does not read `templateKey`. Hash collisions may repeat a tone, but a List never changes colour
because the grid reorders or the app relaunches. The icon squircle uses a translucent neutral
surface on top of the card rather than introducing a second category colour. Text, counts and
progress use the paired readable ink/track treatment for the actual card surface.

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
| `Button` | `variant` (`primary` — accent fill \| `secondary` \| `ghost` — the text-action role \| `danger` — filled destructive commit \| `dangerGhost` — low-emphasis destructive text action), `size` (`md` 44 \| `lg` 52), `radius` (**defaults to `md`**; `pill` is requested explicitly, and only by the controls the radius table reserves it for), `label`, `icon?`, `onPress`, `loading`, `disabled`, `fullWidth`, `flush` (a ghost variant whose label aligns with the text column — §0) | default, pressed, loading (spinner after 400 ms), disabled, focus-visible |
| `IconButton` | `icon`, `label` (required — it is the accessible name), `onPress`, `variant` (`ghost` \| `filled`), `tone` (`neutral` \| `accent`), `disabled` | default, pressed, disabled, focus-visible. Always 44 × 44. |
| `Row` | `onPress?`, `leading?`, `title`, `subtitle?`, `trailing?`, `accent?`, `dimmed`, `struck`, `swipeActions?`, `accessibilityActions` | default, pressed, hovered (web), focused, dimmed (completed), disabled |
| `Card` | `elevation` (`e1` \| `e2` \| `e3`), `radius` (`lg` \| `xl`), `padding` (a `space` token), `surfaceTone?` (`neutral` \| `collectionRose` \| `collectionSand` \| `collectionBlue` \| `collectionOlive`), interactive arm `onPress` plus optional `onLongPress` and `delayLongPress` | default, pressed, focused. Collection tones resolve through §5.2a's paired surfaces; callers never pass raw colours. `onLongPress` is valid only with `onPress`; the shared Pressable is the sole gesture recognizer. A long press never replaces equivalent named accessibility actions owned by the feature wrapper. |
| `IconTile` | `icon`, `tint` (a type or template accent), `size` (44) | The squircle on plan and list cards. Non-interactive; `accessibilityElementsHidden`. |
| `SegmentedControl` | `segments` (`{ label, count? }[]`), `selectedIndex`, `onChange` | `surfaceSunken` pill track (`radius.md`), active segment `surfaceRaised` + `e1`. Counts render as a `footnote` beside the label. |
| `ProgressBar` | `value` (0–1), `tone` (`accent` \| `neutral`) | 4 pt tall, `radius.pill`, track `border`, fill `accent`. No animation beyond `base` width easing; no percentage text of its own. |
| `Sheet` | `open`, `onClose`, `title?`, `detent` (`fit` \| `medium` \| `large`), `actions?`, `dismissible` | closed, presenting, open, dismissing. `radius.sheet` top corners. Focus trapped; returns focus on close. **Behaviour is fixed by §6.1, not by the screen.** |
| `AlertDialog` | `open`, `label`, `onRequestClose`, `initialFocusTestID?`, `children` | Always centred and scrim-modal. The scrim never dismisses it. The safe action receives initial focus; focus is trapped and returns to the trigger on close. Reduce Motion removes the native fade. Geometry and focus behaviour belong to the primitive, not a feature screen. |
| `Field` | `label`, `value`, `onChangeText`, `placeholder?`, `error?`, `hint?`, `required`, `multiline`, `keyboardType`, `inputAccessoryViewID?`, `maxLength`, `appearance` (`boxed` \| `bare` \| `underline`) | default, focused, filled, error, disabled. `boxed` uses `surfaceInput`, `radius.lg`, **`borderStrong` at rest** and the accessible `focusRing` on focus. `bare` is content-like inline editing. `underline` is the persistent-boundary rapid-entry treatment. A number-pad field in a sheet links an iOS Done accessory because that keyboard has no Return key. |
| `SelectField` | `label`, `value`, `options`, `onChange`, `error?`, `hint?`, `disabled` | collapsed, focused, open, selected, error, disabled. Uses the same `surfaceInput` / `borderStrong` / `focusRing` treatment as `Field`; native opens one accessible option sheet and web uses one styled platform `<select>`. |
| `DatePicker` | `label`, `value` (`WallDate \| null`), `onChange`, **`today`**, `quickOptions`, `min?`, `max?`, `disabled` | default, open, cleared. Native wheel on iOS, `<input type="date">` on web. |
| `TimePicker` | `label`, `value` (`WallTime \| null`), `onChange`, `minuteInterval` (5), `allowClear`, `openAt?`, `presentation?` (`sheet` \| `inline`), `disabled` | default, open, cleared (meaning "anytime that day"). A picker inside an existing native sheet uses `inline`, so it never presents a nested modal. |
| `Checkbox` | `checked`, `onChange`, `label` (accessible name), `disabled` | unchecked (borderStrong ring), checked (olive fill, white check, spring), disabled, focus-visible. 44 × 44 target, 24 × 24 visual. |
| `SettingRow` | `label`, `summary?`, `value?`, `note?`, `selected?`, `switchValue?`, `role` (`button` \| `checkbox` \| `switch`), `opens?`, `expanded?`, `icon?`, `iconTone?` (`neutral` \| `success` \| `danger`), `density` (`standard` \| `compact`), `danger?`, `separated?`, `onPress?`, `disabled?` | The utility-row family: inert/read-only, default, pressed, selected, expanded, checked/unchecked switch, disabled and focus-visible. `standard` has a 72 pt floor; transient action-menu `compact` has the content-row 56 pt floor. `icon` is a recognition aid; an optional semantic `iconTone` places it on the shared 36 pt soft tile without caller-owned colour. `danger` changes ink rather than filling the row, and `separated` adds token spacing before a consequential action. The entire row is one target; switch rows use the shared token-owned track/thumb with checked state and reduced-motion-safe transition, while choice rows use selected state plus a check and navigation/disclosure rows use a truthful chevron. |
| `Avatar` | `displayName`, `imageUrl?`, `size` (`sm` 24 \| `md` 28 \| `lg` 48) | image, **tinted-initials fallback** (two letters, `footnoteStrong`, disc filled with a stable per-person tint drawn from the `*Surface` family), loading |
| `AvatarStack` | `people`, `max` (4), `size` | Renders up to `max` overlapped by 6 pt plus a `+n` disc. Non-interactive on rows. |
| `Chip` | `label`, `accessibilityLabel?`, `icon?`, `tone` (`neutral` \| `accent` \| `warning` \| `danger` \| `success`), `onPress?`, `selected` | default, selected (`accentSurface` fill with a decorative `accentBorder` rim — P2-43), pressed, disabled. Every chip reserves the rim's 1 pt in transparent, so choosing one does not move the row. Default neutral chips may use decorative `borderSubtle`; focus still uses `focusRing`. Also carries provenance labels (`From screenshot`, `From link`) in `neutral`, `surfaceSunken` fill. |
| `SectionHeader` | `title`, `count?`, `action?`, `icon?`, `appearance` (`plain` \| `tinted`) | `plain` is caption type, uppercase and wide-tracked. `tinted` is the compact icon/title/count boundary for grouped content. Both expose the title and count as one heading name. |
| `EmptyState` | `heading`, `body?`, `action?` | One heading line, at most one body line, at most one action. No illustration. A product anatomy may supply one compact, non-interactive `IconTile`; that is a semantic marker, not an illustration. |
| `Toast` | `message`, `requestId?` (small, selectable API correlation id), `action?` (`{ label, onPress }`), `actions?` (a follow-up's own named choices, rendered before `action`, none pre-selected — P3-44), `onDismissPress?` (the visible `✕` a follow-up requires), `tone` (`neutral` \| `error`), `duration` (6000 \| 10000) | entering, visible, exiting. One at a time; a new one commits the previous. `accessibilityLiveRegion="polite"`. Producers shorten a positive remaining server deadline before presenting; the singleton toast store owns the one expiry timer so screen or presenter lifecycle cannot extend it. The shell host suppresses an expired offer and refuses Undo at or beyond its absolute deadline. |
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

### 6.1 The Sheet contract

Added 2026-08-13 (P2-51). The primitive already existed; what it lacked was a behavioural
contract, so two modals could satisfy the same API and behave differently. **These are not
per-screen decisions.**

**Presentation is decided by width, not by the screen.**

| | `compact` | `medium` and above |
| --- | --- | --- |
| Form | Bottom sheet | Centred dialog, 480 pt |
| Grabber | Yes — **and it drags** | No |
| Drag | Between detents; swipe down from the lowest detent dismisses | None |
| Close button | Yes | Yes |
| Escape | — | Dismisses where available |
| Overflow | Body scrolls | Body scrolls within a sensible max height |

A pointer does not make a drag gesture, which is why the centred dialog has neither a grabber
nor a drag. Swipe and the close button **run the same `onClose`** — two exits with subtly
different cleanup is how a dirty-state bug is born.

**The detent is decided by the task, not by taste.** A sheet ends shortly after its content; it
does not extend to the bottom of the device because the room is there.

| Task | Detent |
| --- | --- |
| A short control — Repeat, Snooze, a simple picker | `fit`: the smallest detent that comfortably holds it |
| A choice list — reminder offsets, people, lists | `medium`, scrolling internally, expanding to `large` when content needs it |
| An editor or keyboard-heavy form — notes, complex recurrence | `large` when necessary |
| A long flow that is really a screen | **Not a sheet.** Navigate to a screen rather than disguising one as a tall modal |

**Anatomy, and the actions slot belongs to `Sheet`.**

```
        ━━━            grabber — compact and draggable only
 Title                 ×
 ───────────────────────────────
 content, scrolls
 ───────────────────────────────
 [ primary ]  secondary        fixed; reachable while the body scrolls
```

A screen **supplies** actions; it does not decide where they sit or how they relate. Left to
each modal, `Done`, `Cancel` and `Apply` acquired a different arrangement every time — one of
them stacked into a column because the content above it happened to grow.

**Keep the close button even once swipe exists.** Swipe is the convenience; the button is what
makes dismissal obvious and gives assistive technology and the keyboard a target.

`AlertDialog` is the deliberate exception to the width-driven Sheet presentation: a short,
consequential decision remains a centred alert at every width. It has no close control because
its explicit safe action is `Cancel`, and its scrim cannot answer the decision. The primitive
owns the `alertdialog` name, safe initial focus, Tab loop, trigger restoration and Reduce Motion
handling; a feature supplies only the consequences and actions.

**Gesture priority, so the drag and the scroll do not fight** (§25). The pan lives on the
**whole surface** and engages only while the body is scrolled to its top, claiming the gesture in
the capture phase so that arbitration is the sheet's and not the scroll view's. A drag started
mid-scroll scrolls the list; the same drag at the top moves the sheet, wherever on the sheet the
finger landed. Release past 96 pt — or flick faster than 0.6 px/ms — dismisses; anything less
springs back, and Reduce Motion drops the spring while keeping the drag, because direct
manipulation is not decorative motion.

> **Amended 2026-08-15 (founder report).** This paragraph used to place the pan on the header
> alone — "a drag starting on a row scrolls the row's list; a drag starting on the grabber or the
> title moves the sheet". Built that way, the "scrolled to its top" condition could never decide
> anything, because the header does not scroll, and the gesture everyone actually makes — swipe
> down from the middle of the sheet — did nothing at all. Reproduced in a browser: a touch drag
> on the title dismissed, the identical drag from a date row did not. The two clauses could not
> both hold; the condition is the one worth keeping, because it is the one that separates the two
> readings of a downward drag.

**Every exit converges on one `requestClose`.** Scrim, close button, hardware Back, Escape and
the drag all pass through it, so `dirty` guards all five or none. `✕` asking while swipe silently
discards is the divergence this shape exists to prevent; a screen supplies `dirty` and its own
prompt, and cannot guard one path and forget another.

> **Implementation status — 2026-08-13.** Detents, the actions slot, the keyboard contract, the
> grabber, drag-to-dismiss, Android scroll-to-focused-field and the `dirty` guard are **built**.
> `Repeat` is the first adopter of `dirty`, being the one sheet whose selection is not saved
> until its commit; sheets that write on tap have nothing to discard and correctly pass nothing.
> Remaining: §26's runtime gallery fixtures, and the drag's *feel*, which needs a device — the
> geometry, gesture priority and dismissal thresholds are covered by tests, the finger is not.

### 6.2 The keyboard contract

Added 2026-08-13 (P2-51). **Keyboard handling belongs to the containers that own layout —
`ScreenShell` and `Sheet` — and to no screen.** A screen supplies fields; it does not compute
keyboard offsets, keyboard height, safe-area maths, or scroll-to-focused-field. An unexplained
`keyboardVerticalOffset = 86` is right on one device and wrong on the next, and there is no
review that reliably catches the difference.

**A focused editable control is never hidden behind the keyboard.** When the keyboard opens, the
focused field, its label, its current validation message, and enough surrounding context to know
what is being edited all stay visible. The user never scrolls blind to find the caret.

| Container | What it does when the keyboard opens |
| --- | --- |
| `ScreenShell` | Adds the keyboard's height to the scroll's bottom inset, so a field at the end of a long screen has somewhere to scroll *to*. Without it the last field cannot be brought into view at all. |
| `Sheet` | Lifts the **whole surface** clear, so the fixed actions slot rides up with it. The percentage detents resolve against the remaining space, so a `medium` sheet shrinks rather than being pushed off the top. |

**Lifting only the body is the failure this is written against** — it leaves `Save` behind the
keyboard, which is the one control the edit cannot finish without.

The safe-area inset is **dropped while the keyboard is up**: the home indicator is underneath it,
so the space is no longer owed and paying it twice reads as a gap.

`ScreenShell` keeps ownership when the body is paginated: a screen may supply its pagination
callback and throttle, but it does not install a nested ScrollView. Content-size changes re-check
the already-focused field, which is what keeps rapid-entry controls visible after each insertion.

`useKeyboardInset()` is the single source of the number. It has a `.web.ts` fork because React
Native Web's `Keyboard` module never fires; the browser reports the same fact through
`visualViewport`.

**Dismissing the keyboard is not cancelling an edit.** Keyboard dismissal preserves the field's
value. Sheet dismissal, `Cancel`, `Save` and keyboard dismissal are four distinct behaviours and
are never bound to one event.

> **Still open — 2026-08-13.** Scroll-to-focused-field currently relies on the platform
> (`automaticallyAdjustKeyboardInsets` on iOS, the browser's native focus scrolling on web);
> Android has no equivalent and needs an explicit measure-and-scroll. Dirty-state dismissal is
> defined only for compose; every other sheet needs the §20 contract before drag-to-dismiss
> lands, or `✕` and swipe will diverge.

### 6.3 Settings-surface grammar

This section defines reusable composition rules; it does **not** define an app-wide Settings
page, its navigation or its inventory. A feature owns which settings exist. The system owns how
any settings surface is structured once that product decision has been made.

**Choose the container from scope.** Object-scoped configuration reached from that object's
overflow opens a `Sheet` and returns to the same object. Configuration that a product spec
defines as app-wide uses a `ScreenShell` detail destination. Do not invent a global settings
home merely to reuse this anatomy, and do not disguise a long hierarchy as a full-height sheet.

**Order sections by consequence:** identity first when editable; then the object's primary
mode; dependent presentation; optional features; destinations or integrations; access; and
management last. Omit empty sections. Destructive management never sits beside ordinary
switches, and it uses `danger` ink plus the confirmation contract rather than a red decorative
container.

**One row, one promise.** Use the control whose affordance matches the write:

| Setting shape | Control | Trailing treatment |
| --- | --- | --- |
| One of two to four compact, mutually exclusive modes | `SegmentedControl` | Selected segment only |
| Independent boolean applied on tap | `SettingRow` switch | Aligned switch column; no chevron or selected check |
| Opens a focused editor or chooser | `SettingRow` | Current value in `textAction` plus chevron |
| Commits one value immediately | Selectable `SettingRow` | Selected tint plus trailing check; no chevron |
| Destructive action | `SettingRow` or `Button` with danger semantics | Explicit destructive verb; never a switch |

A row never combines a switch and chevron. A chevron always opens another surface; a switch
always changes the named boolean. Summaries describe the current value or effect in one quiet
line and never restate the label.

**Dependencies stay legible.** A dependent setting is absent until its parent mode makes it
meaningful. Enabling a feature that needs secondary configuration opens one focused child
surface once; afterwards the parent row shows the configured vocabulary or value and `Edit`.
Do not leave a mini-form permanently expanded in the main settings surface, and do not show a
screenful of disabled controls for unavailable configuration.

**Settings are not a wizard.** Independent reversible settings apply independently and keep
the user on the same surface; they do not acquire `Next`, `Done` or a page-wide `Save`. A fixed
footer commit exists only when several fields intentionally form one draft. Effective writes
follow `interaction-contract.md` §1a.1 and §4: immediate optimistic feedback, exact undo where
the action is reversible, and a consequence-naming confirmation only where data is removed.

Section headers use `SectionHeader`; rows use the 72 pt `SettingRow` minimum and one aligned
trailing column. At large text sizes summaries wrap and trailing values move below before any
label truncates. At compact width the surface keeps 16 pt gutters; at larger widths it follows
the owning `Sheet` or `ScreenShell` rather than inventing a new settings breakpoint.

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
 │ 2:30 ║ UP NEXT · IN 2H 15M                         │  time rail · double rule · caption, textAction
 │  PM  ║ Dentist appointment                         │  bodyStrong — no marker, no checkbox
 │      ║ ─────────────────────────                   │  1 px border rule under each band
 │      ║ Jefferson Dental Center                     │  subhead — the metadata band
 │      ║ ─────────────────────────                   │
 │      ║ Directions   Snooze                         │  footnoteStrong text actions, textAction
 └────────────────────────────────────────────────────┘
   accentSurface fill · no left edge
```

One card, always the next timed thing, per `today-and-tasks.md` §2.1. Its actions are the
row's own quick actions as text buttons — no icons, no chrome.

> **Restructured — 2026-08-31 (founder frame, the planner page).** The time moved off the
> subtitle line into a margin rail — `heading` numerals in `textAction`, the meridiem
> beneath in `caption` `textSecondary` — beside a **double** hairline, a planner page's
> ruling. The title and the metadata render as ruled bands, each with a 1 px `border` rule
> beneath it; the marker column and the completion checkbox are gone from this card (the
> `complete` text action is the completion path here), and the 3 pt `accentDeep` left edge
> is removed — beside the margin ruling it read as a third vertical line. All rules are
> decorative and hidden from assistive technology; the rail is one accessible element
> carrying the full formatted time, and the card's backdrop announces title, time and
> metadata as one button since no embedded row carries them any more. This is the one
> surface that departs from P2-21's one-row rule, on this frame.

> **Annotation correction — 2026-08-13 (P2-51).** This diagram said the eyebrow was
> `accentDeep` and the actions `accent`. Both were wrong against §5.1's own contract: `accent`
> is never a text colour, and dark `accentDeep` is 4.4:1 on `surfaceRaised`. Both are
> `textAction`, which is readable in both schemes — light `accentDeep`, and since 2026-08-16 a
> lifted mulberry in dark rather than `textPrimary` (§5.1). The prose below the diagram already said this for the relative-time
> label; the annotations had not been updated, and an implementer reading the picture rather
> than the paragraph would have shipped the older rule.

On the light `accentSurface`, the relative-time label uses `textAction` and the embedded
row's subtitle uses `textPrimary`. The decorative `accent` token is never text, and
`textSecondary` measures 4.45:1 on this tinted surface rather than the required 4.5:1.

**Timeline rows.** Rows are not cards. A time rail on the left, a marker column with a
hairline connector, content to the right:

```
 2:30 PM   ◇   Dentist appointment                       title: bodyStrong, textPrimary
           │   Jefferson Dental Center                   subtitle: footnote, textSecondary
 5:30 PM   □   Pick up groceries
           │   Task · 4 items on Groceries
```

- Time rail: `footnote`, `textSecondary`, right-aligned, fixed column.

  > **Amended 2026-08-17 (founder).** The row's own grammar is now `bodyStrong` over `footnote` —
  > 16 pt semibold with 13 pt beneath it. It was `body` over `subhead`, which left two points
  > between the two lines and made every row read as two equal ones. The rail is `space[11]`
  > wide: `12:00 PM` measures 58 pt in `footnote`, so the previous `space[10]` truncated it.
- Marker column: the task checkbox or the 16 pt type marker; a 1 px `border` connector
  line runs vertically between markers — it is what makes the day read as a timeline.
- The **NOW divider** sits between EARLIER TODAY and what remains: `NOW` in `caption`
  **`textAction`**, a 1 px `accent` hairline across, the current time right-aligned in
  `footnoteStrong` **`textAction`**.

  > **Both labels moved off `accent` — 2026-08-17, caught by the axe gate.** This line said
  > `accent` for the two text runs; light `accent` `#8B6374` is **4.34:1** on `surface`, under
  > `interaction-contract.md` §6.4's 4.5:1, and §5.1 already states that `accent` is never body
  > text on `surface`. The hairline keeps it — a graphic owes 3:1, which it clears. It is rendered by the same one-minute ticker that maintains
  UP NEXT (`today-and-tasks.md` §2) and is purely presentational.

  > **Resolved 2026-08-17 (founder, P2-44).** This sentence had no position under the section
  > order `today-and-tasks.md` §2 originally fixed, in which EARLIER TODAY rendered **last** and
  > nothing remained after it. P2-44 was written to bring the founder the candidates rather than
  > bend one document to the other. The answer moved the section: EARLIER TODAY now renders above
  > SCHEDULE, and the divider sits between the two — which is what this line has always described.
  > It is `accessibilityElementsHidden`: a screen reader hears the sections, and a decorative rule
  > announcing "now" between them adds a landmark that is not one.
- EARLIER TODAY rows are `dimmed`; completed rows additionally `struck` with the olive
  check in the marker column. The section header carries `2 done ⌃` as its collapse
  affordance.

  > **Clarified 2026-08-17 (P2-44).** `2 done ⌃` and the `Show all` expander
  > `today-and-tasks.md` §2.4 specifies are **two controls, not one**, and an earlier reading of
  > this line as replacing that one would have stranded every row past the tenth. `2 done ⌃` is a
  > header affordance that collapses the whole section; `Show all` is a footer that uncaps rows 11
  > and beyond, and applies inside once the section is open. Both ship.
- A completion first renders checked and struck where the row was. After the `fast` hold it
  fades over `base`, then the ordinary projection places it in EARLIER TODAY. Do not animate
  the row travelling through the intervening screen; Reduce Motion removes the hold and
  insert/remove transition.
- Overdue rows: a `warning` Chip in the time rail showing the original date.
- Vertical: `space[5]` top and bottom per row → 56 pt minimum; separator is the connector
  line, not a horizontal rule.

### 7.2 Lists — collection cards

The Lists index is a 2-up grid of cards at every supported width, each list one card:

```
 ┌──────────────────────────┐  radius.lg · e2 · collection-card surface
 │  [icon squircle 44]      │  neutral translucent IconTile
 │  Groceries               │  heading, textPrimary
 │  12 items · 5 checked    │  subhead, textSecondary
 │  ────────                │  ProgressBar (neutral) — only when the list is checkable
 │  Updated today           │  footnote, textDisabled
 └──────────────────────────┘
```

> **Corrected 2026-08-25 (founder), P3-25.** The count line was specified as "the list's
> own vocabulary (`7 remaining`, `4 of 12 packed`, `12 places`) — supplied by the preset's
> copy". **No such field exists**: a §5.3 catalogue record carries a chooser label, summary,
> default title, icon, state presentation, feature configuration, slot and empty-state copy, and nothing
> else. Adding one would put per-type copy back into the catalogue and make the card renderer
> read it again — precisely what ADR-031 removed and what P3-25's grep test forbids. It would
> also drift, since template values are frozen at creation: a list made a year ago would
> describe itself differently from the same template today, on a line that is arithmetic.
>
> **One vocabulary, every list**: `n items`, with `· k checked` appended only in checkbox mode,
> from `itemCount` and `doneCount` on the `META` row the index already batch-reads. The progress
> bar is gated on the same mode. A future preset then renders correctly without catalogue copy.

The count line is computed from the List's own stored fields, never from template copy.

> **Amended 2026-08-29 (founder).** The neutral-card treatment made every collection read as
> the same object with a different icon. The whole card now uses §5.2a's soft collection
> surface. Cards remain one common component and one common List model; colour is varied
> presentation, not a category, state, priority or stored setting. The checkbox progress bar
> remains the founder-approved exception: it reports `doneCount / itemCount` and never means
> “scheduled”, “planned” or that the List itself is an obligation to finish.

`Updated today` renders **`lastItemActivityAt`**, not `updatedAt`
(`data-model.md` §4.6). `updatedAt` backs `If-Match` and moves on a rename or a settings
change but not on checking an item, so a card using it would say `Updated 3 days ago`
immediately after the list was used, and move when it was renamed — backwards from what the
line means to a reader. `+ New list` is a `footnoteStrong` accent text action in the screen
header, not a FAB. Tapping a card opens the list (U1); nothing on the card mutates.

**Variable-height shelf.** The two columns stack independently at `space[4]`; a progress bar,
two-line title, restore action or extra metadata changes only its own card and never creates an
equal-height row band beneath its neighbour. Source order is not height-balanced: within each
active and archived group, the client first stably sorts newest-created by the time-sortable
`listId`. That sorted sequence fills the first contiguous column and then the second, so visual
reading order, keyboard order and screen-reader traversal agree. The horizontal gutter is also
`space[4]`, and both outer edges stay aligned to the tab gutter.

The index scroll content uses the shared floating-chrome metric for its compact bottom padding.
That metric owns the tab-bar height, global Add clearance and the safe-area-aware bar offset; a
Lists screen must not restate any of those numbers. Loading, empty, active and archived content
all live inside that same padded scroll measure, so their final interactive element can scroll
fully above navigation. At `medium` and `expanded`, where the rail replaces the floating bar,
ordinary bottom safe area plus the standard spacing token is used instead.

#### 7.2a List creation and settings contract

`New list` is a two-step sheet. Step one is headed `Choose a list type`, contains no title
field and begins with nothing selected. **Blank list is one full-width leading card**, the
explicit escape hatch. Beneath it, a 2-up grid shows Checklist, Groceries, Watch Later, Books
to Read, Places to Visit and Meal Ideas in that left-to-right, top-to-bottom order. Each card
contains the stored catalogue icon, label and one explanatory line. These are choices, not
selected states: no card is pinned, recommended, pre-tinted as a default or history-ranked.
Step two alone contains the selected preset's name and summary plus the editable title; its
fixed footer carries `Back` and `Create list`.

The List settings sheet keeps inline title editing above this exact hierarchy:

```text
ITEM STATE
[ None | Checkboxes | Stages ]
Group by stage                            [switch]   # stages only

ITEM DETAILS
Progress                                  [switch]
Places                                    [switch]
Sub-items                                 [switch]
```

Destination settings follow as a subordinate section. First enabling Sub-items opens a
focused configuration sheet; its vocabulary controls never remain expanded in the main sheet.
Rows use the 72 pt `SettingRow` rhythm, section spacing tokens and one aligned trailing switch
column. This is the List-specific instance of §6.3's reusable settings-surface grammar, not a
definition of an app-wide Settings page. The compact sheet uses the approved near-full-height
detent rather than shrinking to its current content.

An empty List centres one compact semantic `IconTile`, the heading `Start with one item`, the
List's stored guidance line and one primary `Add item` action. It does not show an empty row,
repeat `No items`, or introduce a large decorative illustration. The action opens the same item
composer used by the persistent add row on a populated List.

The canonical founder reference is
`docs/04-conventions/visual-references/p3-33-list-settings.png`. First screenshot baselines
require a human side-by-side comparison with that reference; a baseline may not be approved
merely because it matches the current implementation. Review explicitly records spacing,
section gaps, row height, segmented-control geometry, switch alignment, selected state and
sheet sizing. Only after that approval do exact CI pixel comparisons protect the result.

#### 7.2b Open List anatomy

An open List is a content surface, not a second collection card and not a sparse hero page.
Content begins immediately after the standard header: no cover, oversized title block, empty
spacer or duplicate List name may sit between the header and the first useful line.

The header follows the Activity-detail two-line hierarchy. Its navigation line has one leading
44 pt Back slot and a trailing action group containing the fixed Share slot and one 44 pt More
slot. The editable List title is a separate leading-aligned line immediately below. The pencil
stays vertically aligned with the title inside the same editable control; the title may grow to
two lines before clipping, while Back, Share, More and Pencil never shrink or leave the viewport.
Rename still commits on Return or blur and adds no Save/Cancel pair.

```text
‹                                             Share  ⋯
Groceries ✎
4 items · 2 checked
──────────────────────────────────────────────────────
☐  Paper towels
   Large pack                                      ⋮⋮
☑  Yogurt
   1 cup                                           ⋮⋮
──────────────────────────────────────────────────────
⊕  Add an item
   to Groceries
```

The compact overview bridges title and content using the same computed count grammar as the
index card. It is muted information in `textSecondary`, never a button, progress bar, reorder
instruction or sticky toolbar. Persistent visible row grips are the reorder discoverability
mechanism. When the List is empty the approved compact empty state replaces the overview and
rows.

Items use the common 56 pt-minimum `Row`: checkbox when exposed, body, populated typed-feature
summary or disclosure, then a 44 pt trailing grip hit target. The grip stays visibly neutral
and never becomes a menu or a decorative chevron. On touch layouts it is persistent; pointer
layouts reveal it on hover and keyboard focus. The drag wrapper owns it so `ListItemRow` remains
one semantic item renderer. The body still opens item detail and whole-row long-press still
starts the same drag (`interaction-contract.md` §3.2).

The add control is the final row in the same measure, not a detached FAB, screen footer or
Lists-index action. Its plus sits in a small dashed IconTile and the two-line copy reads
`Add an item` / `to <list name>`. It opens the compact shared composer inline in the same
scrolling List measure, so the standard header and current content remain visible and the
rapid-entry row can scroll above the software keyboard even after the List grows. The current
List fixes the destination; there is no chooser or `New list`. A single `underline` field is
accessibly named `Add item to <list name>` and sits beside `Add`; `Done adding` closes the row.
Note and typed features belong to Item details. Return performs the same single write, then
clears and re-focuses the title field. The row has no duplicate Cancel or modal close control.

Both Lists overflow sheets use the compact `SettingRow` grammar: a 56 pt minimum, aligned leading
icon, label, optional wrapping subordinate summary, and a bottom divider. Only a row that opens
another surface has a chevron. A toggle carries its state accessibly and visibly; destructive rows
use danger ink and an icon on a transparent row, separated by a token gap, never a filled oversized
button.

Item details uses the compact Title field, the labelled top-aligned optional Note, then exposed
State and enabled typed-feature groups. A configured Sub-item section uses its own vocabulary,
an item count and `Add <singular>` action. Each child is a 56 pt-minimum row with a persistent
leading grip, title and populated secondary value, and a trailing 44 pt More action. Tapping its
body enters compact inline editing. More opens a content-sized action sheet containing compact
Move up, Move down and Remove rows; those controls never expand the normal child row. `Delete
item` closes the editor as a divider-separated danger menu row.

Grouped staged Lists insert tinted populated section headers between the count and rows. Each
header carries a stage icon, configured label and count; it never reads as another item, and
each group keeps its own reorder bounds. At 200% text the count and trailing metadata
may move below the title before any label truncates; the grip retains its 44 pt target.

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

> **Amended 2026-08-25 (founder, screen board), built by P3-36 — the frame is the day on the
> dated stages.** The event card above stands for **Needs a date** (and the public invite
> header), where each card is one plan. Upcoming and Past were settled as **one card per
> day**: the day heading, then a single `radius.lg` card whose `AgendaRow`s are separated by
> hairlines, so the card edge means the unit the heading already names and eight rows draw
> four frames rather than eight. The per-plan card cannot carry the dated stages as drawn —
> Upcoming is *every dated Activity*, and a 44 pt squircle has nowhere to put a task's
> checkbox — which is why P2-32 reached for `AgendaRow`; this records what replaced the
> per-row `Card` wrapper it shipped. Gap lines stay outside the cards, and Past is the same
> component with the row's own past de-emphasis and outcome verb.

- The stage switcher is the `SegmentedControl` (`Needs a date · Upcoming · Past`); below it,
  the `All · Personal · Shared` filter Chips.

  > **Corrected 2026-08-25 (founder), P3-36.** This line said "with counts where a stage
  > carries a badge-worthy number". `plans-and-lists.md` §1.3.2 rule 1 is "no badge on the
  > Plans tab, **ever, for any stage**" and rule 2 forbids a count in a stage heading — so
  > there is no badge-worthy number to render. The control carries its three words and
  > nothing else. The switcher itself stands (§1.3, amended the same day): its three words
  > stay on screen, which is what preserves the vocabulary while `needsDate` — which does not
  > paginate — stops burying Upcoming below the fold.

- **The calendar navigator sits directly beneath the switcher on Upcoming and Past**, and is
  absent on Needs a date. Collapsed it is a seven-column rolling strip; expanded it is a
  normal month calendar of the same seven columns, so one day-cell component serves both.
  Three cell treatments, and the middle one is the one to get right: a live date in the
  displayed month is normal, a live date spilling in from an adjacent month is subordinate
  but plainly readable and tappable, and an out-of-stage date is inert. Behaviour, eligibility
  and encoding are canonical in
  [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.3.4.
- The whole card is one tap target → plan detail (U1). The RSVP pill, when present, is a
  separate target.
- At most one system-feed line renders at a card's foot (the most recent unseen entry, in
  `warning` when it is a change, `textSecondary` otherwise); everything else lives in the
  detail's Updates section. A card never stacks notifications.
- Undated (Needs a date) cards render `No date yet — 2 suggestions` in the date slot,
  `footnote`, `textSecondary`. Past cards render their outcome verb.
- The plan card remains the header of the **public invite page** — one plan, given room.

> **Amendment — 2026-08-13 (P2-51).** This bullet used to send the plan card to the plan
> *detail* screen as well. §7.5 superseded that on 2026-08-12 with **one header grammar for
> every activity type** — title, then type-and-audience, then the schedule as a tap target,
> then the primary action — and a Plan is not a special case of it. §0's hierarchy rule settles
> it independently: a card at the top of a detail screen makes the page its own hero, and the
> hero on that screen is the completion action. The two sentences had been left for an
> implementer to choose between; the invite page keeps the card because it is a shared,
> standalone page rather than a screen inside the planner.

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

> **Amended 2026-08-25 (founder), P3-37 — reconciled with `plans-and-lists.md` §2.1.** The two
> documents disagreed: §2.1 specified ten expanded sections with the completion button last;
> this section specified collapsed disclosure rows throughout. **Rule 1 below wins and is
> unchanged** — the completion action stays at the top. Rule 2 is narrowed: *always collapsed*
> becomes *collapsed once it has outgrown the screen*.
>
> A **setting** (Notes, Reminder, Repeat) always renders as one compact row. A **section**
> does not exist until it holds something, and is discoverable meanwhile as a named chip in a
> single `Add to this plan` row at the foot. A section holding 1–3 rows renders them in full;
> 4 or more shows the first three, then `Show all n`. The full rule, with its rationale, is
> canonical in [`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1.
>
> The reason rule 2 needed narrowing: a disclosure that costs a tap to reveal *less text than
> the row occupied* is not hiding anything, and a plan with two prep tasks was exactly that
> case. Rule 2's warning still stands for the case it was written about — a collapsed row must
> never render a long value in full.

**Three rules hold the whole screen.**

1. **The top says what it is, when it is, and what to do next** — in that order, in one
   grammar, for every type. Title, then type-and-audience, then the schedule as a tap target,
   then the primary action. Nothing else competes for the top of the screen.
2. **A capability is one compact disclosure row until opened.** The collapsed row presents its
   label, current summary and a trailing chevron. Tapping the whole row expands it inline to
   show either the current content or its real add controls, and the row exposes its expanded
   state to assistive technology. Empty functional capabilities stay discoverable. **The
   summary is one truncated line, never the value itself** — a collapsed row that renders a
   long note in full is a disclosure that has disclosed everything while claiming to be shut,
   and it pushes every capability under it off the screen. The accessible name carries the
   whole text; the clamp is visual only.
3. **A named future Plan capability may be discoverable without pretending to work.** People
   — plus Ingredients on a Meal — render as non-interactive rows ending in `Coming later`
   until their owning phase builds them. (Preparation, Related lists and Attachments were on
   this list until P3-38, P3-39 and P3-41 wired them; each is now discovered through its chip
   in the `Add to this plan` row while empty, and carries its own `+ Add …` once populated.) They
   have no chevron, disabled action, expansion or tap behaviour. All other unbuilt
   capabilities remain absent. A task still renders no Plan-only future rows. They are also
   **visibly subordinate**: `body` in `textSecondary` over `textMuted`, and shorter than
   `layout.rowMinHeight`, which is a measure reserved for hit targets. A future row rendered
   at the same weight as a working one makes a screen where most rows do nothing look like a
   screen where most rows do something.

Capability rows carry a top rule each, so **the list carries a closing rule** — without one it
does not end, it stops, and the bottom time action's own rule reads as an orphan.

**Founder refinement — 2026-08-13.** Notes is the first capability row for both Tasks and
Plans. Reminder opens as a bounded, vertically scrollable choice menu; selected offsets remain
available to remove. ~~The completion action uses `radius.xl`~~ — superseded below. The bottom
recurrence action uses the same full-width row measure as the disclosures, with `Tap to edit`
and a trailing chevron.

**The element vocabulary comes from the frames — 2026-08-13, founder instruction.** The
`Activity Detail Restructure` frames are **not a layout to copy**; they define what a button, a
heading, a row and an editable value *look like* when placed on our own screens. Read off them,
mapped onto tokens:

| Element | Treatment |
| --- | --- |
| Capability row label | `subhead`, `textPrimary` — quiet, so the action is the loud thing |
| Capability row value | `footnote`, one line, `textSecondary` (`textMuted` when inert) |
| Live row trailing slot | chevron in **`textAction`** — the affordance, not decoration |
| Inert row trailing slot | `Coming later`, `footnote`, `textMuted`, no chevron |
| Row rule | `borderBottom` on each row, so a list closes on its last row |
| Filled control | `radius.md`, **no glow**, full width |
| Outlined control | `radius.md`, 1 pt `border` |
| Editable value in place | dashed `borderStrong` underline plus a `textAction` hint |

**A grey chevron on a heavy label is the failure this table exists to prevent.** Built that way,
a screen where five of seven rows are inert read as seven headings and nothing on it looked like
a control — which is the report that produced this table.

**`radius.md`, not `radius.xl`, for the completion action.** The earlier refinement asked for
`xl` to match the detail surface; at 22 pt on a 52 pt control the corners meet and it renders as
a lozenge, and at `compact` there is no surface to match because the card only appears from
`medium` up. The frames draw every filled control as a soft rectangle. The frames win, per the
founder's instruction above. **`accentGlow` is removed from `Button` entirely** — no frame in
either palette puts a glow under a filled control, and the token existed for that one use.

**The completion action.** One component, one position, one accessibility pattern for both
object kinds — there is no Task treatment and no Plan treatment. Its label is derived from the
activity's type (`Done`, `Had it`, `Watched`, `Attended`), which is `overview.md` §4.1's "type
guides, never restricts" applied to a verb, and it must match the verb the row's trailing slot
and the passed-plan sheet render for the same activity. The button is **absent** when the
caller lacks the completion capability; it is never shown disabled. On an occurrence of a
series, `Snooze` and `Skip today` follow as a secondary pair.

It is **also absent on a series with no occurrence in scope**, because there is no safe write
behind it: `POST /complete` without an `occurrenceDate` sets `status: 'completed'` on the
series row itself and retires every future occurrence, which is rule 3 undone by one tap. The
screen is given an occurrence date only when navigation came from a specific occurrence on
Today or Plans. A direct/search series-only detail has nothing to complete; it never guesses
today or the next cached occurrence. A generated future occurrence also suppresses the primary
completion action until its date, while an existing future completion remains reversible.

**Once resolved, the screen says so before it offers the reversal** — the outcome verb in
`success`, then `Undo`. An occurrence's resolution is not readable from its series (`Occurrence`
overrides never move `ACT#/META`), so the screen that recorded it holds that state; a screen
that recorded an outcome and then showed no trace of it is the one failure this ordering exists
to prevent.

**The schedule line is a tap target and never an inline field** (U4). This holds wherever a
date is rendered in the product; the detail screen is not an exception to it. It uses
`EEE, MMM d · h:mm a` in the current year (adding the year otherwise), carries the visible
hint `Tap to edit`, and is immediately followed by the combined recurrence/reminder summary.
The bottom time-actions block contains `Edit recurrence` when recurrence is available.
Delete remains only in the `⋯` menu.

**Capability order**, when each is built: Notes, Reminder, People, Preparation, Related lists,
Expenses, Attachments. A task shows only Notes, Reminder when scheduled, and Related plan and
renders no placeholder for anything it lacks — a Task is not a Plan with things hidden
(`today-and-tasks.md` §5.6).

---

## 8. Responsive

The breakpoints are the three in `tech-stack.md` §3.5 and are not extended. Device classes
map onto them:

| Device class | Width | Breakpoint | Layout |
| --- | --- | --- | --- |
| Phone | 320–429 | `compact` | Single-column screen structure, 16 pt gutters, bottom tab bar. **Modal controls present as bottom sheets at the smallest detent that fits the task** (§6.1) — full-screen presentation is reserved for flows whose content requires it. The Lists index remains a 2-up card grid. Verified at 320 with no horizontal scroll and no clipping. |
| Large phone | 430–767 | `compact` | Identical structure. The extra width goes to the title column, not to new elements. Avatar stack may show 4. |
| Tablet | 768–1199 | `medium` | Single column capped at 720 pt and centred; 24 pt gutters; the tab bar becomes a left rail. List cards remain 2-up. Sheets present as centred cards at 480 pt wide. |
| Web, wide | ≥ 1200 | `expanded` | **Two panes.** |

**The left rail** (from `medium` up) is the mock's: the `Ordinary Days` wordmark in serif
`title` at top, then `Today / Plans / Lists` — and `People` after a gap, because People is
a layer, not a tab (`sharing-and-people.md` §6) — each a `body` label, the active one
carried on a `surfaceSunken` pill (`radius.md`). The signed-in name sits at the rail's
foot in `footnote`, `textDisabled`. At `compact` the same three tabs render as the bottom
tab bar and People stays under Profile.

**The bottom tab bar is a floating capsule** (added 2026-08-17, geometry fixed 2026-08-18). At
`compact` it does not span the width and has no rule above it: `radius.pill`, 64 pt tall,
`surfaceRaised` at `e2`, inset `space[7]` from each side, its bottom edge `space[4]` above the
screen. Because it floats it no longer occupies layout, so **every scrolling tab reserves its
height plus that gap** — a row left underneath it is visible and unclickable, which is not a row
bug. That reservation and the bar's own offset are one value, `tabBarBottomOffset`, and must not
be restated anywhere.

Two platform rules the capsule depends on, both learned the hard way:

- **Inset it with `marginHorizontal`, never `left`/`right`.** React Navigation's `BottomTabBar`
  already applies `{ start: 0, end: 0 }`, and Yoga resolves those logical edges *ahead of* the
  physical ones — so `left`/`right` are silently discarded on device while React Native Web,
  which maps `start`/`end` to `inset-inline-*`, honours them. That divergence renders correctly
  in a browser and full-width on an iPhone, and no web screenshot can catch it.
- **Cap the safe-area inset into the gap; do not add it.** A home indicator reports 34 pt and web
  reports 0, so adding it floats the same capsule 38 pt up on device and 4 pt up in a browser.

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
| Text truncation | `Text` defaults to `numberOfLines={2}` in the `body` **and `bodyStrong`** variants used by rows (amended 2026-08-17: the agenda row's title moved to `bodyStrong` with the 16/21 scale, and the clamp follows the role rather than one variant name). |

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
