# Open decisions for the founder

Everything in the doc set is written as a decision so that agents are never blocked. Some
of those decisions were made *for* you during planning and deserve a look before Phase 0
starts. Nothing here blocks work; each item names the phase by which it must be settled.

Delete an item once you have overridden it. An item you **confirm** moves to "Confirmed"
rather than being deleted, so the question is not re-opened later by someone who reads the
silence as an omission. Items with no answer yet move to "Deferred — revisit after launch",
where nothing is built for them.

---

## Settle before Phase 0

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 1 | **Three tabs only.** People, Balances, Notifications and Settings all live under Profile. | The concept says the mental model stays at Today · Plans · Lists. Adding a People tab contradicts it. | Phase 0 |
| 2 | **One AWS account**, dev and prod as separate stacks inside it. | Free-tier allowances are per-account, so two accounts halve them. SES production review would also be needed twice. Revisit if you take on a collaborator. | Phase 0 |
| 3 | **Biome instead of ESLint + Prettier.** | One tool, much faster. The trade-off is thinner React Native-specific lint rules. This is the choice most likely to be reversed. | Phase 0 |
| 4 | **iPhone only at launch** (`supportsTablet: false`). | Avoids iPad screenshots and a second review surface. Web covers large screens. | Phase 0 |

## Settle before Phase 1

No founder decisions remain open before Phase 1. The former Quick Add default was explicitly
rejected on 2026-08-07: Global Add asks for Task, Plan, or List item, and no word parser or
server default chooses on the user's behalf. See the Confirmed table and ADR-046.

## Settle before Phase 2

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 6 | **Overdue rule:** only non-recurring *tasks* roll forward onto Today, capped at 30 days back, collapsed after three rows. The stored date is never mutated. | Rolling everything forward turns Today into a guilt list, which the concept explicitly rejects. | Phase 2 |
| 7 | **Undo:** a 6-second toast for reversible actions, 10 seconds for bulk, a confirmation dialog and no undo for destructive ones. | | Phase 2 |
| 35 | **Reminders are capped at 3 per user per activity**, and a shared plan therefore has one schedule and up to 3 × 50 reminders. | Three covers "the night before, an hour before, when I need to leave". A fourth is a scheduling tool, and the cap is what keeps the Phase 5 EventBridge schedule count bounded per plan rather than per participant's imagination. ADR-047. | Phase 2 |

## Settle before Phase 3

These came out of the list-model change on 2026-08-07 (ADR-031 to ADR-035). The model itself
is settled; these are the judgement calls made underneath it that you have not looked at.

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 19 | **A new List's template/style is chosen explicitly before its title is saved. There is no template suggester.** | String matching is still guessing from words and can silently give a list the wrong behaviour. The catalogue is visible, nothing is pre-selected, and the chosen template may offer an editable title. No model, heuristic, fallback or typed name selects behaviour. | Phase 3 |
| 33 | **`Clear checked` shows no confirmation dialog.** It deletes immediately and offers a 10-second bulk undo toast. | This is the one place the additive/destructive rule in `01-product/interaction-contract.md` §1a.1 is knowingly not applied. Clearing checked items is the *completion* of a shopping trip, performed with a bag in one hand, on rows the user has already ticked one by one — a dialog asks them to confirm a decision they made ten times already. The undo window is the safety net, and it restores the items with their previous ranks. The count still appears, in the button (`Clear checked (7)`), so nothing is unstated. If real users report losing items, the answer is a longer undo window, not a dialog. | Phase 3 |

## Settle before Phase 4

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 9 | **The API accepts the Cognito ID token, not the access token.** | Simpler, and the app has no resource-server scopes. Contrary to common guidance — worth a look. | Phase 4 |
| 10 | **Web refresh tokens live in an `HttpOnly` cookie**, exchanged via three new `/public/v1/auth/*` endpoints, rather than `localStorage`. | `localStorage` is materially weaker against XSS. Costs three endpoints and a cookie domain. | Phase 4 |

