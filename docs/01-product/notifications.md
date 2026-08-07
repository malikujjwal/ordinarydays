# Notifications

**Status:** canonical for notification behaviour and copy. Preferences and the inbox are
served by
[`../02-architecture/api-contract.md#212-notifications`](../02-architecture/api-contract.md#212-notifications).
Delivery is Expo Push Notifications triggered from Lambda, with scheduled reminders
dispatched by EventBridge Scheduler → a reminder Lambda (brief §8).

---

## 1. Principles

1. **A notification is a service, not a growth tactic.** Every notification in the catalogue
   (§7) exists because the user would want to be interrupted. There are no re-engagement
   pushes, no streaks, no "you haven't opened the app", no digests of things the user did
   not ask for.
2. **Reminders are per activity.** The category toggle is the floor; the activity's own
   reminder setting is what actually schedules a push.
3. **The app never nags about cleanup.** No notification asks the user to resolve a passed
   plan, tick an overdue task, or settle a balance beyond the one opt-in reminder in §7.
   See [`today-and-tasks.md`](today-and-tasks.md#83-never-force-cleanup).
4. **Nothing is a surprise.** Every push maps to something the user created, was invited
   to, or explicitly enabled.

---

## 2. Categories and defaults

Six categories. `GET`/`PATCH /v1/me/notification-preferences` toggles each independently.

| Category | Key | Default | Covers |
| --- | --- | --- | --- |
| Reminders | `reminders` | **On** | Per-activity reminders for tasks, plans and recurring occurrences |
| Invitations | `invitations` | **On** | Someone invited you to a plan |
| RSVP changes | `rsvps` | **On** | Someone responded to a plan you own |
| Plan changes | `plan_changes` | **On** | A shared plan you are on was rescheduled, moved, renamed or cancelled |
| Shared plan activity | `plan_activity` | **Off** | Updates posted to a plan's feed, prep tasks completed by others |
| Expenses | `expenses` | **On** | An expense was added or edited on a plan you are on |
| Unsettled reminders | `unsettled` | **Off** | A monthly nudge about outstanding balances |

> **Decision:** `plan_activity` and `unsettled` default **off**. Feed chatter and money
> nudges are the two categories most likely to make a person mute the whole app. Everything
> else defaults on because it is either something the user scheduled themselves or an
> interpersonal obligation.

Turning a category off suppresses push **and** email for that category. It does **not**
suppress the in-app inbox entry (§5) — the record still exists; only the interruption stops.

### 2.1 Per-activity reminder control

Independent of the category toggle:

| Level | Control | Effect |
| --- | --- | --- |
| Profile default | Settings → `Default reminder`, writing `me.defaultReminderOffset` | The offset pre-selected on new timed activities. Ships as `-15` (15 minutes before). |
| Per activity | The `Reminder` field on the creation form and detail screen | Writes `activity.reminders[]`. Up to **5** per activity. |
| Per occurrence | Not supported | A recurring series has one reminder set; individual occurrences inherit it. Snoozing an occurrence moves that occurrence's reminder with it (§3.4). |
| Mute one plan | Plan detail → `⋯` → `Mute this plan` | Suppresses every push for that activity — reminders, changes, expenses, feed — without changing anyone else's. Stored per user per activity. |

Reminder offsets offered in the picker:

`At the time` (`0`), `5 minutes before` (`-5`), `15 minutes before` (`-15`),
`30 minutes before` (`-30`), `1 hour before` (`-60`), `2 hours before` (`-120`),
`1 day before` (`-1440`), `2 days before` (`-2880`), `Custom…`.

`Reminder.channel` is `'push'` in v1. Email and SMS reminders are out of scope
([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)).

---

## 3. Reminder timing

### 3.1 The rule

A reminder for an activity fires at:

```
scheduledAtUtc + offsetMinutes
```

where `scheduledAtUtc` is derived from `schedule.date` + `schedule.time` in
`schedule.timezone`. The reminder Lambda works only in UTC instants; the agenda works in
wall-clock. Both are computed from the same three stored fields, never from each other.

Scheduling mechanics:

- On every write that changes `schedule`, `recurrence` or `reminders`, the API upserts an
  EventBridge Scheduler one-time schedule per upcoming reminder, keyed
  `rem_<activityId>_<reminderId>_<occurrenceDate>`.
- Recurring series schedule only the **next two** occurrences' reminders at a time. The
  reminder Lambda schedules the following one after it fires. This keeps the schedule count
  bounded regardless of how long a series runs.
- Deleting, cancelling, completing or skipping cancels the corresponding schedule.
- A reminder whose fire time is already in the past at write time is dropped silently.

### 3.2 All-day and untimed items

An activity with a `date` and no `time` has no meaningful instant, so:

> **Decision:** untimed items fire their reminder at the user's **all-day reminder hour**,
> a profile setting defaulting to **09:00 local** on the item's date. Offsets on an untimed
> item are interpreted in whole days from that hour: `1 day before` = 09:00 the previous
> day. Sub-day offsets (`-5`, `-15`, `-30`, `-60`, `-120`) are not offered on an untimed
> item; the picker shows `On the day`, `1 day before`, `2 days before`, `Custom…`.

If the all-day hour falls inside quiet hours, the rule in §4 applies.

### 3.3 Recurring occurrences

- Each occurrence gets its own reminder, computed from that occurrence's effective local
  time.
- A **skipped** occurrence fires no reminder.
- A **completed** occurrence fires no reminder; if it was completed after the reminder was
  scheduled but before it fired, the schedule is cancelled.
- The reminder for occurrence *n+1* is scheduled when occurrence *n*'s reminder fires, so a
  daily series never has more than two pending schedules.
- Changing the series time re-computes the pending schedules for the next two occurrences
  and leaves any occurrence overrides intact.

### 3.4 Snooze

Snoozing an occurrence cancels its pending reminder and schedules a new one at
`snoozedUntil + offsetMinutes`, clamped so it never fires in the past. Snooze does **not**
touch the series, the reminder definition, or any other occurrence — see
[`today-and-tasks.md`](today-and-tasks.md#65-snooze-does-not-shift-the-series).

If the offset would place the new reminder before "now" (snoozing to 15 minutes from now
with a `-30` offset), the reminder is dropped for that occurrence rather than fired
immediately.

### 3.5 Daylight saving

Reminders are re-derived from `date` + `time` + `timezone` at scheduling time, not carried
forward as fixed instants. A 6:00 PM daily task across a DST boundary produces a reminder
at 6:00 PM local on both sides, an hour apart in UTC. The pending-two-occurrences window
means at most one reminder is ever scheduled across a transition, and it is re-derived when
its predecessor fires.

### 3.6 Delivery guarantees

- **At-most-once, best effort.** Expo Push is not a guaranteed channel. A dropped
  notification is not retried more than the transport's own retry.
- A reminder more than **30 minutes** late at delivery time is dropped rather than shown.
  A 6 PM reminder arriving at 9 PM is worse than nothing.
- If the user has no registered device, the reminder is skipped. The in-app inbox entry is
  still written for interpersonal categories (§5); pure reminders do **not** create inbox
  entries, because Today already shows them.
- Multiple reminders for the same activity fire independently and are not coalesced.
- If a user has several devices, all receive it. Expo handles per-token delivery; the
  Lambda fans out over `USER#<u>` / `DEVICE#` rows (access pattern 15).

---

## 4. Quiet hours

| Setting | Default |
| --- | --- |
| Quiet hours enabled | **On** |
| Quiet hours window | **22:00 – 07:00** local |

Behaviour inside the window:

| Notification kind | Behaviour |
| --- | --- |
| Reminder for an activity **inside** the window | **Delivered.** A 6 AM flight reminder is exactly what quiet hours must not suppress. |
| Reminder for an activity **outside** the window (an early reminder that happens to land inside it) | Held and delivered at the window's end. |
| Invitation | Held until the window's end. |
| RSVP change, plan change, plan activity, expense | Held until the window's end. |
| Plan **cancelled** for a plan starting within the next 12 hours | **Delivered.** A cancellation the user would otherwise act on is urgent. |
| Unsettled reminder | Held. |

Held notifications are coalesced at the window's end: more than three held items become one
push (§7, `held_digest`). Their inbox entries are written at their original time regardless
of holding, so the inbox always reflects when things actually happened.

> **Decision:** the "delivered inside the window" exceptions are limited to activity
> reminders whose activity is itself inside the window, and to cancellations of imminent
> plans. Everything else waits. A user who wants total silence turns the relevant categories
> off.

---

## 5. The in-app inbox

`GET /v1/notifications?cursor=`. Reached from Profile → `Notifications`, with an unread dot
on the Profile entry point. **No numeric badge anywhere** — a count of pending social
obligations is exactly the pressure this product avoids.

| Property | Rule |
| --- | --- |
| Contents | Invitations, RSVP changes, plan changes, plan activity, expense additions, guest RSVPs, settlement records. |
| **Not** in the inbox | Activity reminders. Today already shows what is due; a parallel list of "we told you about this" is noise. |
| Order | Newest first, cursor-paginated. |
| Grouping | By day, with `Today`, `Yesterday`, then dates. |
| Read state | An entry is read when tapped, or via `POST /v1/notifications/read-all`. `POST /v1/notifications/:id/read` for a single one. |
| Tap behaviour | Navigates to the thing it is about — the plan, the person, the expense. Never opens a nested detail of the notification itself. |
| Retention | 90 days, then removed by the maintenance job. |
| Empty state | `Nothing new.` |
| Relationship to push | Independent. An inbox entry is written whether or not a push was sent, delivered, or suppressed by a category toggle or quiet hours. |
| Actionable entries | An invitation entry carries inline `Going · Maybe · Decline`. Acting from the inbox is equivalent to acting on the plan. |

---

## 6. Platform behaviour

### 6.1 iOS permission timing

The system permission prompt is **never** requested at first launch.

The sequence:

1. First launch: no prompt. The user reaches a populated Today with nothing asked of them.
2. The prompt is requested at the **first moment a notification would be useful**,
   whichever comes first:
   - the user sets a reminder on an activity, or
   - the user adds a participant to a plan, or
   - the user opens an invitation they received.
3. Before the system dialog, a one-time pre-prompt sheet explains what the app will send:

   ```
   Reminders and invitations

   Ordinary Days can remind you before something starts, and let you
   know when someone replies to a plan.

   It won't send anything else.

                        [ Not now ]   [ Turn on ]
   ```

4. `Turn on` triggers the system prompt. `Not now` dismisses, and the pre-prompt reappears
   at the next qualifying moment, at most **once every 14 days**.
5. If the system permission is denied, the app never re-prompts (iOS only allows the system
   dialog once). Settings shows `Notifications are off in iOS Settings` with a deep link,
   and reminder controls stay usable — they simply do not fire.

On grant, the client registers the Expo push token via `POST /v1/me/devices` and re-registers
on every cold start where the token has changed.

> **Decision:** the pre-prompt is required. Asking the system for permission cold, before
> the user has any reason to want it, is the single easiest way to permanently lose the
> channel.

### 6.2 Web

> **There is no push on web in v1.** No service worker, no Web Push, no browser permission
> prompt.

The web build:

- Renders the in-app inbox identically.
- Shows an in-page toast for events that arrive while the tab is open and focused, driven
  by the same 60 s poll that refreshes the agenda. No websocket in v1.
- Shows, in Settings, one line: `Push notifications are available in the iOS app.` No
  "coming soon", no email capture.
- Still respects category preferences for the toast surface, so a user who turned off
  `plan_activity` sees no toast for it.

Reminders are therefore an iOS capability in v1. This is stated in the product docs so
nobody spends a sprint on a service worker.

### 6.3 Email

SES sends only in these cases (brief §9):

| Email | To | When |
| --- | --- | --- |
| Guest invitation | A guest with an email address | On being added to a plan |
| Plan changed | Guests on that plan | The plan's date, time or location changed |
| Plan cancelled | Guests on that plan | The plan was cancelled |

Registered app users receive **no** email for anything covered by push. There is no
marketing send path, no digest, and no unsubscribe list beyond the per-plan opt-out at the
foot of each guest email, which revokes that guest's token.

---

## 7. Notification catalogue

Every notification the app can send. `Category` maps to §2. `Push` means it can produce a
push; `Inbox` means it writes an inbox entry.

| Key | Category | Trigger | Push | Inbox | Title | Body |
| --- | --- | --- | --- | --- | --- | --- |
| `reminder_timed` | `reminders` | `scheduledAtUtc + offsetMinutes` for a timed activity | Yes | No | `Gym` | `In 15 minutes · 6:00 PM` |
| `reminder_allday` | `reminders` | All-day reminder hour on an untimed activity's date | Yes | No | `Submit insurance form` | `Today` |
| `reminder_occurrence` | `reminders` | As `reminder_timed`, for one occurrence of a series | Yes | No | `Gym` | `In 15 minutes · 6:00 PM` |
| `invitation_received` | `invitations` | An app user is added to a plan | Yes | Yes | `Alice invited you` | `Dinner at Zahav · Sat 9 Aug, 7:00 PM` |
| `invitation_reminder` | `invitations` | 24 h before a plan the user has not RSVP'd to | Yes | No | `Dinner at Zahav is tomorrow` | `You haven't replied yet` |
| `rsvp_changed` | `rsvps` | A participant or guest sets or changes an RSVP | Yes | Yes | `Alice is going` | `Dinner at Zahav` |
| `rsvp_guest` | `rsvps` | A guest RSVPs from the public page | Yes | Yes | `Chloe is going` | `Food Festival · replied from your invite link` |
| `plan_changed` | `plan_changes` | Owner changes date, time or location on a shared plan | Yes | Yes | `Dinner at Zahav moved` | `Now Sat 9 Aug, 8:00 PM` |
| `plan_renamed` | `plan_changes` | Owner changes the title of a shared plan | No | Yes | `Plan renamed` | `Dinner at Zahav is now Dinner at Suraya` |
| `plan_cancelled` | `plan_changes` | Owner sets `status: 'cancelled'` on a shared plan | Yes | Yes | `Dinner at Zahav is cancelled` | `Alice cancelled it` |
| `plan_update_posted` | `plan_activity` | A participant posts an update | Yes | Yes | `Alice posted an update` | `Dinner at Zahav · "Running 10 late"` |
| `prep_task_completed` | `plan_activity` | Another participant completes a prep task | No | Yes | `Ben finished a prep task` | `New York Trip · Book hotel` |
| `participant_left` | `plan_activity` | A participant leaves a shared plan | No | Yes | `Ben left the plan` | `New York Trip` |
| `expense_added` | `expenses` | An expense is added to a plan the user is on | Yes | Yes | `Alice added an expense` | `New York Trip · Train $142.00 · your share $71.00` |
| `expense_changed` | `expenses` | An existing expense is edited or deleted | No | Yes | `An expense changed` | `New York Trip · Train is now $138.00` |
| `settlement_recorded` | `expenses` | A settlement involving the user is recorded | Yes | Yes | `Ujjwal marked $54.00 settled` | `3 expenses · you're settled up` |
| `unsettled_monthly` | `unsettled` | Monthly, on the 1st at the all-day hour, when any non-zero balance exists. Off by default. | Yes | No | `Two open balances` | `Alice owes you $42.50 · You owe Ben $18.00` |
| `held_digest` | n/a | More than 3 notifications were held through quiet hours | Yes | No | `5 updates while you were away` | `Tap to see them` |

Notes:

- `invitation_reminder` fires once and only when `rsvp === 'pending'`. It is the only
  notification that chases a user, and it chases an obligation to another person, not to
  the app.
- `unsettled_monthly` fires at most once per calendar month regardless of how many balances
  exist, and lists at most two, with `and 2 more` appended.
- `expense_added` includes the recipient's own share, computed per recipient, so the body
  differs per device.
- Reminders never write inbox entries (§5).

---

## 8. Copy guidelines

| Rule | Do | Don't |
| --- | --- | --- |
| Lead with the noun the user recognises | `Gym` / `In 15 minutes · 6:00 PM` | `Reminder: you have an upcoming activity` |
| State the fact, then the detail | `Alice is going` / `Dinner at Zahav` | `Great news! Alice just RSVP'd!` |
| Use the user's own words | The activity's title, verbatim, never rewritten or title-cased | `Your "gym" activity` |
| Times in the user's format and timezone | `6:00 PM`, `18:00` per locale | `2026-08-06T18:00:00Z` |
| No emoji, ever | | |
| No exclamation marks | | |
| No brand voice, no jokes, no encouragement | `Submit insurance form` / `Today` | `Let's crush it today!` |
| Never imply obligation the user did not create | `You haven't replied yet` | `Don't leave Alice hanging` |
| Never mention the app in the body | | `Open Ordinary Days to see more` |
| Truncation | Titles truncate at 40 characters, bodies at 110, both with an ellipsis at a word boundary | Mid-word cuts |
| Names | Display name exactly as stored, never a first-name derivation | `Al` for `Alice Chen` |
| Money | Formatted per §3.1 of [`expenses.md`](expenses.md#31-cents-only), with the currency symbol | `4250 cents` |
| Counts | Spelled out below ten in a title, numerals in a body | |
| Localisation | English only in v1. All copy lives in one strings module so this is a swap, not a rewrite. | Hard-coded strings in components |

Deep links: every push carries a `data.route` used by Expo Router to open the exact screen —
the plan, the person, the expense, or the inbox. A push that opens Today is a bug except for
`held_digest`, which opens the inbox.
