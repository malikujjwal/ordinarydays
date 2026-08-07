# Interaction contract

**Status:** canonical for gestures, states, undo and accessibility across every screen. A
component that deviates from this document is wrong even if it looks better. One codebase
serves iOS and web (Expo + React Native Web), so every rule here has a stated web
equivalent in §7.

---

## 1. The universal rules

Six rules. Everything in §3 is a consequence of them.

| # | Rule | Consequence |
| --- | --- | --- |
| U1 | **Tap the body of a row → open its detail.** | A row tap never mutates. Not a toggle, not a completion, not a reschedule. See [`overview.md`](overview.md#43-tap-a-row-opens-detail-never-mutates). |
| U2 | **Tap a checkbox → complete.** | Only `task` rows and checkable list items have one. The checkbox is a separate accessibility element with its own 44×44 hit target. |
| U3 | **Swipe → contextual actions.** | Right reveals the row's single positive action; left reveals up to three secondary actions. Full-swipe commits only the *first* action on that side, and never a destructive one. |
| U4 | **Tap a date or time → reschedule.** | Anywhere it is rendered: the row's time column, the plan detail's when/where block, a list item's state line. It opens the reschedule sheet; it never edits in place. |
| U5 | **Share → add people or copy a link.** | One affordance, one sheet, on every activity, regardless of type. |
| U6 | **`⋯` → everything else.** | Edit, change type, duplicate, mute, cancel, delete. Nothing destructive lives anywhere but here (and behind a swipe-revealed button that still requires a tap). |

Two supporting rules:

- **Long-press is reorder or preview, never a hidden action.** In a reorderable list it
  starts a drag. Elsewhere it opens a preview (iOS context menu) whose items duplicate the
  `⋯` menu. No action exists only behind a long-press.
- **Nothing important is behind a gesture alone.** Every swipe action is also reachable from
  the detail screen or the `⋯` menu. Gestures are accelerators.

---

## 2. Controls and their targets

| Control | Hit target | Notes |
| --- | --- | --- |
| Row body | Full row width minus the checkbox and any trailing control, min height 44 pt | One `Pressable` |
| Checkbox | 44 × 44 pt, visually 24 × 24 | Separate element |
| Time column | 44 pt tall, ≥ 56 pt wide | Separate element; opens reschedule |
| Trailing prompt chip (`How did it go?`) | 44 pt tall | Separate element |
| Avatar stack | Not interactive on a row | Interactive on plan detail |
| `⋯` | 44 × 44 pt | |
| Swipe action button | Full row height, ≥ 72 pt wide | |
| FAB | 56 × 56 pt | |

Adjacent hit targets are separated by at least 8 pt of non-interactive space.

---

## 3. Gesture table

Rows appear in these forms across the product. `—` means the gesture does nothing and the
row does not move under the finger.

### 3.1 Today and agenda rows

| Row type | Tap body | Tap checkbox | Swipe right (partial) | Swipe right (full) | Swipe left (partial) | Swipe left (full) | Long press |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task, timed | Open task detail | Complete | `Complete` | Complete | `Snooze` · `Reschedule` · `Delete` | Snooze sheet | Preview + `⋯` menu |
| Task, untimed (Anytime) | Open task detail | Complete | `Complete` | Complete | `Schedule` · `Delete` | Schedule sheet | Preview + `⋯` menu |
| Task, overdue (rolled forward) | Open task detail | Complete | `Complete` | Complete | `Do today` · `Reschedule` · `Delete` | Sets `schedule.date` to today | Preview + `⋯` menu |
| Task, recurring occurrence | Open task detail (series) | Complete **this occurrence** | `Complete` | Complete this occurrence | `Snooze` · `Skip` · `Edit series` | Snooze sheet | Preview + `⋯` menu |
| Meal | Open plan detail | — (no checkbox) | `Had it` | Had it | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Watch | Open plan detail | — | `Watched` | Watched | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Event | Open plan detail | — | `Attended` | Attended | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Outing | Open plan detail | — | `Done` | Done | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Custom | Open plan detail | — | `Done` | Done | `Reschedule` · `Delete` | Reschedule sheet | Preview + `⋯` menu |
| Prep task (on Today) | Open task detail | Complete | `Complete` | Complete | `Open plan` · `Reschedule` · `Delete` | Opens the parent plan | Preview + `⋯` menu |
| Any row with a pending RSVP | Open plan detail | — | `Going` | Sets RSVP going | `Maybe` · `Decline` | Sets RSVP maybe | Preview + `⋯` menu |
| UP NEXT card | Open detail | Complete (tasks only) | Same as the underlying row | Same | Same | Same | Same |
| Completed row (EARLIER TODAY) | Open detail | Un-complete | `Undo` | Un-complete | `Delete` | — | Preview + `⋯` menu |

Additional taps available on these rows:

| Element | Behaviour |
| --- | --- |
| Time column | Reschedule sheet (U4) |
| `How did it go?` chip | Resolution sheet ([`today-and-tasks.md`](today-and-tasks.md#82-resolution-prompts)) |
| Overdue date chip | Reschedule sheet, pre-set to today |
| `+n more overdue` | Expands in place |

### 3.2 List rows

| Row type | Tap body | Tap checkbox | Swipe right | Swipe right (full) | Swipe left | Swipe left (full) | Long press |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List (on the Lists index) | Open the list | — | — | — | `Archive` · `Delete` | — | Reorder lists |
| Checkable item (groceries, shopping, packing, general) | Open item sheet | Toggle `checked` | `Check` / `Uncheck` | Toggle | `Schedule` · `Move` · `Delete` | Schedule sheet | Drag to reorder |
| Non-checkable item (meals, restaurants, places) | Open item sheet | — | `Schedule` | Schedule sheet | `Move` · `Delete` | Move sheet | Drag to reorder |
| Watchlist item | Open item sheet | — | `Schedule` | Schedule sheet | `Mark watched` · `Move` · `Delete` | Mark-watched confirm | Drag to reorder |
| Item with a state line (`Planned Saturday · 7 PM`) | Title area → item sheet; **state line → the linked Activity** | As above | As above | As above | As above | As above | Drag to reorder |

### 3.3 Plan detail rows

| Row type | Tap | Swipe | Long press |
| --- | --- | --- | --- |
| When/where block | Reschedule sheet | — | — |
| Address line within it | Open the platform maps app | — | Copy address |
| Participant row | Open that Person's view | Owner only: `Resend invite` · `Copy link` · `Remove` | — |
| Prep task row | Open task detail (checkbox completes) | `Complete` / `Reschedule` · `Delete` | — |
| Related list row | Open the list | `Detach` (clears `sourceActivityId`) | — |
| Expense row | Open expense detail | Author or owner: `Edit` · `Delete` | — |
| Per-person owes row | Balance drill-down filtered to this plan | — | — |
| Attachment thumbnail | Open viewer | — | `Set as cover` · `Delete` |
| Update entry | — (not interactive) | Author only: `Delete` | Copy text |
| Completion button | Complete with the type's verb | — | — |

### 3.4 Other rows

| Row type | Tap | Swipe | Long press |
| --- | --- | --- | --- |
| Person row (People page) | Open Person view | `Plan something` · `Delete` | — |
| Balance line (anywhere) | Balance drill-down. **Always interactive** ([`expenses.md`](expenses.md#53-the-mandatory-drill-down)) | — | — |
| Expense line in a drill-down | Open the plan at its expense section | — | — |
| Settlement history row | Expand covered expenses | `Undo settlement` | — |
| Notification row | Navigate to the subject | `Mark read` · `Delete` | — |
| Invitation notification row | Navigate; inline `Going · Maybe · Decline` | Same | — |
| Search result | Open the subject | — | — |

---

## 4. Undo policy

> **Decision — the undo model.** Reversible actions are performed immediately with a
> **6-second** undo toast and no confirmation dialog. Irreversible actions are performed
> only after a confirmation dialog and have **no** undo. Bulk reversible actions get a
> **10-second** window because there is more to notice.

### 4.1 The table

| Action | Confirmation | Undo | Window | Mechanism |
| --- | --- | --- | --- | --- |
| Complete a task or occurrence | No | Yes | 6 s | `POST .../uncomplete` |
| Complete a plan (any type, any outcome) | No | Yes | 6 s | `POST .../uncomplete` |
| Skip an occurrence | No | Yes | 6 s | Delete the `Occurrence` |
| Snooze | No | Yes | 6 s | Delete the snooze fields |
| Check / uncheck a list item | No | Yes | 6 s | `PATCH` back |
| Reschedule | No | Yes | 6 s | `POST .../schedule` with the previous values |
| RSVP change | No | Yes | 6 s | `PATCH` back |
| Clear checked (bulk) | No | Yes | **10 s** | Re-create the deleted items with their previous ranks |
| Uncheck all (bulk) | No | Yes | **10 s** | `PATCH` back |
| Archive a list | No | Yes | 6 s | `PATCH archived: false` |
| Remove a participant | **Yes** | No | — | Revokes their token; re-adding sends a new invitation |
| Delete an activity | **Yes** | No | — | Cascades per [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items) |
| Delete a list | **Yes** | No | — | |
| Delete a list item | No | Yes | 6 s | Re-create with the previous rank |
| Delete an expense | **Yes** | No | — | Balances recompute |
| Delete a settlement (`Undo settlement`) | **Yes** | No | — | Un-settles the covered expenses |
| Cancel a plan | **Yes** | Yes, from the plan | — | `PATCH status` back; participants are notified again |
| Delete a person | **Yes** | No | — | Blocked with `409` while they are on a live plan |
| Change activity type | **Yes**, when fields would be dropped | No | — | [`activities.md`](activities.md#63-changing-an-activitys-type) |
| Discard an unsaved draft | **Yes** | No | — | |
| Delete the account | **Yes**, typed confirmation | 30 days, by signing back in | 30 d | Soft delete, then purge |

### 4.2 Toast rules

- One toast at a time. A new action replaces the visible toast and **commits** the previous
  one immediately.
- The toast sits above the tab bar, is swipe-dismissible, and dismissing it commits.
- Undo restores the exact prior state, including sort position and scroll offset.
- The optimistic update is applied instantly; the network call fires immediately, not at the
  end of the window. Undo is a compensating call, not a delayed commit. This keeps the app
  correct when it is closed mid-window.
- If the original call failed, the row reverts and the toast becomes an error toast with
  `Retry` instead of `Undo`.
- Toasts announce themselves to screen readers with `accessibilityLiveRegion="polite"` and
  their `Undo` button is focusable.

---

## 5. Loading, empty, error and offline states

One contract, applied identically everywhere.

### 5.1 Loading

| Situation | Presentation |
| --- | --- |
| First load of a screen with no cached data | Skeleton rows matching the real layout's shape and count (5 rows), with no spinner and no text. Minimum display 200 ms to avoid a flash. |
| Refresh of a screen with cached data | Cached content stays fully visible and interactive. A 2 pt progress bar under the header. **Never** a blocking spinner over existing content. |
| Pull to refresh | Platform refresh control. Web: a `Refresh` button in the header plus `R`. |
| A mutation in flight | The affected row is optimistically updated. No spinner on the row. A spinner appears only on a modal's primary button, and only after 400 ms. |
| Pagination | A single skeleton row at the list's foot; auto-fetch at 80 % scroll depth. |
| Anything over 10 s | Becomes an error state (§5.3) with `Retry`. |

### 5.2 Empty

Every empty state is: a one-line heading stating the fact, one line of guidance, and at
most one action. No illustrations, no congratulation, no exclamation marks.

| Screen | Heading | Guidance | Action |
| --- | --- | --- | --- |
| Today, nothing at all | `Nothing planned today` | `Add something you want to do, or check your Lists.` | `Add` |
| Plans, no future items | `No upcoming plans` | `Anything with a date shows up here.` | `Add` |
| Lists index | `No lists yet` | `Lists hold things you want to remember without picking a date.` | `New list` |
| A list | `Nothing here yet` | — | The inline add row |
| Search, no results | `No matches for "zahav"` | — | — |
| People | `No one yet` | `People appear here when you share a plan with them.` | — |
| Person, no shared plans | `Nothing together yet` | — | `Plan something with Alice` |
| Balances | `Nothing outstanding` | — | — |
| Notification inbox | `Nothing new.` | — | — |
| Expenses on a plan | — | — | `Add expense` alone |

Section-level empty states on Today are specified in
[`today-and-tasks.md`](today-and-tasks.md#25-empty-states).

### 5.3 Error

| Class | Presentation | Recovery |
| --- | --- | --- |
| Screen-level load failure (no cached data) | Full-screen: `Couldn't load this.` plus the request id in small text | `Try again` |
| Screen-level refresh failure (cached data present) | Cached content stays. A dismissible banner: `Couldn't refresh.` | `Try again` |
| Mutation failure | The optimistic change reverts; error toast naming what failed: `Couldn't complete "Gym."` | `Retry` |
| `409 conflict` on a shared plan | `This plan changed while you were editing.` Client refetches; non-overlapping edits are re-applied, overlapping ones are dropped and named. | `Review` |
| `403 forbidden` | `Only the person who made this plan can change that.` | — |
| `404 not_found` | `This isn't here any more.` Navigate back. | — |
| `422 participant_limit_exceeded` | Inline in the picker: `You can add up to 50 people to a plan.` | — |
| `429 rate_limited` | `Too many requests. Try again in <Retry-After>.` | Auto-retry once after the header's delay for `GET`s only |
| `426 upgrade_required` | Blocking screen: `Update Ordinary Days to keep going.` | `Update` → `updateUrl` |
| `501 not_implemented` (capture) | Silent on the text path; the manual-entry message on image/link paths | See [`ai-capture.md`](ai-capture.md#61-the-failure-matrix) |
| `500 internal` | `Something went wrong.` plus the request id | `Try again` |

Error copy never shows a stack trace, an error code, or the word "error" in the heading.
The `requestId` is always shown in small text and is long-press-copyable, so a support
message can name it.

### 5.4 Offline

| Aspect | Behaviour |
| --- | --- |
| Detection | Connectivity state plus request failure. A single connectivity change does not clear the queue. |
| Indicator | A persistent 20 pt bar under the header: `Offline — changes will sync.` No modal, no blocking. |
| Reads | The last agenda, list and plan responses are cached and served. Today works fully offline for the current day. |
| Writes | Queued in order, per entity, with their `Idempotency-Key` preserved so a retry cannot duplicate. Applied optimistically. |
| Queued row indicator | A small `Pending` dot in the row's trailing slot. Not an error colour. |
| Conflicts on reconnect | Server state wins for fields the user did not touch. A queued write that returns `409` surfaces one banner: `<n> changes couldn't be applied.` with a list. |
| Capture | Not attempted offline ([`ai-capture.md`](ai-capture.md#61-the-failure-matrix)). |
| Uploads | Queued; the attachment shows a placeholder until the upload succeeds. |
| Queue limits | 200 pending mutations; beyond that, new writes are refused with `You're offline and there's a lot waiting to sync.` |
| Undo while offline | Works — it is a compensating local operation and a queued call. |

---

## 6. Accessibility

Requirements, not aspirations. Each is checkable.

### 6.1 Targets and layout

| Requirement | Value |
| --- | --- |
| Minimum hit target | 44 × 44 pt on iOS, 44 × 44 CSS px on web, for every interactive element without exception |
| Spacing between adjacent targets | ≥ 8 pt |
| Text truncation | Titles wrap to 2 lines before truncating; they never truncate at 1 line at default type size |
| Layout at 320 pt width | No horizontal scrolling, no clipped controls |

### 6.2 VoiceOver / screen reader labels

Every row is **one** accessibility element per interactive control, in the reading order
given. `accessibilityRole` is stated; `accessibilityHint` is used only where the action is
not obvious from the label.

| Row type | Elements, in order | Label | Role | Actions |
| --- | --- | --- | --- | --- |
| Task, timed | 1. Checkbox<br>2. Row body<br>3. Time | 1. `Gym, not completed`<br>2. `Gym, 6:00 PM, repeats on weekdays`<br>3. `6:00 PM, change time` | `checkbox`, `button`, `button` | Custom actions on the body: `Complete`, `Snooze`, `Reschedule`, `Delete` |
| Task, untimed | 1. Checkbox<br>2. Row body | 1. `Submit insurance form, not completed`<br>2. `Submit insurance form, today, no time` | `checkbox`, `button` | `Complete`, `Schedule`, `Delete` |
| Task, overdue | 1. Checkbox<br>2. Row body<br>3. Date chip | 1. `Call apartment office, not completed`<br>2. `Call apartment office, was due Tuesday 4 August`<br>3. `Was due Tuesday, reschedule` | `checkbox`, `button`, `button` | `Complete`, `Do today`, `Reschedule`, `Delete` |
| Meal | 1. Row body<br>2. Time | 1. `Chicken tacos, meal, dinner, 7:30 PM`<br>2. `7:30 PM, change time` | `button`, `button` | `Had it`, `Reschedule`, `Delete` |
| Watch | 1. Row body<br>2. Time | 1. `Severance, watch, season 2 episode 5, 8:00 PM, with Alice` | `button`, `button` | `Watched`, `Reschedule`, `Delete` |
| Event | 1. Row body<br>2. Time | 1. `Dentist appointment, event, 2:30 PM, at Dr Patel` | `button`, `button` | `Attended`, `Reschedule`, `Delete` |
| Outing | 1. Row body<br>2. Time | 1. `Zahav, outing, 7:00 PM, with Alice and 2 others` | `button`, `button` | `Done`, `Reschedule`, `Delete` |
| Custom | 1. Row body<br>2. Time | 1. `Practice guitar, 9:00 PM` | `button`, `button` | `Done`, `Reschedule`, `Delete` |
| Passed, unresolved | 1. Row body<br>2. Prompt chip | 2. `How did it go? Choose an outcome for Dentist appointment` | `button`, `button` | `Attended`, `Didn't go` |
| Completed row | 1. Row body | `Overnight oats, had it, 8:00 AM` | `button` | `Undo` |
| Pending RSVP | 1. Row body<br>2–4. RSVP buttons | 1. `Dinner at Zahav, Saturday 7:00 PM, from Alice, awaiting your reply` | `button` ×4 | — |
| UP NEXT card | 1. Card body | `Up next. Pick up groceries, in 2 hours, 5:30 PM` | `button` | Same as the row |
| Checkable list item | 1. Checkbox<br>2. Row body | 1. `Chicken, not checked`<br>2. `Chicken, from Sunday dinner` | `checkbox`, `button` | `Schedule`, `Move`, `Delete` |
| Non-checkable list item | 1. Row body<br>2. State line | 1. `Zahav`<br>2. `Planned Saturday 7:00 PM, open plan` | `button`, `button` | `Schedule`, `Move`, `Delete` |
| Watchlist item | 1. Row body | `Severance, watching, season 2 episode 4, next session Friday 8:00 PM` | `button` | `Schedule`, `Mark watched`, `Delete` |
| Person row | 1. Row body<br>2. Balance chip | 1. `Alice, 3 upcoming together`<br>2. `Alice owes you 42 dollars 50, see the expenses` | `button`, `button` | `Plan something`, `Delete` |
| Balance line | 1. Line | `Alice owes you 42 dollars 50. See the expenses behind this.` | `button` | — |
| Expense row | 1. Row body | `Hotel, 340 dollars, you paid, split 3 ways` | `button` | `Edit`, `Delete` |
| Participant row | 1. Row body | `Alice, going` / `Chloe, invited, guest` | `button` | `Resend invite`, `Copy link`, `Remove` |
| Notification row | 1. Row body | `Alice invited you. Dinner at Zahav, Saturday 9 August 7:00 PM. Unread.` | `button` | `Mark read`, `Delete` |
| Section header | 1. Header | `Up next`, `Schedule`, `Anytime`, `Earlier today` | `header` | — |

Rules:

- Non-interactive type markers (the diamond on non-task rows) are
  `accessibilityElementsHidden` and contribute their meaning to the row label instead
  (`, meal,`).
- Every swipe action is exposed as an `accessibilityAction` on the row so it is reachable
  without swiping.
- State is spoken, not implied by colour: `not completed`, `checked`, `unread`, `pending`.
- Counts are spoken in full: `with Alice and 2 others`, never `+2`.
- Money is spoken as words per the platform's currency formatter, never as digits with a
  symbol.

### 6.3 Dynamic type

- Every text style uses the platform's scalable type. `allowFontScaling` is never `false`.
- The layout is verified at the largest non-accessibility size **and** at the largest
  accessibility size (`AX5`).
- Above `xxxLarge`, row layouts reflow from horizontal to vertical: the time moves above the
  title, avatars move below, badges wrap.
- Fixed-height rows do not exist. Every row is content-sized with a 44 pt minimum.
- Icons paired with text scale with it. Icon-only controls have a fixed 44 pt target and do
  not scale.

### 6.4 Contrast and colour

| Requirement | Value |
| --- | --- |
| Body and label text | ≥ 4.5:1 against its background |
| Large text (≥ 24 pt, or ≥ 19 pt bold) | ≥ 3:1 |
| Interactive control boundaries and focus rings | ≥ 3:1 |
| De-emphasised text (subtitles, overdue chips, completed rows) | ≥ 4.5:1 — de-emphasis is achieved with weight and size, not by dropping contrast below the threshold |
| Colour as the only carrier of meaning | **Never.** Completion also uses a checkmark and struck text. Pending RSVP also uses the word `Awaiting reply`. Overdue also uses the date chip's text. Balance direction is always words. |
| Dark mode | Full support, contrast verified independently |
| Increase Contrast setting | Honoured: borders become opaque, de-emphasised text moves to full contrast |

### 6.5 Motion

| Setting | Behaviour |
| --- | --- |
| Reduce Motion on | Screen transitions become cross-fades. Row insert/remove animations are removed; rows appear and disappear immediately. The toast appears without a slide. Swipe actions still track the finger (that is direct manipulation, not decorative motion) but do not spring. |
| Reduce Motion off | Standard platform transitions. No animation exceeds 300 ms. |
| Parallax, auto-playing motion, looping animation | Do not exist anywhere in the product. |
| Haptics | Light impact on completion and on swipe-action commit only. Respects the system haptics setting. Never used for errors alone — an error is always also visible and announced. |

---

## 7. Web equivalents

The web build is the same codebase. These rules translate touch gestures rather than
replacing them; touch gestures continue to work on touch-capable web devices.

### 7.1 Hover and pointer

| Touch gesture | Web equivalent |
| --- | --- |
| Swipe right (positive action) | A trailing action button appears on row hover, at the row's right edge: the same single positive action, labelled with its verb |
| Swipe left (secondary actions) | A `⋯` button appears on row hover, opening the same menu the long-press preview shows |
| Long press to reorder | Drag handle appears on hover in reorderable lists; drag with the pointer |
| Long press for preview | No equivalent; the `⋯` menu carries every item |
| Pull to refresh | `Refresh` button in the header, plus `R` |
| Tap and hold to copy | Right-click context menu (native) |

Hover-revealed controls are always **also** reachable by keyboard (§7.2) and are never the
only path to an action.

### 7.2 Keyboard shortcuts

Global, active when focus is not in a text field:

| Key | Action |
| --- | --- |
| `N` | Open Add |
| `T` / `P` / `L` | Today / Plans / Lists |
| `/` | Focus search |
| `R` | Refresh the current screen |
| `?` | Show the shortcut sheet |
| `G` then `I` | Notification inbox |
| `G` then `E` | People |

Within a list:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus between rows |
| `Home` / `End` | First / last row |
| `Return` | Open the focused row's detail |
| `Space` | Toggle the focused row's checkbox, if it has one |
| `E` | Complete the focused row with its type's verb |
| `S` | Snooze (tasks) or Schedule (undated, list items) |
| `D` | Reschedule |
| `Backspace` / `Delete` | Delete, with the standard confirmation |
| `Cmd/Ctrl + Z` | Undo, while the undo toast is visible |

Within forms and sheets:

| Key | Action |
| --- | --- |
| `Return` | Submit, when a single-line field is focused and the form is valid |
| `Cmd/Ctrl + Return` | Submit, from anywhere in the form |
| `Esc` | Cancel, with the discard prompt if dirty |
| `Tab` / `Shift + Tab` | Move through fields in visual order |
| `Alt + 1`–`6` | Pick a type chip on the Add screen |

The shortcut sheet (`?`) lists every shortcut and is the discovery mechanism. Shortcuts are
never the only way to do anything.

### 7.3 Focus order and management

| Rule | Detail |
| --- | --- |
| Order | DOM order equals visual order equals reading order. No positive `tabIndex` anywhere. |
| Skip link | `Skip to content` as the first focusable element on every page. |
| Row composition | A row is a single tab stop; its checkbox, time and trailing chip are reachable with `←`/`→` inside the row (a composite widget), so `Tab` moves between rows and not within them. |
| Modals and sheets | Focus moves to the sheet's first control on open, is trapped inside while open, and returns to the triggering element on close. |
| Route changes | Focus moves to the new screen's `<h1>`, which is announced. |
| Focus ring | Always visible, ≥ 2 px, ≥ 3:1 contrast, never removed. `:focus-visible` is used so pointer users do not see it on click. |
| Toasts | Not focus-stealing. The `Undo` button is inserted into the tab order immediately after the currently focused element for the duration of the window. |
| Dynamic content | Live regions: `polite` for toasts and section updates, `assertive` only for errors that block the current action. |
| Landmarks | `banner`, `navigation`, `main`, `contentinfo` on every page. Today's sections are `region`s labelled by their headings. |

### 7.4 What web does not have in v1

Stated so nobody builds it by accident:

- Push notifications, service worker, browser permission prompt — see
  [`notifications.md`](notifications.md#62-web).
- Camera capture. `Photos` on web is a file picker only.
- iOS share-sheet ingestion.
- Offline write queueing beyond the session — the web build keeps the queue in memory and
  warns on unload if it is non-empty; it does not persist it to IndexedDB.