## Settle before Phase 5

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 5 | **Route 53 costs ~$0.50/month once the domain is registered**, so the AWS floor becomes ~$1.10/month rather than $0. Nothing is deployed before Phase 4 and the domain is not registered until Phase 5, so AWS spend is $0 until then. | A custom domain needs a hosted zone. Cloudflare DNS would be free but adds a second provider. | Phase 5 |
| 17 | **The Lists index is a flat list of lists**, most recently used first, with no grouping, no sections and no folders. | Lists are now destinations rather than a queue, and a user may reasonably hold ten or fifteen. Flat is right at that size and wrong at forty. Grouping by slot, by behaviour or by "from a plan" are all available later; picking one now would be guessing. Watch the number of lists real users create before adding structure. | Phase 5 |
| 20 | **Every template-seeded List field is copied at creation with no backfill and no "update from template" affordance.** | Behaviour, capabilities, slot, icon and empty-state copy become values on the List (ADR-032); `templateKey` remains provenance only. The user may later change the supported settings explicitly, but a catalogue edit never changes an existing list underneath them. The consequence is deliberate drift between lists created from different catalogue versions. | Phase 5 |
| 36 | **The quiet-hours exception is a plan-change or date-change notification for an activity starting in under 12 hours.** Everything else is held to the morning digest. | The previous rule delivered only *cancellations* of imminent plans, and separately delivered a date change when the new date was today or tomorrow. Those are the same situation described twice, and the cancellation half was the narrower of the two for no reason — a plan moved from 8 AM to noon is exactly as actionable as one called off. One rule, one clock threshold, keyed on when the activity starts rather than on which field changed. | Phase 5 |

## Settle before Phase 6

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 12 | **`visibility` is one-way** — a plan that has been shared stays shared. | Un-sharing raises "what does the other person still see?" questions with no clean answer. | Phase 6 |
| 13 | **`.ics` export uses UTC instants with no `VTIMEZONE`, and `METHOD:PUBLISH`, never `REQUEST`.** | `REQUEST` makes calendar clients treat the app as the meeting organiser and send replies to it. | Phase 6 |
| 24 | **A shared list caps at 20 people total, including the owner and pending invitations**, against 50 for a plan. | A household feature, not a broadcast one. The lower number keeps the roster bounded and unpaginated. If a real user hits it, the number is a constant, not a design. | Phase 6 |
| 25 | **Item writes on a shared list carry no `If-Match`**; list-level edits do. | `If-Match` on every checkbox in a grocery list produces constant spurious `409`s. The cost is that two people editing the same item's *title* in the same minute means one of them silently loses their text, with no signal. Checking is unaffected — it is a set, so it converges. This is the one place the product accepts silent data loss, and it is worth confirming rather than inheriting. | Phase 6 |
| 26 | **A shared plan suggests sharing its generated lists and never does it automatically**, and the row is unticked on every template. | Packing is the case that decides it: three people ticking one `Charger` row is actively wrong. Groceries usually should be shared. The app cannot tell from the template, so it asks once and defaults to the answer that loses nothing. Tempting to pre-tick for "obviously shared" templates; the first time that is wrong it shares something private. | Phase 6 |
| 34 | **Date suggestions cap at 5 per activity, and `worksFor` is the only reaction-shaped thing in the product.** Any participant proposes; only the owner schedules; suggestions are deleted once a date lands. | Five keeps it a nudge toward a date. Six or more is a scheduling poll, and a poll needs closing rules, tie-breaks, a deadline and a notification cadence — all of which contradict "Needs a date never nudges". `worksFor` earns its place by being the actual coordination signal rather than sentiment; it is availability, not a vote, and it is explicitly not consent, which is why scheduling from a suggestion still resets every RSVP. ADR-049. | Phase 6 |

## Settle before Phase 8

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 14 | **Model spend, not AWS, is what makes this product cost money** — roughly $110/month at 1,000 users versus about $3 of AWS. | Capture may need to sit behind a paid tier, a lower free quota, or on-device parsing for the simple cases. | Phase 8 |
| 15 | **No voice capture mode in v1.** | iOS dictation into the text field covers it at zero build cost. | Phase 8 |

