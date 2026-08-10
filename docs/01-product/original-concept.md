# Original product concept (source of truth for intent)

> This is the founder's original written concept, preserved verbatim in substance.
> Where this document and the engineering docs disagree on *mechanics*, the engineering
> docs win. Where they disagree on *intent*, this document wins — raise the conflict
> instead of silently resolving it.

## Product concept

The app is a **personal life planner** for capturing things you want to do, turning them
into actual plans, and coordinating them with other people when necessary.

The core idea is:

> **Capture it → organize it → schedule it → share it → do it → follow up.**

The app should not feel like Jira, Notion, or a corporate productivity dashboard. It
should feel like a lightweight organizer for everyday life.

The user-facing mental model stays very small:

**Today · Plans · Lists**

Everything else — meals, TV, events, expenses, people, reminders — is built
around those three concepts.

---

## 1. Activities

Every **Task** or **Plan** the user creates is stored as an **Activity**. A **List item** is
a separate `ListItem`. The explicit creation choice is persisted as `objectKind: 'task'`
or `objectKind: 'plan'`; the app never reconstructs intent from words, dates, or people.

Activity types are not rigid categories. They are **guides that make creation easier** by
exposing the appropriate fields and behavior.

| Explicit choice | Purpose                                     |
| ------------- | ------------------------------------------- |
| Task          | Something the user needs to accomplish      |
| Meal          | Something the user plans to eat/cook        |
| Watch         | Movie, show, or episode                     |
| Event         | Concert, appointment, festival, etc.        |
| Event        | Restaurant, hike, coffee, shopping, etc.    |
| General Plan  | Anything that does not fit the guided Plan kinds |

There is deliberately **no category-management system**. A user can always choose
**Plan → General** rather than having to create and manage new categories. Tasks remain
solo; coordinated work is a General or guided Plan.

## 2. Unified Add experience

A prominent **Add** button should be available throughout the application. Global Add asks
one plain-language question first: **Task / Plan / List item**. Plan then asks
**General / Meal / Watch / Event**; List item asks for its destination list. None
is selected or inferred, and General is a visible choice rather than a fallback.

Only after that selection can the user type naturally, take a photo, upload a screenshot,
or paste a link. Capture may suggest compatible fields on the selected form, but never the
object, Plan kind, people, sharing, destination, reminder/notification state, or save action.
A reminder comes only from its visible control or the user's explicitly saved default; words
such as `remind me` do not set one.

For example, after the user explicitly chooses **Plan → Watch**,
`Watch Severance with Alice Friday at 8` may suggest:

```
Watch
Severance
Friday · 8:00 PM
```

Alice is added only through the People picker. The selected Watch kind is not a suggestion.
The final button is `Save plan`. The same text after **List item → Movies to watch** creates
only a ListItem via `Add to Movies to watch`.

> **Activity types guide creation rather than restrict it.**

## 3. Progressive creation forms

The app should only show fields relevant to what is being created.

**Task:** Title, Date, Optional time, Reminder, Repeat, Related plan, Notes

**Meal:** Meal, Date/time, Breakfast/lunch/dinner/snack, People, Ingredients, Add selected
ingredients to Groceries

**Watch:** Movie/show, Season/episode, Date/time, People, Streaming service, optional
explicit `Also add a list item to <list name>` (off by default)

**Event:** Title, Date/time, Location, Description, People, Source image/link

**Event:** Place, Date/time, People, Location, Reservation details, Notes

**General:** Title, Date, Optional time, People, Reminder, Repeat, Notes

General Plans remain deliberately generic. They are stored as Activity `type: 'custom'`.

## 4. Today

**Today is the main screen.** Its job is simply: *What do I need to know or do today?*

Today does not own separate copies of activities. It is a generated view of activities
relevant to the current day.

```
TODAY

UP NEXT
Next timed activity

SCHEDULE
2:30 PM   ◇ Dentist appointment
5:30 PM   □ Pick up groceries
6:00 PM   □ Gym
7:30 PM   Meal · Chicken tacos
8:00 PM   Watch · Severance

ANYTIME
□ Submit insurance form
□ Call apartment office
```

> **Activity type determines behavior. Time determines where it appears on Today.**

A Meal, Task, Watch activity, appointment, or event can all occupy time.

## 5. Tasks

A task means: *Something I need to complete.* Tasks are the only activity type with a
checkbox directly in Today and other list views.

Tasks can have: no schedule, a date, a date + time, reminder, recurrence, snooze, skip,
related plan.

Tap the checkbox → complete. Tap anywhere else on the row → open task details.

## 6. Recurring tasks

Recurring tasks are first-class behavior. The user creates **one recurring activity**, not
hundreds of future tasks. Completing today's Gym only completes today's occurrence.
Tomorrow's Gym still exists.

Recurrence options: Daily, Weekdays, Weekly, Monthly, Every X days, Selected weekdays,
Custom.

Snoozing an occurrence should not change the recurrence:

