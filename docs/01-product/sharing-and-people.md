# Sharing and people

**Status:** canonical for participants, invitations, guests, list members and the People
layer. Sharing applies to two objects — plans and lists — through one system (§1). Entities
are owned by
[`../02-architecture/data-model.md#47-person-and-participant`](../02-architecture/data-model.md#47-person-and-participant)
and
[`../02-architecture/data-model.md#49-invite`](../02-architecture/data-model.md#49-invite);
endpoints by
[`../02-architecture/api-contract.md#24-participants-and-rsvp`](../02-architecture/api-contract.md#24-participants-and-rsvp)
and
[`../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface`](../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface).

---

## 1. The model in one paragraph

A **Person** is a contact in one user's address book. A **Participant** is a Person
attached to one Activity, with an RSVP. A Person may or may not be a registered app user;
if they are, `person.linkedUserId` is set and they get the plan on their own Today. If they
are not, they are a **guest** and get a public invite link instead. There is no friend
graph, no mutual connection, no request-and-accept. People exist because something was
shared with them. See
[`overview.md`](overview.md#6-non-goals).

**Two things are shareable: a Plan and a List.** They share one People layer, one contact
model, one picker, and one `Share` affordance. What differs is what sharing *means* on each,
and that difference is the whole of it:

| | Plan | List |
| --- | --- | --- |
| The unit | `Participant` on an Activity | `ListMember` on a List |
| What is being asked | Are you coming? — or, until a date exists, are you interested? (§3.5) | Nothing. You are in it. |
| State per person | An RSVP: pending, going, maybe, declined | Membership only. Binary. |
| Roles | Owner, participant | Owner, member |
| People without an account | **Yes** — a guest RSVPs from a public link, no install (§4) | **No** — they are invited by email and edit only after signing up (§4a.3) |
| Cap | 50 | 20 |

The rest of this document is: adding people (§2), plan invitations and RSVP (§3), guests and
the public page (§4), **list sharing (§4a)**, guest→user linking (§5), and the People layer
(§6).

---

## 2. Adding people to a plan

### 2.1 Where

| Surface | Affordance |
| --- | --- |
| Creation form (meal, watch, event, outing, custom) | The `People` field |
| Plan detail | `Add people` in the PEOPLE section, and the `Share` action in the header |
| Person view | `Plan something with Alice` — opens the explicit Plan-kind chooser, then the chosen Plan form with Alice pre-added because the action named her |

Adding the first participant flips `activity.visibility` to `shared` and starts the updates
feed. Removing the last one does **not** flip it back; a plan that was shared stays shared,
because its updates feed and any expenses are now history.

> **Decision:** `visibility` is one-way. Silently un-sharing a plan that people have seen,
> commented on, or spent money on would erase context. Owners who want it private again
> delete it.

> **Decision — deleting a shared plan is never silent (2026-08-07).** A plan with
> participants must be **cancelled** before it can be deleted. The delete action on an
> active shared plan runs the existing cancellation first — the `plan_cancelled` push to
> app users and the cancellation email to guests
> ([`notifications.md`](notifications.md#7-notification-catalogue)) — and only then deletes.
> A solo plan deletes directly; there is nobody to tell. A guest whose token resolves to a
> deleted plan sees a minimal `This plan was removed` page, not a blank `410` (§4.6).

### 2.2 The participant picker

One sheet, one search field, three buckets:

```
┌─────────────────────────────────────────┐
│  Add people                      Done   │
│  ┌───────────────────────────────────┐  │
│  │ Search or type a name             │  │
│  └───────────────────────────────────┘  │
│  Selected:  (A) Alice  ✕                │
│                                         │
│  FREQUENT                               │
│    Alice          ✓                     │
│    Ben                                  │
│    Chloe                                │
│                                         │
│  RECENT                                 │
│    Dev                                  │
│    Priya                                │
│                                         │
│  ─────────────────────────────────      │
│    + Add "Marcus" as a new person       │
│    ⊕ Choose from Contacts               │
└─────────────────────────────────────────┘
```

Data comes from `GET /v1/people/suggested`
([`../02-architecture/api-contract.md#28-people`](../02-architecture/api-contract.md#28-people)).

| Bucket | Definition | Order | Size |
| --- | --- | --- | --- |
| **FREQUENT** | People with the most shared activities in the last 180 days, minimum 3 | Count descending, then `lastActivityAt` descending | Up to 8 |
| **RECENT** | People with a shared activity in the last 30 days who are not in FREQUENT | `lastActivityAt` descending | Up to 8 |
| **Search results** | Case-insensitive substring match on `displayName` and `email` across all the user's people | Match quality, then FREQUENT membership, then name | Up to 20 |

> **Decision:** the FREQUENT thresholds (180 days / ≥ 3 shared activities) and RECENT
> window (30 days) are chosen so a new user's picker is not empty and a heavy user's is not
> noise. They are server-side constants in one place and tunable without a client release.

Behaviour:

- Tapping a row toggles selection. Selected people appear as removable chips above the
  buckets.
- Typing a name with no match offers `+ Add "<name>" as a new person`, which opens a
  two-field inline form: display name (pre-filled) and optional email.
- If the typed text is a valid email address that matches an existing app user's verified
  email, the row shows a `Has the app` badge and adding them creates a linked Person, not a
  guest.
- Selection is applied on `Done`, as one `POST /v1/activities/:id/participants` per person.
  On a not-yet-created activity, selections are held locally and sent inside
  `CreateActivityInput.participants[]`.
- The cap is **50 participants per activity**; the 51st selection is refused inline with
  `You can add up to 50 people to a plan.` See
  [`../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items`](../02-architecture/data-model.md#7-write-paths-that-touch-multiple-items).

### 2.3 Choosing someone from the device contacts

Typing a friend's email from memory is the most annoying step in the whole add flow. The app
removes it with a **contact picker**, and with nothing else.

> **Decision — a picker, not a sync.** The app presents the **OS contact picker** through
> `expo-contacts`, which returns **only the single contact the user tapped**. The app never
> enumerates the address book, never reads it in bulk, never uploads it, and never
> stores it. What is kept is the picked contact's display name, email and phone, written
> as an ordinary `Person` row — byte-for-byte what the user could have typed by hand.
> There is no second code path and no second storage shape.

Consequences, all of them deliberate:

| Consequence | Detail |
| --- | --- |
| No contacts permission on iOS | The picker runs **out of process**; the system returns one contact to the app. No `NSContactsUsageDescription` prompt is shown for this flow and no `CONTACTS` read permission is requested. The user's own act of tapping a name is the consent. |
| The App Store privacy label does not grow | `Other user contact info` is already declared for contacts the user types in ([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md#81-app-store-privacy-nutrition-labels) §8.1). A picked contact lands in the same field, from the same person, for the same purpose. |
| Nothing to leak and nothing to delete | There is no address book at rest. Deleting a `Person` deletes everything the picker ever produced. |
| No behaviour change downstream | Guest vs app-user resolution, invites, `PLINK#` rows and balances are identical whether the name was typed or picked. |

**Where it sits.** `⊕ Choose from Contacts` is a persistent row in the sheet's footer,
below FREQUENT and RECENT and directly under the manual `+ Add "<name>" as a new person`
row. It is never above the buckets: someone the user has planned with before is a better
answer than their phone's address book, and putting the OS picker first would make the
common case the slow one. Both footer rows lead to the same two-field form — display name
and optional email — one pre-filled by the OS, one typed.

**A contact with several emails or phone numbers.** The picker hands back every value the
contact holds. The app does not guess. A follow-up sheet lists the addresses with the first
one preselected, exactly one is chosen, and `Skip` creates the Person with no email — which
is a legal guest with a copyable link (§2.4). The same applies to phone numbers, which are
stored for reference only and never used for matching (§5.2). Values not chosen are
discarded; they are not kept "in case".

**A picked contact who is already a Person.** Matching is on **lowercased email first**,
then exact display name when the contact has no email. On a match the sheet offers the
existing person rather than creating a second one:

```
Alice Kim is already in your people.
  Use Alice Kim            (selects the existing person)
  Add as a new person      (secondary)
```

A silent duplicate is never written. `Add as a new person` stays available because two
different people genuinely do share a name, and the merge route
(`POST /v1/people/:id/merge`, §5.2) exists for the case where the user gets it wrong. If the
picked contact matches a person already selected in this sheet, the row is a no-op and the
existing chip pulses rather than doubling.

**Web.** There is no OS contact picker on the web. The row is not rendered on web at all —
not disabled, not present with an explanation. Web users add people by typing a name and an
email, which is the same flow that has always been there. This is stated plainly rather than
hidden behind a feature flag so nobody spends a day looking for a Web Contact Picker
shim.

Explicitly rejected, and not to be added:

| Rejected | Why |
| --- | --- |
| Full address-book import | Requires the `CONTACTS` read permission, which is a prompt at the least trusted moment, for a benefit one tap already delivers. It also puts third-party PII at rest in the app's storage, which is a privacy-label liability and a deletion obligation with no matching feature. |
| Matching the user's contacts against other app users | That is a social graph — "these five people you know are here" — and the product does not have one, does not want one, and says so in §7. It would also disclose, to the user, who else has an account. |
| Background or periodic contact sync | Nothing about a `Person` needs to stay in step with the phone. The record is a snapshot the user can edit. |

### 2.4 What happens on add

| Person type | Server does | Person receives |
| --- | --- | --- |
| Registered app user (`linkedUserId` set) | Writes `PART#`, an `ActivityIndex` entry in **their** partition, and `PLINK#` rows both ways | An in-app invitation and a push notification (§3) |
| Guest with an email | Writes `PART#`, the owner's `PERSON#`, `PLINK#`, and an `INVITE#<token>` | An email from SES containing the public invite link (§4) |
| Guest with no email | Writes the same minus the email send | Nothing automatic — the owner gets a copyable link to send however they like |

The owner always sees the invite link on the participant's row and can copy or re-send it.

---

## 3. App-user invitations

### 3.1 The invitation

An invited app user gets:

1. A push notification (`invitation_received`, on by default — see
   [`notifications.md`](notifications.md#7-notification-catalogue)).
2. An entry in the in-app notification inbox.
3. The plan immediately, with `rsvp: 'pending'` and a pending badge — on their **Today** and
   in **Plans → Upcoming** when it has a date, and in **Plans → Needs a date** when it does
   not ([`plans-and-lists.md`](plans-and-lists.md) §1.3). It is not hidden until they
   respond; a dinner on Thursday is information they need whether or not they have tapped a
   button.
4. Their own reminder, created only from an explicitly saved `defaultReminderOffset` when the
   plan has a time. `0` is At the time; unset is Off. It is theirs, not the owner's: nobody
   inherits anybody else's reminder, and the invitee can change or remove it without affecting anyone
   ([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1).

### 3.2 RSVP

Three responses. On a dated plan they read **Going**, **Maybe**, **Decline**; on a plan with
no date they read **Interested**, **Maybe**, **Pass** (§3.5). There is no fourth, no
free-text reply in the RSVP control, and no "seen" state.

`PATCH /v1/activities/:id/participants/:personId` with `{ rsvp }`. A participant may only
change their own; the owner may change anyone's (for the case of relaying a reply that came
by text message).

| Response | Effect |
| --- | --- |
| `going` | Row stays on Today and Plans, badge clears. Counts toward the plan's `Going` count. |
| `maybe` | Row stays on Today and Plans with a `Maybe` badge. |
| `declined` | The plan is removed from the invitee's Today and agenda; their `ActivityIndex` entry is rewritten as a **declined read-only projection** — the durable Plans row (under its date, Past once it passes) carrying `Rejoin` (see the decision below). It also remains visible in their notification inbox for 90 days ([`notifications.md`](notifications.md#5-the-in-app-inbox) §5) as a convenience. The owner sees them listed as `Declined`. |

> **Decision — declining keeps a durable route back (2026-08-07).** A declined participant
> keeps a **read-only row** for the plan in Plans — under its date, and in Past once that
> passes — with a `Rejoin` action that restores their index entry. The inbox entry is a
> convenience with a 90-day lifetime; the route back never depends on it.

Every RSVP change writes a system entry to the updates feed (`Alice is going`) and notifies
the owner (`rsvp_changed`). Changing an RSVP later is always allowed, including after the
plan's date. An RSVP write stamps `rsvpForDate` from the plan's current date **read in the
same transaction**, so a `Going` racing a date change can never be recorded as consent to
the new date.

### 3.3 What appears on the invitee's Today

Only a plan with a date reaches Today. An invitation to a plan with no date lands in the
invitee's Plans → Needs a date and nowhere else — the same stage, with the same row, as it
occupies for the owner ([`plans-and-lists.md`](plans-and-lists.md) §1.3.1).

For a dated plan, the same `AgendaItem` the owner sees, with these differences:

- A pending-RSVP badge and inline `Going · Maybe · Decline` actions until they respond.
- The owner's name in the subtitle when the plan has no location:
  `From Alice`.
- No prep tasks of the owner's that are not shared (prep tasks on a shared plan are
  visible; a prep task on a *private* plan is not, because the plan is not shared).

### 3.4 What a participant can and cannot change

Enforced in one authorisation middleware, per
[`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules).

| Action | Owner | Participant (app user) | Guest |
| --- | --- | --- | --- |
| Read the full plan | Yes | Yes | No — public projection only (§4.2) |
| Change their own RSVP | Yes | Yes | Yes, via the token |
| Change someone else's RSVP | Yes | No | No |
| Post an update | Yes | Yes | No |
| Add an expense | Yes | Yes | No |
| Edit or delete **their own** expense | Yes | Yes | No |
| Edit or delete someone else's expense | Yes | No | No |
| Complete, skip or snooze the plan | Yes | **No** | No |
| Manage **their own** reminders | Yes | Yes | No |
| See anyone else's reminders | **No** | No | No |
| Suggest a date on an undated plan | Yes | Yes | No |
| Mark a suggestion as `Works for me` | Yes | Yes | No |
| Delete a date suggestion | Yes, any | Their own | No |
| Schedule the plan from a suggestion | Yes | No | No |
| Rename, reschedule, change location, change type | Yes | No | No |
| Add or remove participants | Yes | No | No |
| Leave the plan | n/a — the owner deletes it | Yes (`DELETE .../participants/:self`) | No |
| Add attachments | Yes | No | No |
| Delete the plan | Yes | No | No |
| Add prep tasks | Yes | Yes | No |
| Complete or edit a prep task — **any participant of the parent plan, whoever created it** | Yes | Yes | No |

A participant attempting an owner action gets `403 forbidden`. A non-participant gets
`404 not_found`, never `403`, so the API never confirms that an activity exists.

Leaving or being removed ends Plan access immediately, but it does not erase expense
obligations. If retained Expenses involve that person, their balance and exact expense-only
drill-down remain available from People so settlement and Undo still work; this does not
restore the Plan, its title, notes, participant list, or schedule. When the last retained
Expense reference is deleted, that financial-only relationship disappears.

Prep tasks the departing participant created are **detached to them**: `parentActivityId`
is cleared, so the task leaves the plan and goes with its creator as an ordinary task, and a
system entry in the updates feed records that it went. Prep tasks created by others are
untouched ([`plans-and-lists.md`](plans-and-lists.md)).

> **Decision: completion authority follows the object, and a prep task is not a plan.**
> Participants may add prep tasks and complete them. A shared trip where only the owner can
> add "book the rental car" makes the owner a bottleneck, and prep tasks are low-risk: they
> cannot change when or where the plan happens.
>
> The prep-task row is deliberately different from the plan row two lines above it.
> Completing the **plan** asserts a shared fact about an event and stays with the owner.
> Completing a **prep task** ticks an item on a shared checklist, so **any participant of
> the parent may complete, uncomplete and edit it, whoever created it** — if Alice books the
> hotel she ticks `Book hotel` whether or not she typed it. The mechanism is one rule in the
> authorisation middleware, stated in
> [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
> §3: a participant of the parent may act on a child.

> **Completing the plan is global and owner-only.** An occurrence records that *the thing
> happened*, not that *I attended*
> ([`../02-architecture/data-model.md#45-occurrence`](../02-architecture/data-model.md#45-occurrence)),
> so on the plan itself a participant has no completion, skip or snooze control anywhere —
> not on the row, not in the swipe actions, not on plan detail. Its prep tasks are the
> separate case above. The two things a participant can do instead are
> both about themselves: **set their RSVP to declined** if they did not go, which the owner
> sees, or **leave the plan** if they want it off their day, which removes it from their
> Today and Plans entirely. Per-participant completion is a real feature with a real cost and
> is deferred, not forgotten.

> **Reminders are per person.** A participant sets, changes and deletes their own reminders
> on any plan they are on, and nobody — the owner included — can see or set anybody else's.
> Joining a shared plan creates your own reminder from your own default offset
> ([`notifications.md`](notifications.md#21-per-activity-reminder-control) §2.1).

> **Decision:** participants may **not** add attachments in v1. Attachment uploads are the
> one place a participant could push arbitrary bytes into the owner's S3 prefix, and the
> moderation and quota questions that follow are out of scope for v1.

### 3.5 Responding to a plan that has no date

A plan can exist before anybody has picked a day
([`plans-and-lists.md`](plans-and-lists.md) §1.2). Being asked `Going?` about a plan with no
day is a question nobody can answer, so the words change with the presence of a date. The
**stored values never change**; only the labels do.

| Stored | No date | Has a date |
| --- | --- | --- |
| `going` | `Interested` | `Going` |
| `maybe` | `Maybe` | `Maybe` |
| `declined` | `Pass` | `Decline` |

Saying `Interested` is not the same as helping to pick a day. The participant who wants a
date proposes one — see [`plans-and-lists.md`](plans-and-lists.md#23-date-suggestions) §2.3;
only the owner schedules.

This is one rendering rule applied everywhere the response appears: the inline row actions,
the plan's PEOPLE section, the Needs-a-date row summary
([`plans-and-lists.md`](plans-and-lists.md) §1.3.1), the updates feed (`Alice is interested`
against `Alice is going`), and notification copy. There is no `interested` state, no fourth
enum member, and no per-plan setting that picks the vocabulary. See
[`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change).

#### 3.5.1 A date landing resets your response

**The rule.** Saying `Interested` agreed to the idea. It did not agree to a Saturday nobody
had picked. When a date is set for the first time, or an existing date is changed, every
participant's response is reset to pending and everyone is asked again. A time-only change on
the same date does not reset anything, and clearing the date does not either.

Declined participants are the one exception, and the rule is the same whether they are an
app user or a guest: their `declined` stands, and they are neither reset nor notified. They
left the conversation, and a date change is not an invitation. `Rejoin` (§3.2) remains their
route back.

**What Alice sees.** She said `Interested` to `Dinner at Zahav` last Tuesday. Ujjwal sets
Saturday 9 August.

1. One notification: `Dinner at Zahav has a date` / `Sat 9 Aug, 7:00 PM · you'll need to
   reply again`. It is a `plan_changes` notification, not a new invitation — she was already
   on the plan ([`notifications.md`](notifications.md#7-notification-catalogue)).
2. The plan moves from her Plans → Needs a date to Plans → Upcoming, and onto her Today when
   Saturday comes.
3. Its row carries the pending badge again, with inline `Going · Maybe · Decline` — the dated
   words now, because it has a date.
4. Plan detail shows her previous answer as context, not as her answer:
   `You were interested. Saturday 9 August works?` The stored `rsvpForDate` is what makes
   this renderable and what makes the reset provably correct rather than inferred.
5. Nothing about her earlier response is deleted from the updates feed. `Alice is interested`
   stays in the history with its original timestamp, followed by the system entry for the
   date being set.

**What Ujjwal sees.** Before confirming, a dialog naming exactly how many replies he is
about to discard ([`plans-and-lists.md`](plans-and-lists.md) §1.4). Afterwards, his PEOPLE
section shows everyone but the declined pending again. His own row is never reset.

> **Decision — the reset is silent about who said what before, except to that person.** The
> plan shows `Alice — awaiting reply`, not `Alice — was interested, awaiting reply`. Alice
> sees her own prior answer because it is hers; showing everyone else's stale answers next to
> live ones would turn a clean re-ask into a scoreboard of who has changed their mind.

---

## 4. Guests and the public invite page

Requiring an install to attend a dinner is the friction the product exists to remove.

### 4.1 The link

`https://ordinarydays.app/invite/<token>`

- `token` is 22 characters of base62 from `crypto.randomBytes(16)` — **not** a ULID, so it
  leaks neither creation order nor guessable structure
  ([`../02-architecture/data-model.md#8-ids`](../02-architecture/data-model.md#8-ids)).
- A **personalised** invite has `personId` set and pre-fills that guest's name and RSVP
  state. A **shareable** invite (`POST /v1/activities/:id/invites`) has no `personId` and
  collects a name from whoever opens it.
- The page is server-rendered-equivalent static content hydrated from
  `GET /public/v1/invites/:token`. It is the only unauthenticated screen in the product.

### 4.2 Exactly what the page shows

The page renders these fields and no others:

| Shown | Source |
| --- | --- |
| Plan title | `activity.title` |
| Date, start time, end time, timezone — or `The date is still being decided` | `activity.schedule`, or `dateStatus: 'undecided'` when there is none ([`../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface`](../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface)) |
| Location label and address | `activity.location.label`, `.address` |
| Description | `details.description` (`event`) — **not** `activity.notes` |
| Poster / cover image | The activity's `primaryAttachmentId`, served through CloudFront |
| Organiser display name | The owner's `displayName`. Never their email. |
| RSVP counts | Aggregate integers only: `4 going · 1 maybe` |
| The invited person's own name and current RSVP | Only for a personalised invite |
| Ticket link and price | `details.ticketUrl`, `details.priceCents` (`event` only) |

```
┌───────────────────────────────────────────┐
│           [ poster image ]                │
│                                           │
│   Food Festival                           │
│   Saturday 16 August · 12:00 – 6:00 PM    │
│   Eastern Time (US & Canada)              │
│   Penn's Landing, Philadelphia            │
│                                           │
│   An all-day street food festival …       │
│   $25 · Tickets ↗                         │
│                                           │
│   From Ujjwal · 4 going · 1 maybe         │
│                                           │
│   Are you coming?                         │
│   ┌────────┐ ┌────────┐ ┌────────┐        │
│   │ Going  │ │ Maybe  │ │Decline │        │
│   └────────┘ └────────┘ └────────┘        │
│                                           │
│   Add to calendar                         │
│   Google · Apple · Download .ics          │
│                                           │
│   Made with Ordinary Days                 │
└───────────────────────────────────────────┘
```

**The page uses the same date-sensitive vocabulary as the app** (§3.5). Asking a guest
`Are you coming?` about a plan with no day is a question nobody can answer, and a guest is
the person least equipped to work out what it means.

| Plan state | Where the date goes | The question | The three buttons |
| --- | --- | --- | --- |
| Has a date | `Saturday 16 August · 12:00 – 6:00 PM` | `Are you coming?` | `Going` · `Maybe` · `Decline` |
| No date | `The date is still being decided.` | `Are you interested?` | `Interested` · `Maybe` · `Pass` |

The undated page drops the calendar-export block with it — there is nothing to export — and
keeps everything else, including the poster, the description and the counts, which read
`4 interested · 1 maybe`.

```
┌───────────────────────────────────────────┐
│   Dinner at Zahav                         │
│   The date is still being decided.        │
│   237 St James Place, Philadelphia        │
│                                           │
│   From Ujjwal · 2 interested              │
│                                           │
│   Are you interested?                     │
│   ┌──────────┐ ┌────────┐ ┌────────┐      │
│   │Interested│ │ Maybe  │ │  Pass  │      │
│   └──────────┘ └────────┘ └────────┘      │
│                                           │
│   We'll email you when there's a date.    │
│                                           │
│   Made with Ordinary Days                 │
└───────────────────────────────────────────┘
```

The `We'll email you when there's a date.` line renders **only when an email is on file**
for that guest. With no address there is nothing to promise, and the line is omitted rather
than softened.

The stored values are the same four in both cases, and there is no fourth enum member —
[`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change).
A guest may not suggest a date; suggesting is a participant capability (§3.4) and the public
projection does not return suggestions at all (§4.3).

### 4.3 Fields the public projection must never expose

This is an allow-list, enforced by a projection function in `services/api` and covered by a
snapshot test that fails when any key is added
([`overview.md`](overview.md#7-success-criteria-for-v1) S8).

Never returned by `/public/v1/invites/:token`, under any circumstance:

- `activity.notes`
- Any expense: amounts, splits, payers, settlement state, `expenseTotalCents`
- Any other participant's name, email, phone, avatar, or RSVP **individually** (only the
  aggregate counts)
- Any email address at all, including the organiser's
- Any `userId`, `personId`, `activityId`, or other internal identifier
- Any other activity of the owner's, including prep tasks and children
- Any list, list item, or list content
- Any attachment other than the single cover image
- The updates feed, in whole or in part
- `recurrence`, anybody's reminders, or occurrence data
- Date suggestions: the dates, their notes, their authors, and who they work for
- `location.lat` / `location.lng` when `location.address` is absent — do not leak precise
  coordinates for a plan whose address the owner chose not to write
- `sourceUrl` when it is not `details.ticketUrl`

A field that is not on the §4.2 list is not on the page. When in doubt, it is excluded.

> **Decision — a guest is never shown their own balance.** Confirmed 2026-08-07. The
> financial exclusions above are deliberate and complete: there is no guest balance view and
> no expense-sharing link, in v1 or in the plan. The consequence, stated plainly: the person
> who owes the money is the one the app will not tell, and the owner is expected to tell them
> out of band. This is a known trade-off rather than a gap to fill helpfully — a read-only
> balance link is a product change that needs the founder
> ([`expenses.md`](expenses.md#66-guests-with-expenses-but-no-account) §6.6,
> [`../00-open-decisions.md`](../00-open-decisions.md) #11).

### 4.4 The RSVP flow with no account

Three taps, under 30 seconds
([`overview.md`](overview.md#7-success-criteria-for-v1) S4).

1. Open the link. The page loads with no interstitial, no cookie banner, no "get the app"
   overlay.
2. Tap `Going`, `Maybe` or `Decline` — or `Interested`, `Maybe` or `Pass` when the plan has
   no date (§4.2).
3. If the invite is personalised, the response is recorded immediately and the page shows
   `You're going. See you Saturday.`, or `You're interested. We'll email you when there's a
   date.` on an undated plan. If it is a shareable link, a single name field appears
   with the button `Confirm`; email is offered but explicitly optional and labelled
   `Optional — only used to send you updates about this plan.`

`POST /public/v1/invites/:token/rsvp` is rate-limited to 30 requests per minute per IP
([`../02-architecture/api-contract.md#4-rate-limits`](../02-architecture/api-contract.md#4-rate-limits)).
The response updates the `Participant` row, writes a system entry to the updates feed, and
notifies the owner.

> **Decision — a known email converges on the existing account (2026-08-07).** When the
> responder supplies an email, the endpoint matches it against verified `EMAIL#` records
> ([`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns),
> pattern 14). On a hit, the RSVP attaches to the existing app user — a `Participant` is
> created or updated for them — instead of minting a guest Person that §5 would have to
> link later. An unverified address, or no address at all, keeps the ordinary guest path.
> The page never says whether the address matched: revealing who has an account is exactly
> what §7 forbids.

A guest may change their response any number of times by revisiting the link. The page
always shows their current answer.

**A guest who answered an undated plan is asked again when the date lands**, on exactly the
rule that applies to app users (§3.5.1). Their `rsvp` is reset to pending, and the
`plan_changed` email goes out with the new date and one line saying their earlier answer no
longer stands: `You said you were interested. Saturday 9 August — are you coming?` The link
is unchanged and now shows the dated page with `Going · Maybe · Decline`. A **declined**
guest is excluded from the re-ask email, exactly as a declined app user is not re-asked:
their `Pass` stands (§3.5.1). A guest with no
email address on file cannot be told, so the owner's participant row shows
`No email — tell them yourself` in place of the resend control.

There is **no** account creation prompt above the fold. A single unobtrusive line at the
bottom (`Made with Ordinary Days`) links to the marketing page. No modal, no interstitial,
no email capture wall.

### 4.5 Calendar export

Three options, all available without an account:

| Option | Endpoint | Behaviour |
| --- | --- | --- |
| Google | `GET /public/v1/invites/:token/calendar/google` | `302` to a Google Calendar template URL with title, start, end, location and description pre-filled |
| Apple | `GET /public/v1/invites/:token/ics` | Serves `text/calendar`; iOS opens it in Calendar directly |
| Download `.ics` | Same endpoint, `Content-Disposition: attachment` | For desktop and everything else |

The `.ics` contains only the fields in §4.2, a `UID` derived from the token (not the
activity id), and no `ATTENDEE` lines — exporting a plan must not leak the guest list. It
carries no `RRULE`: a public invite is always for one occurrence.

Authenticated users get the same file from `GET /v1/activities/:id/ics`.

> **Decision:** the `.ics` omits `ATTENDEE` entirely rather than including the exporting
> guest. Some clients treat `ATTENDEE` as an invitation to reply by email, which would
> route replies somewhere the app does not read.

### 4.6 Token lifetime and revocation

| Property | Value |
| --- | --- |
| Expiry | 90 days after the plan's `schedule.date`. For an unscheduled activity, 90 days after the invite was created. |
| Expired behaviour | `410 invite_expired`. The page renders `This invitation has expired.` and nothing about the plan — not the title, not the date. |
| Revocation | `DELETE /v1/activities/:id/invites/:token` sets `revoked: true`. Immediately returns `410 invite_revoked` with the same blank page. |
| Removal of a participant | Revokes their personalised token as part of the same transaction. |
| Deletion of the plan | Revokes every token for it. Deleting a plan with participants is only reachable through cancellation (§2.1), so guests were told first; a token that then resolves to a deleted plan renders a minimal `This plan was removed` page — no title, no date — rather than a blank `410`. |
| Rescheduling the plan | Does **not** revoke tokens. The page shows the new time; that is the point of a link being the source of truth. |
| Storage TTL | `invite.ttl` = `expiresAt` + 30 days, after which DynamoDB removes the row and the token resolves to `404`. |
| Rotation | The owner can rotate a shareable link (`POST` a new invite, `DELETE` the old). Personalised tokens are not rotatable; remove and re-add the person. |

An invite to an **undated** plan can outlive its token: the token expires 90 days after it
was created, and the date may land months later. When a date is finally set, expired or
TTL'd tokens for that plan's guests are **reissued**, and each guest with an email is
re-emailed the new link as part of the date fan-out (§4.4; declined guests excluded). A
guest with no live token **and** no email cannot be reached at all, and the owner's
participant row says so plainly: `Invite expired — resend`, which mints a fresh token to
send or copy, and `No email — tell them yourself` when there is no address to send it to.

---

## 4a. Sharing a list

The interaction, the sheet and the concurrency rules are specified in
[`plans-and-lists.md`](plans-and-lists.md) §5.11. This section is the people side: how a
Person becomes a member, what each kind of invitee experiences, and where list sharing
differs from plan participation. Entities are owned by
[`../02-architecture/data-model.md#shared-lists`](../02-architecture/data-model.md#shared-lists);
endpoints by
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists).

> **Decision — the section is numbered `4a`.** Six documents cite §5, §6, §7 and §8 of this
> file by number. Renumbering to insert a section would break every one of those citations,
> which is worse than an unusual heading. The form follows
> [`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.

### 4a.1 How it differs from being on a plan

| | Plan participant | List member |
| --- | --- | --- |
| Is there a question to answer? | Yes: are you coming? | No. |
| Per-person state | `rsvp`: pending, going, maybe, declined | **Membership only. Binary — you are in it or you are not.** |
| Can they decline? | Yes, and declining removes their access | No. There is nothing to decline; someone who does not want the list leaves it (§4a.4). |
| Roles | `owner`, `participant` | `owner`, `member` |
| Without an account | A guest RSVPs from a public link and never installs anything | **Not possible.** They are invited by email and can edit only after signing up (§4a.3). |
| Cap | 50 | 20 |
| Notification on being added | `invitation_received` | `added_to_list` |

There is **no RSVP on a list, and there never will be.** A list has no time, no location and
no attendance, so every column of an RSVP is undefined for it. A `ListMember` row's `status`
(`invited` / `active`) is not an RSVP; it records whether the person has an account yet, and
it is set by the system, never by them. Those rows represent non-owners only; the list owner
is always in the roster through the list's ownership record and owner access pointer.

### 4a.2 Inviting someone who has the app

`Share` on the list opens the same participant picker as a plan (§2.2), with the same
FREQUENT and RECENT buckets, the same search, the same `+ Add "<name>" as a new person` row
and the same OS contact picker (§2.3). Selecting people and confirming issues one
`POST /v1/lists/:id/members` per person.

For each app user:

| Server does | The person receives |
| --- | --- |
| Writes `MEMBER#` with `role: 'member'`, `status: 'active'`, a `ListIndex` pointer in **their** partition, an owner-scoped `Person` for each side when needed, and an active `PersonListLink` (`LLINK#`) in both user partitions | An `added_to_list` push and inbox entry, the list in their Lists index immediately, and the owner in People |

There is no accept step. A list is not somewhere you have to be at a time, so there is
nothing to hold open pending a decision. Someone who does not want it leaves.

### 4a.3 Inviting someone who does not have an account

They are added by name and email. The member row is written with `status: 'invited'`, no
`userId`, and **no recipient index entry** — there is no partition to write one into yet.
The owner's partition gets an invited `PersonListLink`, so this explicit invitation can be
found for signup, withdrawal and Person-deletion checks without guessing from the name or
email again. One email goes out (`list_invitation_email`), naming who invited them and the
list's title, with a button that opens the App Store. **It contains no item content and links
to no web view**:
there is no public list page, and building one would mean a second unauthenticated surface
with its own projection allow-list (§4.3).

The pending `ListMember` counts toward the list's 20-person cap and stored `memberCount`, and
the owner sees `Invited · we emailed them` with `Resend` and `✕`. It contributes no active
member avatar, no access, no recipient-side row and no `In n lists with you` count.

On signup with a **verified** email the existing linking machinery (§5) activates the
relationship: the reverse email index identifies the owner-scoped Person, that Person's
invited `LLINK#` rows identify the pending memberships directly, `status` becomes `active`,
`userId` and `reciprocalPersonId` are set, and the new user's `ListIndex` pointer is written.
The service also creates or reuses the reciprocal Person for the owner, changes the owner's
link to active and writes the new user's active reciprocal link. The list is there the first
time they open the app. Nobody is notified, nothing is asked of them, and they are not told
who else was waiting for them.

> **Decision — there is no guest editing of a list, in v1 or in the plan.** Every item
> mutation has to be attributable to an identity: `Ben checked Milk` is only meaningful if
> Ben is somebody. A link anyone can open and type into gives an anonymous write path into
> another person's data, which is a different product with a different threat model. The
> asymmetry with plans is deliberate and is the reason plans have a public page at all: a
> guest RSVP is one bounded answer about themselves, not an edit to shared content.

### 4a.4 Leaving, and being removed

| Action | Who | Effect |
| --- | --- | --- |
| `Leave list` | Any member, on themselves | `DELETE /v1/lists/:id/members/:self`. The index pointer, member row and both list-relationship links go; the list leaves their Lists index. |
| Remove a member | Owner only | The same, for that person. Confirmed per [`interaction-contract.md`](interaction-contract.md#1a-product-wide-invariants) §1a.1. |
| Leave, as the owner | Not offered | The owner deletes the list or keeps it, exactly as an owner cannot leave their own plan. |

**Items you wrote stay on the list.** They belong to the list, not to you. Activities you
scheduled from those items are yours and are untouched; they keep their back-pointer and
simply stop offering to navigate to a list you can no longer read. The confirmation states
both, with counts ([`plans-and-lists.md`](plans-and-lists.md) §5.11.4).

Removing someone from a list does **not** delete either owner-scoped Person, does not affect
any plan they are on, and does not notify anyone but them. Deleting the list removes all of
its list-relationship links but likewise leaves the People records intact.

---

## 5. Guest → registered user linking

When a guest later signs up, their history should attach to their account rather than
duplicate.

### 5.1 The trigger

On successful Cognito signup with a **verified** email, the API:

1. Writes `EMAIL#<lowercased-email>` → `USER` (access pattern 14 in
   [`../02-architecture/data-model.md#5-access-patterns`](../02-architecture/data-model.md#5-access-patterns)).
2. Searches for `Person` rows across all owners whose `email` matches, case-insensitively,
   and which have no `linkedUserId`.
3. For each match, sets `person.linkedUserId` to the new user id and creates an
   `ActivityIndex` entry in the new user's partition for every non-completed activity that
   person participates in.
4. Queries that Person's invited `LLINK#` rows, activates each matching `ListMember`, writes
   the new user's `ListIndex` pointer, creates or reuses a reciprocal Person for the list
   owner, and writes the active list-relationship link on both sides.

### 5.2 The rules

- **Verified email only.** An unverified address never links anything. Cognito's own
  verification is the gate; the API checks the `email_verified` claim.
- **No merge prompt on the guest's side.** The new user opens the app and their plans are
  already there. Asking "are you the Chloe that Ujjwal invited?" is both confusing and a
  disclosure of Ujjwal's address book.
- **The owner is not notified.** Their contact silently gains a `Has the app` badge.
- Completed and cancelled activities are **not** back-filled into the new user's index —
  they would arrive as history the user never chose to keep. They remain visible through
  the Person view when the relationship is used again.
- Guest expenses transfer with the person: the `Participant` and `Expense` rows already
  reference `personId`, which is unchanged, so balances continue to compute correctly and
  now appear on both sides.
- The reverse case — the owner adds an email to an existing guest Person that matches a
  registered user — links immediately on save, with the same effects.
- Duplicate contacts (the same human added twice with different spellings) are resolved by
  `POST /v1/people/:id/merge`, which is user-initiated from the Person view and moves
  `PLINK#`, `Participant`, `Expense`, `ListMember`, `LLINK#` and pending-email references
  onto the surviving `personId`. If both contacts are on one list, the membership collapses
  to one row: active wins over invited, the earlier `addedAt` is retained and `memberCount`
  is reduced once. If both contacts are Participants on the **same activity**, those rows
  collapse to one as well: the row with the latest `respondedAt` survives,
  `participantCount` is decremented once, the plan's RSVP counts are recounted, and expense
  splits and date-suggestion authorship are re-pointed to the surviving `personId`.
  Conflicting linked identities still block the merge.

> **Decision:** phone numbers are not a linking key in v1. Only verified email links a
> guest to an account. Phone is stored for the user's own reference and never matched.

---

## 6. The People layer

### 6.1 How people are derived

Contacts appear because something was shared, and for no other reason.

| Source | Creates a Person |
| --- | --- |
| Adding someone to a plan | Yes |
| Someone adding *you* to a plan | Yes — the owner becomes a Person in your address book |
| **Adding someone to a list** | Yes — same rows, same picker, same contact model (§4a.2) |
| **Someone adding *you* to a list** | Yes — the list's owner becomes a Person in your address book |
| A guest RSVPing to a shareable link | Yes, in the owner's address book only |
| They pay for, or share a split with, an expense you're in | Yes — a balance needs a Person on each side, so the expense write creates the missing rows both ways: display name only, no email or other contact details copied ([`expenses.md`](expenses.md#51-what-a-balance-is) §5.1) |
| `POST /v1/people` from the People page | Yes — the one manual route |
| Picking one contact from the OS contact picker (§2.3) | Yes — but only as an **input method** to an explicit Plan share, List share or manual `POST /v1/people`. It fills the name and email fields; it never decides what will be shared and is not a separate import route. |
| Following, friending, importing a contact list, syncing an address book | **No such route exists** |

There is no global friendship or reciprocal relationship object. Each side owns its own
`Person` record. An explicitly confirmed Plan or List share creates or reuses the necessary
record on each side, and so does an expense whose payer and split set pairs two participants
who do not yet have each other — the same `personId` mirrored into each affected app user's
partition, in the expense's own transaction ([`expenses.md`](expenses.md#51-what-a-balance-is)
§5.1). A manual contact or unregistered guest exists only in its creator's
address book until a verified account is linked; a guest's mirrored side is created if and
when they link an account.

`person.upcomingCount` and `person.lastActivityAt` are denormalised counters maintained on
write. `PLINK#<personId>#<sortTs>#<activityId>` rows are the shared-activity feed
(access pattern 10). `LLINK#<personId>#<addedAt>#<listId>` rows are the explicit shared-list
projection. Only active links contribute to `sharedListCount` and `LISTS TOGETHER`; an
invited owner-side link exists for lifecycle work but is not presented as a shared list.
`LLINK#` is discovery data, never an access grant. **Neither activity counter is touched by
list membership or list activity** — see §6.3.

### 6.2 Where People lives

Not in primary navigation. People is reached from **Profile → People** and from search.
This is deliberate: promoting it to a tab would make the app feel like a social product,
which it is not (concept §22).

### 6.3 The People page

`GET /v1/people?sort=relevance`. One flat list, no sections, no avatars grid.

Sort order, applied in this precedence:

1. `upcomingCount` descending — people you have plans with, first.
2. Absolute outstanding balance descending — people you owe or who owe you.
3. `lastActivityAt` descending — recent shared activity.
4. `displayName` ascending — stable final tie-break.

Each row shows: display name, a one-line summary, and a balance chip when non-zero.

```
Alice        3 upcoming · Alice owes you $42.50
Ben          1 upcoming
Chloe        You owe Chloe $18.00
Dev          Last together 12 Jul
```

A `Sort` control in the header offers `Relevance` (default), `Name`, `Balance`. The
alternate sorts are client-side re-orderings of the same response.

**Shared lists and the sort.**

> **Decision — an active shared list creates a Person but is not a relevance signal.** The sort's
> first key is `upcomingCount`, which answers "who am I about to see?", and a list has no
> future to count. Membership is not added as a fifth key, and neither joining a list nor
> anyone editing it bumps `lastActivityAt` — a flatmate ticking `Milk` at 8 AM must not
> reorder the People page. Someone you share only a list with therefore lands in the final
> tier and sorts by name, which is stable, predictable, and where they belong on a page that
> is about plans, lists and money.

A person you share only a list with still gets a row, and its one-line summary names the
relationship rather than leaving it blank:

```
Alice        3 upcoming · Alice owes you $42.50
Ben          1 upcoming
Chloe        You owe Chloe $18.00
Dev          Last together 12 Jul
Priya        In 2 lists with you
```

The summary precedence is unchanged — upcoming, then balance, then last-together — with
`In n lists with you` used only when the first three produce nothing.

### 6.4 The Person view

`GET /v1/people/:id`. Answers three questions: *what are we doing together?*, *do we owe each
other anything?*, and *what are we keeping together?*

```
┌───────────────────────────────────────────┐
│  ‹ People                            ⋯    │
│                                           │
│   (A)  Alice                              │
│        alice@example.com · Has the app    │
│                                           │
│   3 upcoming together                     │
│   Alice owes you $42.50            ›      │   (tappable)
│                                           │
│   UPCOMING                                │
│     Dinner at Zahav              Aug 9    │
│     Food Festival                Aug 16   │
│     Watch Severance              Aug 23   │
│                                           │
│   RECENT                                  │
│     Movie Night     Attended · $18 unsettled │
│     Beach Trip      Attended · Settled    │
│                                           │
│   LISTS TOGETHER                          │
│     Groceries                   14 items  │
│     Packing · New York Trip      8 items  │
│                                           │
│   Plan something with Alice               │
└───────────────────────────────────────────┘
```

| Element | Rule |
| --- | --- |
| Header | Display name, email if known, `Has the app` badge when `linkedUserId` is set. Editable name and email via `⋯ → Edit`. |
| `n upcoming together` | Count of shared activities with a future `schedule.date`. Tappable — opens the full list. Never rendered without a drill-down. |
| Balance line | Net figure with direction stated in words, never a bare signed number. **Always tappable**, opening the expense breakdown ([`expenses.md`](expenses.md#5-balances)). Hidden entirely when the net is zero and there are no unsettled expenses. |
| UPCOMING | Shared activities with a future date, ascending. Max 5, then `See all`. |
| RECENT | Shared activities with a past date, descending, showing outcome and settlement state. Max 5, then `See all`. |
| LISTS TOGETHER | Active, access-checked lists one of you explicitly shared with the other, with their item counts, ordered by `addedAt` descending. Two non-owner co-members do not become People automatically. The screen shows 5, then `See all`; the expanded view pages 20 at a time. Each row opens the list. Hidden entirely when there are none. |
| `Plan something with Alice` | Opens the explicit Plan-kind chooser (**General / Meal / Watch / Event / Outing**), then the chosen Plan form with Alice pre-selected because the button named her. The title text never chooses the Plan kind or adds anyone else. |
| `⋯` | Edit, Merge with another person, Delete. Delete is blocked with `409` while they participate in any non-completed activity **or have an invited/active shared-list membership**, and the UI names the blocking plans and lists. |

`Nothing together yet` appears only when there are no shared Plans, no active shared Lists
and no balance. A pending list invitation is a deletion blocker, not something represented
as already shared in this view.

---

## 7. Anti-goals

These do not exist and will not be added. Each is listed because a "people" feature invites
it.

| Not built | Why |
| --- | --- |
| Followers, following, friend requests, mutual connections | Relationships come from explicit shared Plans or Lists. A separate social relationship system would immediately disagree with those objects. |
| A feed of what other people are doing | The app has exactly one feed, and it belongs to a single plan. |
| Likes, reactions, emoji responses | RSVP is the only reaction. Updates take text. |
| Public profiles, usernames, discoverability, search-for-people-by-name across the app | The only way to reach a person is an explicit shared Plan or List, a manual contact, or an email you already know. |
| Relationship scores, streaks, "you haven't seen Ben in a while" nudges | Quantifying friendships is the opposite of what a life planner should do. FREQUENT in the picker is a convenience ordering, is never shown as a number, and is never surfaced outside the picker. |
| Activity or list visible to "friends of friends", or to anyone not explicitly added | The only sharing primitives are adding a specific person and, for a plan only, generating a specific link. Lists have neither a link nor a public page (§4a.3). |
| Contact-list import, address-book sync, matching contacts against other app users | The permission prompt is a trust cost, an imported address book is third-party PII at rest with a deletion obligation, and contact matching is a social graph. The **OS contact picker** (§2.3) gives the one useful part — not retyping an email — and returns exactly one contact, so none of the three costs is incurred. |
| Direct messaging | Updates on a plan are scoped to that plan. There is no inbox between two people. |
| A public, linkable or web-viewable list | A plan has a public page because a guest must answer "am I coming?" without installing anything. A list asks nothing, so a public page would be a second unauthenticated surface with no question behind it (§4a.3). |
| A list activity feed, an edit history, or per-item attribution in the UI | `Ben checked Milk at 8:04` is surveillance of a flatmate, not a feature. A list shows its current state. The one feed in the product belongs to a single plan. |
| List roles beyond owner and member, or per-item permissions | Someone who should not edit the list should not be on it ([`plans-and-lists.md`](plans-and-lists.md) §5.11.1). |
| An RSVP, an accept step, or a decline on a list | There is no question to answer (§4a.1). Membership is binary; someone who does not want the list leaves it. |

---

## 8. Privacy rules a reviewer would check

Each is a specific, verifiable assertion.

| # | Rule | How it is verified |
| --- | --- | --- |
| P1 | A non-participant asking for an activity gets `404`, never `403`, so existence is not confirmed. | Integration test on `GET /v1/activities/:id` with a third user's token. |
| P2 | The public invite projection returns only the §4.2 allow-list. | Snapshot test with an explicit key allow-list; adding a key fails CI. |
| P3 | No endpoint returns another user's email except to the owner of the `Person` row holding it. | Contract review of every response schema; `email` appears only on `Person`, `Participant` (owner-scoped) and `/v1/me`. |
| P4 | An invite token cannot be enumerated. | 128 bits of entropy, base62. Rate limit of 30/min per IP on `/public/v1/*`. Invalid tokens return `404` with a constant-time-ish response and no distinguishing body. |
| P5 | Revoking an invite takes effect on the next request, with no cache window. | The public endpoint sets `Cache-Control: no-store`; CloudFront does not cache `/public/v1/*`. |
| P6 | Images are never publicly readable from S3. | Bucket is private with OAC; objects are served only through CloudFront at unguessable keys (`u/<userId>/<ulid>.<ext>`). A direct S3 URL returns `403`. |
| P7 | A declined participant retains no detail read access. | Their `ActivityIndex` entry is rewritten as a declined read-only projection (the durable Plans row that carries `Rejoin`, §3.2 — an index row, not detail access); the `PART#` row's `rsvp` is `declined`; the authorisation middleware treats `declined` as a participant for RSVP changes (including `Rejoin`) only, and `404`s every other route. |
| P8 | Deleting an account removes or anonymises the user's data within 30 days. | `DELETE /v1/me` soft-deletes, purges after 30 days. Solo activities they own are deleted; owned shared plans with surviving participants are cancelled with notification and retained anonymised as read-only history (`Deleted user`), settled state intact; their participation in others' plans is replaced by the display name only, with `linkedUserId` cleared. Only Settlements concerning nobody but the deleted account are unwound before deletion — retained financial history never reopens ([`../02-architecture/auth.md`](../02-architecture/auth.md) §8). |
| P9 | Notes are never shared. `activity.notes` is owner-only, even on a shared plan. | Response schema for `GET /v1/activities/:id` strips `notes` for non-owners. Test with a participant token. |
| P10 | Location coordinates are not exposed publicly unless the owner wrote an address. | §4.3. Test with an activity that has `lat`/`lng` but no `address`. |
| P11 | Adding a person never notifies anyone other than that person. | No fan-out on `POST /v1/activities/:id/participants` beyond the added person and, for RSVP changes, the owner. |
| P12 | Guest email addresses are used only to send that guest's invite and updates for that plan. | SES sends are triggered only from invite creation and `plan_changed` / `plan_cancelled` on plans the guest is on. There is no marketing send path and no list export. |
| P13 | The device address book is never read, enumerated, uploaded or stored. Only the single contact the user picks is kept, as a `Person`. | The client calls `Contacts.presentContactPickerAsync()` and nothing else; a lint rule and a test fail the build on any other `expo-contacts` export, in particular `getContactsAsync` and `requestPermissionsAsync` (§2.3). |
| P14 | List content is never reachable without authentication. There is no public list route and no list field in any `/public/v1/*` response. | Route inventory test: every `/public/v1/*` handler is enumerated and none reads a `LIST#` partition. The invite projection allow-list (P2) already excludes lists. |
| P15 | A person invited to a list who has not signed up learns nothing about its contents. | The `list_invitation_email` template contains the inviter's display name, the list title and a store link, and is asserted by a snapshot test to contain no item titles. |