## Settle before Phase 9

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 40 | **Block and report are deferred, but are a public-launch gate, not a post-launch nicety.** Nothing today stops a person who holds your email from re-adding you to plans (push on by default) and lists (no accept step) indefinitely; leaving does not prevent re-adding, and `invitation_reminder` chases pending invites. Sketch on file: a per-Person block that silently drops that person's adds and invites, plus a report path (mailto is acceptable for v1). The updates feed is user-generated content shared between accounts, so App Store review (Guideline 1.2) is likely to ask for exactly this. Decided 2026-08-07: defer the build, settle the design before the Phase 9 submission. | Interpersonal abuse is real but rare at private-beta scale; the machinery (a `blockedPersonIds` check in the invite/add paths) is additive and needs no migration, so deferring costs nothing structurally. | Phase 9 |
| 18 | **Users cannot author their own templates.** The catalogue ships with the app. | A template is a reusable preset for chooser copy, default title, behaviour, capabilities, slot, icon and empty-state guidance. Users can customize the supported List settings—behaviour, capabilities and slot—but cannot author or reuse a new preset, and icon/guidance remain the copied presentation. Template authoring would need management, sharing and versioning surfaces for a want nobody has expressed yet. Revisit if users keep recreating the same configuration. | Phase 9 |
| 21 | **The default-slot set is closed at three** — `groceries`, `watch`, `meals` — matching the three cross-entity flows that exist. | A slot with no flow behind it is a setting that does nothing. A fourth slot should follow a fourth flow, not precede it. | Phase 9 |

---

## Confirmed

Ruled on rather than left open. Kept here so the question is not re-opened by someone who
reads it as an omission.