```
Gym
Normally 6 PM
Today → Snooze until 8 PM
Tomorrow → still 6 PM
```

Recurring tasks may eventually support **fixed recurrence** (every Tuesday regardless of
completion) and **completion-relative recurrence** (three days after I last watered the
plants).

## 7. Plans

A Plan represents: *Something the user has decided is going to happen.* Plans may be
personal or shared. Examples: food festival, dinner, dentist appointment, watch night,
weekend trip, restaurant event.

Plans can contain: date/time, location, people, RSVPs, description, source image/link,
preparation tasks, related lists, expenses, notes, updates.

After the user explicitly chooses Plan and its visible kind, compatible fields can be
entered manually or assisted by natural language, a ListItem, a photo, a screenshot, or a
pasted link. None of those sources selects Plan or its kind.

## 8. Lists

Lists hold things the user wants to remember **without necessarily committing to when they
will do them**: Watchlist, Meals to try, Restaurants to try, Places to visit, Groceries,
Shopping, Packing, General lists.

`New list` shows an explicit style catalogue first — Blank, Checklist, Groceries,
Restaurants to try, Watchlist, Meals to try, and the other shipped styles. The user taps one, then accepts or
edits its visible title. List names never trigger string matching, template suggestions, or
fallback behaviour.

> **Lists and Plans are independent; `Plan this item` is an explicit optional bridge.**

```
Watchlist
Severance
        ↓ Plan this item · choose Watch
Watch Severance Friday at 8
        ↓ Plan
Friday
        ↓ Today
```

## 9. Plans can create lists

The relationship also works in reverse. A plan can produce preparation lists.

```
New York Trip

Packing
□ Charger
□ Jacket
□ Passport

Preparation
□ Book hotel
□ Buy tickets

Places to visit
- Central Park
- Museum
```

A meal can generate grocery items:

```
Chicken tacos
        ↓
Groceries
Chicken — Sunday dinner
Tortillas — Sunday dinner
Tomatoes — Sunday dinner
Milk — manually added
```

Plan-generated items retain their source. The app should **suggest** creating related
lists rather than generating lots of lists automatically.

## 10. List item → Plan

`Plan this item` copies compatible values into a new Plan draft once and leaves the ListItem
byte-identical. The action always asks for Plan kind with nothing pre-selected, then asks
**Just me / Choose people** with nothing pre-selected. List membership is never copied into
the Plan.

```
Restaurants to try
Zahav
```

becomes

```
Zahav
Planned Saturday · 7 PM
```

The current viewer gets a private navigation/state pointer to the Plan. Another list member
can make a different Plan from the same item without changing this row. Similarly:

```
Severance
Watching
Next session Friday · 8 PM
```

## 11. Meals

Meals are an activity guide rather than a standalone product. A user can save meals for
later, schedule meals, associate meals with people, connect ingredients to Groceries, and
mark a planned meal as completed.

The app should not initially become a nutrition tracker, a calorie tracker, or a complex
recipe-management system.

## 12. Watch / TV tracking

Users can maintain a Watchlist containing movies, shows, watching status, season, episode,
and completed progress.

```
Severance
Watching
S2 E4
```

The user can schedule `Watch Severance / Friday · 8 PM / with Alice`. Afterward,
**Watched** can update progress `S2 E4 → S2 E5`. The app may then suggest scheduling the
next episode, but should not automatically create it.

The app is not trying to replace TV Time or Trakt. Its differentiator is connecting:

> **What I want to watch → when I'll watch it → who I'll watch it with.**

## 13. Image-to-event creation

The user first chooses **Plan → Event**, then takes a picture of a poster, event page,
flyer, invitation, or screenshot. The app extracts compatible title, date, start time, end
time, location, description, price, and
ticket/registration link, then displays a **review screen**. Uncertain fields should be
highlighted.

The app must never silently schedule extracted information without confirmation.

After confirmation: Plan created → Invite friends / Share / Add to calendar / Keep
private. The original image can remain attached as context.

## 14. Sharing plans

Any appropriate Plan can become collaborative. When creating or viewing a plan: **Add
people**. Users with the app receive an in-app invitation and can respond Going / Maybe /
Decline. Once accepted, the Plan appears in their account.

## 15. People without the app

Requiring everyone to install the app would create too much friction. Non-users receive a
secure public link such as `app.com/invite/8FD92K...`.

The page can contain plan details, date/time, location, description, poster/image, Going /
Maybe / Decline, Add to Google Calendar, Add to Apple Calendar, Download .ics.

Account creation should not be required merely to participate. The plan page remains the
source of truth.

## 16. Calendar integration

Plans can be exported to external calendars: Google Calendar link, Apple Calendar, `.ics`.
Eventually deeper calendar integrations could synchronize updates, but this is not
necessary for the MVP.

## 17. Completion behavior

All activities can conceptually have a state: Saved, Scheduled, Active, Completed,
Skipped, Cancelled. But completion language should feel natural to the activity.

