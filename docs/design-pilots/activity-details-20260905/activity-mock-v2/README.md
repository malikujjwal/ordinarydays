# Activity details — mock v2: the type-specific details, rendered and editable

Status: **direction commissioned for implementation, 2026-09-09.** The founder asked for an
implementation prompt and approved the `ADD TO THIS TASK` row; the prompt is at
[../IMPLEMENTATION-PROMPT.md](../IMPLEMENTATION-PROMPT.md). That accepts the direction, **not**
every proposal here: the thirteen conflicts below are open, and the doc amendments they imply
are owed by whoever implements. v1'''s README records an earlier agent "incorrectly calling the
design approved and directing contract updates" — do not repeat it by treating a rendered mock
as a settled contract.

Run: `python -m http.server 8101 --bind 127.0.0.1 --directory docs/design-pilots/activity-details-20260905`
then open <http://127.0.0.1:8101/activity-mock-v2/>. The server root is the **pilot folder**,
not this one, because the mock borrows `../activity-mock-v1/Newsreader.ttf` rather than
duplicating the font binary. There is also a `design-pilot` entry in `.claude/launch.json`
that runs exactly this.

## What problem this addresses

v1 was about the notes editor. It did not touch the gap this mock exists for.

`ActivityDetailScreen.tsx` touches `activity.details` in exactly **two** places — both meal
ingredients (`:1729`, `:1732`). Every other type-specific field is captured by
`compose/forms/TypedFields.tsx`, validated, stored, returned by `GET /v1/activities/:id`, and
never drawn. Also unrendered: `sourceUrl`, the `listId`/`listItemId` backlink, and the parent's
name behind `parentActivityId` — which today renders as the boolean `None` / `Part of a plan`.

The sharpest symptom: **detail says less than the row that opened it.** A Watch row on Today
reads `Watch · S2 E4`; tap it and the season and episode disappear.

## The rule the design follows

> **Above the type sections everything is a control and uses `SettingRow`; inside a type section
> everything is content and uses the section-content grammar.**

`SettingRow`'s own doc comment (`packages/ui/src/primitives/SettingRow.tsx:14-18`) already draws
this line: "`Row` is for **content** — something the user made… `SettingRow` is for a
**control**." A reservation, an episode title and a streaming service are content the user
typed. Putting them in the 72 pt label/value control rhythm is the category error that makes an
Event read as eight form fields.

Three layers:

1. **Identity → the header's existing type-and-audience line.** `Meal · Dinner · Just you`,
   `Watch · S2 E4 · Just you`. This is §7.5 rule 1's own second slot doing its job, not a new
   competitor for the top of the screen.
2. **When / where is untouched.** It is two deliberate tap targets (date → reschedule, address
   → Maps). A `Netflix` line inside it would be a third target with no destination, and a
   streaming service is not a *where*.
3. **Everything else → topic-named sections**, after the settings group and before
   `PREPARATION`. Named `RECIPE`, not `MEAL`: a type-named section says the type word twice in
   one screen height and renders `WATCH` over a lone `Streaming service` row. Ordering
   principle is **identity → configuration → accretion → feed** — a reservation is what the plan
   *is*, `PREPARATION` and `ATTACHMENTS` are what accretes onto it. `INGREDIENTS` stays where
   P3-43 built it, because it genuinely is accretion.

## Editing

Everything else on this screen can be changed — title, notes, date, repeat, reminder, kind. The
type details had no reason to be the exception, and the API already accepts them: `PATCH
/v1/activities/:id` takes `details` (`packages/shared/src/schemas/activity.ts:575`), `merge`
applies it on the ordinary path (`activityService.ts:956` → `:1273`), and `assertPatchableFields`
(`authz.ts:411`) does not restrict an owner. The gap was only ever client-side.

**Editing is section-level, not row-level.** Each section header carries one `Edit` in its
trailing slot — the same slot `SectionFrame` already uses for `0 of 2` and `Add list`. The rows
themselves stay content: no chevrons, not individually tappable, so a tap on a link row still
does the one thing a link row should do, which is open the link. That keeps the control/content
distinction legible instead of quietly turning every fact back into a form field.

**One sheet per type carries the whole `details` object.** This is not a convenience —
`PATCH` **replaces `details` wholesale** (`activityService.ts:1336` says so outright), so a
sheet that edits one field in isolation and sends only that field would silently drop the rest.
Grouping the whole type into one sheet makes the correct payload the natural one. The one
exception is already handled server-side: `withRetainedProvenance` carries each ingredient's
server-owned `addedToListId` across the replacement, because the client is not allowed to send
it.

**An empty group is a named chip.** `Recipe`, `Episode`, `Booking`, `Tickets`, `Description`,
`Link` — sitting in the `Add to this plan` row beside `Prep task`, `List` and `Photo`, and
opening the same sheet the `Edit` action does. This is §2.1's own mechanism, applied
unchanged; it is what makes the empty case reachable instead of a dead end.

`Link` (`sourceUrl`) moved out of the settings group into its own content section for this
reason: it is user-entered content, so it is edited like the rest. `From <list>` and
`Related plan` stay controls in the settings group, and stay read-only — they are derived
provenance, and you do not edit a backlink.

Money survives the round trip as integer minor units in both directions: `money()` formats with
integer division and `padStart`, and `centsFromInput()` parses a typed `37.5` back to `3750` by
string concatenation. **Neither multiplies a float, and neither uses `toFixed`** — see conflict
6 for why that matters.

## Examples, and what each one proves

| Example | Proves |
| --- | --- |
| Meal · everything set | Slot rides in the header line instead of taking a row. `RECIPE` shows the host, not the URL. The pasted link equals the recipe link, so the `Link` section is deliberately absent. |
| Meal · nothing set | The empty case: no section and no gap, but a `Recipe` chip that opens the same sheet `Edit` does. Set a slot and the header line picks it up. |
| Watch · show, renamed, from a list | Abbreviated in the header, spelled out in the section. `From Movies to watch`. `Watchlist title` appears only because the title was renamed *and* there is a linked item. Switch Movie/Show in the editor and the season and episode fields go with it. |
| Watch · season, no episode | The partial. Header shows `S3`; the section spells out `Season 3`. |
| Watch · movie with a stored season | Season 2 and episode 4 are stored and render **nowhere**. |
| Event · shared, everything set | The privacy lines appear together, and only on a shared activity. Nine fields in one sheet. Type `37.5` into Price and it stores `3750`. |
| Event · reservation, no tickets | A reservation with no time drops it from line 2 rather than leaving a gap. `Tickets` and `Description` are chips until they hold something. |
| Task · a prep task | A task draws no type section — only its `Link`. `Related plan` names the plan and navigates. |
| Task · plain | No parent, so no `Related plan` row. The chip row reads `ADD TO THIS TASK`, approved 2026-09-09 so a task can reach its own `Link`. |
| General | Carries nothing type-specific. `details.shortcutId` must not render, not even as `Coming later`. |
| Long title and episode title | Overflow. Check at 320 pt too. |

## Decisions worth arguing with

- **`ADD TO THIS TASK` is a new row — approved by the founder, 2026-09-09.** Task detail has
  no chip row today (`AddToPlanRow` is plans-only), so a Task whose `sourceUrl` was empty had no
  entry point at all. `Link` is the only chip it can ever carry: a task has no prep children, no
  lists and no attachments (`today-and-tasks.md` §5.6). Whoever implements this carries the
  amendment into §5.6, which still describes the screen as having no such affordance.
- **A movie never renders a season or an episode, even when one is stored.** The form hides
  those fields at Kind = Movie, but nothing clears them on a Show → Movie change
  (`changeActivityKind` handles *type* changes, not `mediaKind`), so stored values stay
  reachable. Suppressed at render, and the editor says so when you switch.
- **The pasted link is not shown twice.** When `sourceUrl` equals `recipeUrl` or `ticketUrl`,
  the `LINK` section does not render. Saving a pasted recipe link into the recipe field is the
  common path.
- **Links show the host, not the URL.** At `footnote` on one line a URL truncates mid-path and
  tells you nothing; the host is the part that says whether you trust it.
- **The streaming service opens nothing.** Editable, but never tappable-to-open:
  `activities.md` §4.3 says "free text by design. There is no catalogue and no provider list",
  and deep-linking would mean matching free text to a provider identity.
- **Never `From a list`.** A row that navigates somewhere it cannot name is worse than no row.
  If the API cannot supply the title, hold the row.
- **Public vs private is stated only when it can be confused.** On a shared activity the
  description says `Everyone you invite can read this.` and `Notes` says `Private to you`. On a
  private activity neither line appears — there is nobody to distinguish from. Same conditional,
  same trigger, as the existing `Your reminders` switch (`ActivityDetailScreen.tsx:1616-1621`).
- **Tapping the chosen segment again clears it.** A meal need not have a slot, and without this
  the first tap on Breakfast would be irreversible.

## Conflicts and questions — raise, do not resolve (CLAUDE.md)

1. **§5.3 does not match either of its implementations.** Both `deriveSubtitle` copies
   (`activityRepository.ts:240`, `agendaProjection.ts:95`) emit a `Watch ·` prefix the table does
   not have, and no `service` fallback at all.
2. **This mock extends §5.3 for the partial case.** §5.3 writes `S<n> E<n>` only when both are
   set and otherwise falls back to the media kind; the mock renders `S3` for a season alone,
   because `Show` discards information the screen has room for. A deliberate departure.
3. **§5.3's `locationLabel` fallback is dropped on detail.** A row falls back to the location
   because it has nowhere else to put it; detail renders the location in full two lines below.
4. **§7.5's capability order names no type section**, and the control-vs-content rule plus the
   section-level `Edit` grammar both need writing down there or they will erode.
5. **The `Add to this plan` chip list is enumerated closed** by the 2026-09-05 note as
   `Prep task`, `List`, `Photo`. This mock adds type chips to it. That is §2.1's mechanism
   applied unchanged, but the enumeration is explicit and needs amending rather than assuming.
6. **Money has no formatter and the only existing one is banned.**
   `packages/shared/src/money/format.ts` does not exist. The product's single user-facing price
   string is `changeActivityKind.ts:256`, `(cents / 100).toFixed(2)` — the exact construct
   `expenses.md` §3.1 forbids. **This mock does not copy it.** Whether Event price seeds a real
   shared formatter, in both directions, is a founder call.
7. **The envelope cannot name the parent or the source list.** `ActivityDetail`
   (`types/activityDetail.ts:81-120`) carries `children[]` and `sourceLists[]` but no parent
   summary and no source-list title. Both navigation rows need an API addition. Precedent: the
   List side does not derive its label either — it renders a stored, server-written
   `sourceLabel` (`listRepository.ts:2222`).
8. **A details-only PATCH is not validated against the activity's type.**
   `checkDetailsMatchType` runs only when the patch also carries `type`
   (`schemas/activity.ts:620`), and an edit sheet sends `details` alone. Reading `merge`, a
   mismatched `details.kind` looks storable — and `activitySchema.parse` on read would then
   reject the row. There is no test for a details-only patch at all; every `details:` case in
   `patchActivity.test.ts` sits inside the kind-change block. **This wants a server-side guard
   before any edit UI ships.**
9. **Season/episode ranges disagree.** `activities.md:404-405` says 0–99 / 0–999;
    `packages/shared/src/schemas/common.ts:121-122` allows 0–1000 / 0–10000. The editor imposes
    no ceiling, matching the schema rather than the doc.
10. **Recipe is documented as absent.** `plans-and-lists.md:543` says it "remains absent until
    [its] own product conditions and implementation are available", yet compose stores
    `recipeUrl` now.
11. **`Watchlist title` vs `Saved as`** for the diverged `mediaTitle`. "Watchlist" is doc
    vocabulary the user may not share — they named the list themselves.
12. **`fix/P3-49-sourced-list-backlinks`** is in flight for `listId`/`listItemId`. The
    `From <list>` row is drawn as intent, not as a claim on that work.
13. **Conflict and failure handling is not modelled.** Real saves need `If-Match`, the 409
    path, and a draft that survives a failed save the way the notes editor's does
    (`activities.md` §6.1). The mock's saves always succeed.

## Verification performed

Driven in a browser at 375 × 812 with the phone frame at both 390 pt and 320 pt, light and dark.
Every example rendered and read back through the accessibility tree, not only screenshotted.

- **No horizontal overflow at 320 pt** — `documentElement` and `.phone` both measured, and no
  descendant of `#app` exceeds its client width.
- A movie renders neither season nor episode; a season without an episode renders `S3` / `Season 3`.
- The `LINK` section is absent on the Meal (deduped against the recipe link) and present on the
  Event (distinct from the ticket link).
- `Private to you` and the description's privacy line appear on the shared Event and nowhere else.
- Long serif titles and a 60-character episode title wrap rather than clip.
- **Editing, end to end:** empty Meal → `Recipe` chip → set Lunch and a URL → Save; the header
  line became `Meal · Lunch · Just you`, `RECIPE` appeared, and the chip left the row.
- **Money round trip:** `42.00` prefilled, typed `37.5`, stored `3750`, redisplayed `37.50 GBP`.
  Party size `1` renders `1 person`, not `1 people`.
- **Movie/Show toggle** removes and restores the season, episode and episode-title fields.
- **Cancel discards** the draft and leaves the saved value untouched; `Escape` closes the sheet.
- No console errors.

**Not verified, and it matters:** this is a browser mock. Native keyboard avoidance, Dynamic
Type, VoiceOver grouping of the fact blocks and the sheet's focus trap, real sheet gestures, and
loading/error/conflict integration are device work. Save failure, `If-Match` conflicts and dirty-
cancel confirmation are **not** modelled — see conflict 13. Loading, error, completed and skipped
states are not modelled either; v1 covers those and the header above the type sections is
unchanged from it.

**No static screenshots were captured this round.** The mock is interactive and cheap to serve,
and a hosted copy is linked from the pilot README; PNGs would go stale against the live file.

## Simulation boundaries

Everything is in browser memory and resets on reload. No APIs, storage, uploads, notifications
or production writes. The type editors and `Show more` work; sheets for date, repeat and reminder,
menus, checkboxes, `Prep task` / `List` / `Photo` and every navigation row are inert. Fixtures are
hand-written to the shapes in `packages/shared/src/types/activity.ts`; they are not schema-
validated, so treat them as illustrative of shape, not proof of validity.