| # | Decision | Confirmed | Recorded in |
| --- | --- | --- | --- |
| 8 | **Multi-day plans create one activity on the start date. No `schedule.endDate` in v1.** Re-litigated in the review of 2026-08-07 and **upheld**. The consequence is stated rather than designed around: a three-day trip **does not appear on Today on days two and three**, and no v1 screen, example, mock or fixture may show a date range. Prep tasks, which have their own dates, land on the days they belong to. | 2026-08-07 | [`02-architecture/decisions.md`](02-architecture/decisions.md) ADR-050, [`02-architecture/data-model.md`](02-architecture/data-model.md#10-what-is-deliberately-not-modelled-in-v1) §10, [`02-architecture/feature-to-schema-map.md`](02-architecture/feature-to-schema-map.md#11-where-the-model-is-under-real-tension) §11 |
| 11 | **Guests cannot see their own balance**, and this is intentional. The public invite page exposes nothing financial, there is no expense-sharing link, and a guest who owes money is told by the person who invited them, out of band. | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md#66-guests-with-expenses-but-no-account) §6.6, [`01-product/sharing-and-people.md`](01-product/sharing-and-people.md#43-fields-the-public-projection-must-never-expose) §4.3 |
| 32 | **Creation intent is explicit.** Global Add asks `Task`, `Plan`, or `List item` with nothing selected. Only a labelled contextual action fixes the target: Today `Add a task`, Plan detail `Add a prep task`, or an open List `Add an item`; the Plans tab still uses Global Add. New List also requires a visible template/style choice. Words, heuristics and models never choose or change object kind, Plan type, List behaviour, destination List, participants or sharing state. | 2026-08-07 | [`01-product/activities.md`](01-product/activities.md) §2, [`01-product/plans-and-lists.md`](01-product/plans-and-lists.md) §5, [`02-architecture/decisions.md`](02-architecture/decisions.md) ADR-046 |
| 16 | **Settlement is an expense-scoped status change, not a payment record.** The user selects obligations they consider settled and the app computes their total. It never captures the external payment amount, method, reference, remainder or credit. | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md#61-semantics) §6.1 |
| 22 | **Rounded or partial external payments need no app behaviour.** Ordinary Days never asks what amount moved outside the app, so there is no remainder to drop or allocate. A single expense remains unsettled until the user considers that obligation fully resolved. | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md#63-settling-only-some-expenses) §6.3 |
| 37 | **Sharing money creates the People substrate.** When an expense's payer + split set contains a pair of participants who do not yet hold each other as People, the expense transaction creates the missing `Person` rows — the same `personId` mirrored into each affected registered user's partition, display name only, no contact details; a guest's mirrored side waits for account linking. Without this, two non-owner co-participants could owe each other money that no balance, Person view or settlement path could represent. | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md) §5.1, [`01-product/sharing-and-people.md`](01-product/sharing-and-people.md) §6.1, [`02-architecture/data-model.md`](02-architecture/data-model.md) §7, [`02-architecture/feature-to-schema-map.md`](02-architecture/feature-to-schema-map.md) §9 |
| 38 | **Recurrence is a list of append-only rule segments on the one series row.** An "all future occurrences" edit appends a segment (`effectiveFrom` = the date it takes effect); past segments are immutable, expansion picks the segment in force per date, and stored history therefore always renders under the rule and time in force when it was written. Max 20 segments. Whole-series delete must name the count of past completions destroyed; `End series` (close as of today, keep everything) is the gentler primary affordance. | 2026-08-07 | [`01-product/today-and-tasks.md`](01-product/today-and-tasks.md) §6.2, [`01-product/activities.md`](01-product/activities.md) §6.4, [`02-architecture/data-model.md`](02-architecture/data-model.md) §4.2 and §6 |
| 39 | **"Move an item between lists" is cut from v1.** The item sheet does not offer it; the workaround is copying the text into the other list and deleting the original. Revisit only against a real user request. P3-11 is marked cut in the Phase 3 table. | 2026-08-07 | [`01-product/plans-and-lists.md`](01-product/plans-and-lists.md) §5.6, [`03-implementation/phase-03-plans-and-lists.md`](03-implementation/phase-03-plans-and-lists.md) |
| 41 | **Plans → Past is permanent.** The 60-day GSI archival sweep strips index attributes from undated terminal items (`#N`/`#P`) only and never touches `#S` — a past dated row is product history, not a rolling window. | 2026-08-07 | [`01-product/plans-and-lists.md`](01-product/plans-and-lists.md) §1.3, [`02-architecture/data-model.md`](02-architecture/data-model.md) §3.5, [`03-implementation/phase-09-followup-and-launch.md`](03-implementation/phase-09-followup-and-launch.md) P9-33 |
| 42 | **Prep tasks on a shared plan surface on the creator's Today only**; the plan is the shared surface, and any participant may still complete a prep task from plan detail. Completing a plan leaves open prep tasks untouched and offers one dismissible follow-up (Keep / Complete all / Delete). A departing participant's own prep tasks detach to them. | 2026-08-07 | [`01-product/plans-and-lists.md`](01-product/plans-and-lists.md) §3, [`01-product/sharing-and-people.md`](01-product/sharing-and-people.md) §3.4 |
| 43 | **A shared plan with participants is cancelled before it can be deleted**, and destructive dialogs name the money: deleting a plan states expense count, totals per currency and unsettled amounts; deleting a Person states any outstanding balance. Guests hitting a removed plan's link see "This plan was removed", never a blank 410. | 2026-08-07 | [`01-product/interaction-contract.md`](01-product/interaction-contract.md) §1a.1, [`01-product/sharing-and-people.md`](01-product/sharing-and-people.md) §2.1/§4.6 |
| 44 | **The suggested settle-up is pairwise, not minimised.** One line per nonzero debtor→creditor pairwise net, never rerouted — every suggested payment is recordable through pairwise settlement. | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md) §4, [`03-implementation/phase-07-people-and-expenses.md`](03-implementation/phase-07-people-and-expenses.md) P7-05 |
| 45 | **Financial history is two-sided and survives everything** (the Splitwise rule): settled lines show who marked them and when; settlement history includes counterparty-recorded settlements (derived read, undo stays creator-only); expense edits keep old → new amounts in the feed; account purge retains shared-plan expenses and settlement audit rows anonymised as "Deleted user". | 2026-08-07 | [`01-product/expenses.md`](01-product/expenses.md) §2.3/§5.3/§6.5, [`02-architecture/auth.md`](02-architecture/auth.md) §8, [`02-architecture/data-model.md`](02-architecture/data-model.md) §7 |
| 46 | **No push actions in v1.** Pushes deep-link only; no Snooze/Complete/RSVP buttons on notifications. Revisit at Phase 9. | 2026-08-07 | [`01-product/notifications.md`](01-product/notifications.md) §7 |
| 49 | **The visual language follows the founder's Claude Design mock ("Planner", 2026-08-08), loosely.** Warm cream and olive-tinted neutrals, mulberry accent, olive success / ochre warning, Newsreader serif for `display`/`title` only (bundled latin subset; body stays the system sans), rounder radii, soft warm shadows — and the three tabs intentionally differ in presentation: Today is a timeline (NOW divider, day progress line, UP NEXT hero card), Plans renders **event cards** (reversing the 2026-08-07 rows decision), Lists is a grid of collection cards. Behaviour contracts are untouched; where the mock and the specs disagree on behaviour (date ranges, an Invitations tab), the specs win. Mock-derived values that failed AA were nudged and are marked; dark mode is derived, pending the P1-22 gallery review. | 2026-08-08 | [`04-conventions/design-system.md`](04-conventions/design-system.md) (whole document), [`01-product/plans-and-lists.md`](01-product/plans-and-lists.md) §1.3.1 |
| 47 | **The device timezone is authoritative by default.** On foreground a device/profile mismatch updates the profile timezone (server included) with a dismissible banner; `Lock to home timezone` opts out. Timed activities are unaffected — they store their own zone and convert per viewer. | 2026-08-07 | [`01-product/today-and-tasks.md`](01-product/today-and-tasks.md) §6.6 |