| Type        | Action                 |
| ----------- | ---------------------- |
| Task        | Complete               |
| Meal        | Had it / Cooked        |
| Watch       | Watched                |
| Event       | Attended               |
| Event      | Done                   |
| General     | Done, when appropriate |

## 18. Passed plans

Scheduled activities should not look like unfinished tasks forever. When an event passes,
it moves to `EARLIER TODAY`. Opening it may offer Done / Didn't happen, or for an event
"How did it go?" → Attended / Didn't go.

Users should not have to manually clean up every event simply because its scheduled time
passed.

## 19. Universal interaction behavior

> **Tap row → open details.** Never make a normal row tap silently change data.

- **Task checkbox** → complete task
- **Swipe** → quick contextual actions
- **Tap date/time** → reschedule
- **Share** → add people / share invitation
- **…** → edit / duplicate / delete / secondary actions

## 20. People

Once users collaborate, the app naturally develops a **People layer**. But this is not a
social network. There are no followers, feeds, likes, public profiles, or relationship
scores.

> **Shared Plans and Lists connect people.**

People data is derived automatically from explicit shared Plans, shared Lists and expenses;
it is never inferred from words in a title or note.

## 21. Person view

```
Alice
3 upcoming together
Alice owes you $42.50

UPCOMING
Dinner at Zahav      Aug 9
Food Festival        Aug 16
Watch Severance      Aug 23

RECENT
Movie Night          Attended · $18 unsettled
Beach Trip           Attended · Settled

LISTS TOGETHER
Groceries             14 items
Packing · New York     8 items
```

This screen answers *What are Alice and I doing together?*, *Do we owe each other
anything?*, and *What are we keeping together?*

## 22. People page

People does not need to be primary navigation. It can live under Profile or Search. Sort
by: upcoming shared plans, outstanding balances, recent shared activity. Shared-list
membership is shown but does not affect this relevance order.

## 23. Frequent collaborators

When adding participants or list members, show FREQUENT and RECENT people. No explicit
friend system is necessary — people emerge through explicitly shared objects.

## 24. Guests

A participant can be a **registered user** or a **guest**. A guest may have name, email,
invitation token, RSVP, expenses. If they later register using the same verified identity,
existing plans and expenses can be connected to the account rather than duplicated.

## 25. Expenses

Expenses belong primarily to **shared Plans**. Each expense records amount, paid by,
participants, equal/custom split, notes, per-debtor obligation state (`settledPersonIds`),
and a derived all-debtors `settled` rollup. The app calculates who owes whom.

## 26. Person-level balances

Plan-level expenses aggregate automatically into relationship balances. The simplified net
balance is convenient, but users must always be able to see the underlying expenses. No
unexplained balance number.

## 27. Settlement

The app tracks exactly which selected expense obligations the user considers settled. It
does not record the amount, method, reference, or number of transfers that happened outside
the app. Do not build bank integrations, Venmo integration, payment processing, credit
cards, personal budgeting, or financial analytics.

> **We did something together — who owes whom?**

## 28. Post-plan follow-up

Completion can trigger contextual next steps — update episode progress, suggest next
episode, mark meal completed, review expenses, complete today's recurring occurrence only.
These should generally be suggestions, not automatic side effects.

## 29. Notifications

Relevant for upcoming tasks, upcoming plans, invitations, RSVP changes, plan changes,
shared-plan updates, expense additions, unsettled expense reminders. Users should control
reminders per activity.

## 30. General Plans

General solves edge cases without adding category complexity: study session, meditation,
game night, practice guitar, read, call family. Eventually, frequently used General
Plans could become reusable **shortcuts** remembering title, typical time, recurrence and the
creator's reminder. A shortcut never stores or preselects people, audience, or sharing; those
remain explicit each time. This is a later personalization feature.

---

## The complete product flow

```
DISCOVER / REMEMBER
        ↓
CHOOSE OBJECT      Task · Plan · List item
        ↓
CHOOSE DETAIL      Plan: General / Meal / Watch / Event
                   List item: destination list
        ↓
CAPTURE FIELDS     Type · Photo · Screenshot · Link
        ↓
NAMED WRITE        Save task · Save plan · Add to <list>
        ↓
Activity or ListItem
        ↓
Plan/Task date reaches Today; `Plan this item` is an optional explicit bridge
        ↓
DO IT
        ↓
Complete / Attend / Watch / Eat
        ↓
FOLLOW UP          Progress · Expenses · Next activity
```

> **Save the things you want to do, turn them into real plans, and organize everything
> needed to actually do them — with other people when it matters.**

The strongest part of the concept is that meals, TV, expenses, lists, image scanning, and
people are not separate mini-apps. They all participate in the same planning lifecycle.

---

## Reference design

An early visual exploration exists at:
<https://claude.ai/design/p/83c4a4eb-57cd-48a4-b6a6-705fbe0327ff?file=Planner.dc.html&via=share>

Treat it as directional, not binding.