## Deferred — revisit after launch

Real cases with no answer yet. **Nothing is built for these.** An agent who meets one
implements nothing and leaves the behaviour as documented; the alternative is a guess
shipped as a feature.

| # | Case | Candidate answers | Deferred on |
| --- | --- | --- | --- |
| 23 | **Two people watching a show together do not share episode progress.** Each person keeps their own `season`/`episode` and each is offered their own progress follow-up after a shared session. Neither sees the other's. Shared lists change the premise — two people **can** now hold one watchlist — but not the answer: a shared `watch` list has one `watchStatus` and one episode number per item, so it records the *list's* progress, not each member's. | Not yet explored. It needs a per-member progress shape on a shared item, a rule for whose completion advances it, and a UI that shows two numbers without becoming a tracker. All three are larger than the symptom. | 2026-08-07 |
| 27 | **Read-only list viewers.** There are two roles, `owner` and `member`, and every member can write. Somebody who should see a list without editing it — a partner watching the packing list, a friend given the restaurant list — has no role. Today the answer is "add them as a member and trust them", or "screenshot it". | (a) A third `viewer` role: one enum value, one branch in the item routes, one more state in the share sheet. Cheap to add because the roles are stored, so it is additive, not a migration. (b) Leave it: two roles is the simplest thing that works for the household case, and every extra role is a branch in every write path. Decide against a real request, not in advance. | 2026-08-07 |
| 28 | **A public read-only link for a list**, the equivalent of the invite page for a plan — "here are the restaurants we liked, no account needed". | Not designed, and it is a bigger change than it looks: it would give lists a public projection, a token, a rate limiter and a leak surface, all of which they currently do not have (ADR-043). It also raises a question plans do not have, because a list is *live* — a link handed out on Tuesday shows whatever the list says on Friday. Any answer needs a snapshot-versus-live decision first. | 2026-08-07 |
| 29 | **Whether a needs-a-date plan should ever expire, archive itself, or be hidden.** A plan nobody has scheduled in eight months sits in Needs a date forever, and the stage grows monotonically. | (a) Nothing — the current behaviour. Age is deliberately not a signal in that stage, nothing nudges, and the sort is by most-recently-discussed so the stale ones sink on their own. (b) An explicit user action — `Archive`, `Not now` — which is a button, not a policy, and would need a place to put archived plans. (c) Automatic expiry, which is the one to be careful of: silently removing something the user wrote down is the opposite of the product's posture, and "you had six months" is a deadline nobody agreed to. The 60-day GSI archival sweep (P9-33) deliberately does **not** touch `#P`. | 2026-08-07 |
| 30 | **Whether active list sharing should ever count toward the People page relevance sort.** That sort is upcoming shared plans → outstanding balance → recency. The implemented `LLINK#` projection already supplies `sharedListCount` and `LISTS TOGETHER`, but deliberately does not affect order. | (a) Add `sharedListCount` as a relevance key using the existing active links; this is now a product-ordering decision, not a missing-index problem. (b) Fold the original share's `addedAt` into recency, which risks making a permanent grocery list look like recent human activity. (c) Keep it as a summary fallback only: edits never bump a Person and list-only contacts sort stably by name. Measure before changing a predictable order. | 2026-08-07 |
| 31 | **Per-participant completion.** Completion of a **plan** is global and owner-only: an `Occurrence` says *the thing happened*, not *I attended*, and only the owner may complete, skip or snooze (ADR-048, amended by ADR-051 — a prep task is a shared checklist item and any participant of its parent may tick it, which is a separate rule and not a per-participant occurrence). Five people go to a dinner, one does not, and there is no way for that person to record it. Today the answer is that they set their RSVP to `declined`, or leave the plan, and the owner still says whether the dinner happened. | Doing it properly is not a flag. It needs (a) the occurrence key to become `OCC#<date>#<userId>`, which is a stored-key change and therefore a migration after Phase 5; (b) the agenda expansion to answer "whose occurrence is this?" on every row of every day, so the merge step in `data-model.md` §6 gains a caller dimension it does not currently have; (c) a defined rendering for the intermediate state — an activity completed for two people and pending for three — on Today, in Plans, on the plan detail and in the `.ics` export; (d) a rule for what the *owner's* completion then means, because "the dinner happened" and "I went to the dinner" become different facts on the same row; and (e) a decision about whether a participant's completion writes anything the owner can see, which is a product question about surveillance, not a schema question. That is a phase of work, not a task. Defer until somebody asks for it in those terms. | 2026-08-07 |
| 48 | **Multi-item capture** ("call mom tomorrow, dentist next week, buy milk" in one pass, confirmed item by item). Cut from v1 on 2026-08-07: the promised row was removed from `01-product/interaction-contract.md` §1a.2, `ParsedCapture` stays a single draft, and capture remains one explicit object choice per item. | Speccing it properly needs a multi-draft response shape, a review-list screen, and per-item accept/reject on the Phase 8 hot path — real design work for a flow single-item capture already covers less conveniently. Revisit against usage data after launch. | 2026-08-07 |

---

## Genuine conflicts still open

These are contradictions the planning pass could not resolve. Each needs a call.

1. ~~**Effort estimates versus task sizings.** The roadmap's headline of ~34 weeks did not
   match the summed per-task sizings.~~ **Resolved:** `03-implementation/roadmap.md` §4.2
   and §4.3 recompute the plan from the sizings — **360 tasks, 859 AWU, ~43 weeks** (re-summed 2026-08-07 after the Phase 3 sizing correction and the P3-11 cut: **359 tasks, 858 AWU, ~43 weeks**) — and
   itemise the thirteen corrections that produced the change. That is the plan of record.
   Re-baseline after Phase 0, when you have one real phase of data.
2. ~~**30 tasks in Phases 2, 3 and 5 have a table row but no detail subsection**, and are not
   on the "these are mechanical" lists.~~ **Resolved 2026-08-07:** the actual shortfall was
   28 (11 in Phase 2, 11 in Phase 3, 6 in Phase 5; the earlier "13 in Phase 3" tally was
   stale). All are now closed: P3-11 was cut (Confirmed #39) and the remaining 27 detail
   subsections were written — P2-03/07/12/14/18/21/25/27/29/36/37,
   P3-19/22/24/25/29/30/31/39/40/41, and P5-11/16/18/19/20/24. Every phase now has a
   detail subsection or a mechanical-list entry for every task. Sensible defaults chosen
   during drafting are marked "(decision recorded here — raise in PR if wrong)" in place.
3. ~~**Lambda power tuning is assigned twice.**~~ **Resolved 2026-08-07:** Phase 5 (P5-33)
   picks an initial memory setting from a synthetic curve; Phase 9 (P9-15) closes OQ-3 against
   real traffic. Measuring twice is deliberate.
4. ~~**`lefthook` and `dependency-cruiser`** are missing from the `tech-stack.md`
   dependency table.~~ **Resolved:** both are now in `tech-stack.md` §2.5.
5. **Cost figures marked `[verify]`** in `cost-model.md` — DynamoDB on-demand rates,
   EventBridge Scheduler pricing, Route 53 query pricing and model token pricing were not
   independently confirmed and each links to its pricing page. Check them before quoting
   any of these numbers to anyone.
6. ~~**A fourth transactional email, against a product doc that says there are three.**~~
   **Resolved 2026-08-07:** `01-product/notifications.md` §6.3 now lists four SES sends —
   guest invitation, plan changed, plan cancelled, and `list_invitation_email` to somebody
   with no account who has been added to a shared list, as `02-architecture/api-contract.md`
   §2.7 requires. The SES production-access description (P6-02) and the P6-04 send-function
   count both read four.
7. ~~**Two notification keys used but not catalogued.**~~ **Resolved 2026-08-07:**
   `plan_date_set` and `plan_date_changed` are now rows in `01-product/notifications.md` §7,
   in the `plan_changes` category, with their triggers and copy. They replace `plan_changed`
   for that change; exactly one of the three is ever sent.

---

## The one thing that will actually bite you

New AWS accounts default to a **Free Plan** that **closes the account after six months**
and deletes everything in it. You must be on the **Paid Plan** (pay-as-you-go) for the
account to survive, and the always-free allowances apply on both plans anyway. This is the
first item in `03-implementation/phase-00-foundations.md` and it is the single most
expensive mistake available at this stage.
