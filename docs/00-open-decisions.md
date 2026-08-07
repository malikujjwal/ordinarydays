# Open decisions for the founder

Everything in the doc set is written as a decision so that agents are never blocked. Some
of those decisions were made *for* you during planning and deserve a look before Phase 0
starts. Nothing here blocks work; each item names the phase by which it must be settled.

Delete an item once you have confirmed or overridden it.

---

## Settle before Phase 0

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 1 | **Three tabs only.** People, Balances, Notifications and Settings all live under Profile. | The concept says the mental model stays at Today · Plans · Lists. Adding a People tab contradicts it. | Phase 0 |
| 2 | **One AWS account**, dev and prod as separate stacks inside it. | Free-tier allowances are per-account, so two accounts halve them. SES production review would also be needed twice. Revisit if you take on a collaborator. | Phase 0 |
| 3 | **Biome instead of ESLint + Prettier.** | One tool, much faster. The trade-off is thinner React Native-specific lint rules. This is the choice most likely to be reversed. | Phase 0 |
| 4 | **iPhone only at launch** (`supportsTablet: false`). | Avoids iPad screenshots and a second review surface. Web covers large screens. | Phase 0 |
| 5 | **Route 53 costs ~$0.50/month from day one**, so the real AWS floor is ~$1.10/month, not $0. | A custom domain needs a hosted zone. Cloudflare DNS would be free but adds a second provider. | Phase 0 |

## Settle before Phase 2

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 6 | **Overdue rule:** only non-recurring *tasks* roll forward onto Today, capped at 30 days back, collapsed after three rows. The stored date is never mutated. | Rolling everything forward turns Today into a guilt list, which the concept explicitly rejects. | Phase 2 |
| 7 | **Undo:** a 6-second toast for reversible actions, 10 seconds for bulk, a confirmation dialog and no undo for destructive ones. | | Phase 2 |
| 8 | **Multi-day plans create one activity on the first day.** No `schedule.endDate` in v1. | A weekend trip is modelled as a plan on the start date with prep tasks. Real date ranges are a larger change to the agenda query. | Phase 3 |
| 9 | **The API accepts the Cognito ID token, not the access token.** | Simpler, and the app has no resource-server scopes. Contrary to common guidance — worth a look. | Phase 1 |

## Settle before Phase 5

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 10 | **Web refresh tokens live in an `HttpOnly` cookie**, exchanged via three new `/public/v1/auth/*` endpoints, rather than `localStorage`. | `localStorage` is materially weaker against XSS. Costs three endpoints and a cookie domain. | Phase 5 |
| 11 | **Guests cannot see their own balance.** | The public invite page deliberately exposes nothing financial. A guest who owes money finds out from the person who invited them. | Phase 6 |
| 12 | **`visibility` is one-way** — a plan that has been shared stays shared. | Un-sharing raises "what does the other person still see?" questions with no clean answer. | Phase 5 |
| 13 | **`.ics` export uses UTC instants with no `VTIMEZONE`, and `METHOD:PUBLISH`, never `REQUEST`.** | `REQUEST` makes calendar clients treat the app as the meeting organiser and send replies to it. | Phase 5 |

## Settle before Phase 7

| # | Decision made | Why it was made this way | Settle by |
| --- | --- | --- | --- |
| 14 | **Model spend, not AWS, is what makes this product cost money** — roughly $110/month at 1,000 users versus about $3 of AWS. | Capture may need to sit behind a paid tier, a lower free quota, or on-device parsing for the simple cases. | Phase 7 |
| 15 | **No voice capture mode in v1.** | iOS dictation into the text field covers it at zero build cost. | Phase 7 |
| 16 | **Settlements are expense-scoped** — the amount is computed from the expenses you select, never typed freely. | The strictest reading of "no unexplained balance number". It forbids recording a bare "$50 paid", which some users will want. | Phase 6 |

---

## Genuine conflicts still open

These are contradictions the planning pass could not resolve. Each needs a call.

1. **Effort estimates versus task sizings.** The roadmap's headline is ~34 weeks across
   all nine phases, but summing the per-task S/M/L sizings gives ~683 agent-work-units,
   which at the stated ~20 AWU/week is closer to 34 weeks only if review never blocks.
   Either the sizings are optimistic or the elapsed estimate is. Re-baseline after
   Phase 0, when you have one real phase of data.
2. **51 tasks in Phases 0–4 have a table row but no detail subsection**, and are not on
   the "these are mechanical" lists. Phases 5–8 are complete. Either write the missing
   detail or extend the mechanical lists before an agent picks one of them up.
3. **Lambda power tuning is assigned twice** — `phase-04-ship-v1.md` P4-28 and
   `phase-08-followup-and-launch.md` P8-15. Delete one.
4. **`lefthook` and `dependency-cruiser`** are used in Phase 0 and are required CI checks,
   but are not in the `tech-stack.md` dependency table, which `CLAUDE.md` makes mandatory.
   Add them.
5. **Cost figures marked `[verify]`** in `cost-model.md` — DynamoDB on-demand rates,
   EventBridge Scheduler pricing, Route 53 query pricing and model token pricing were not
   independently confirmed and each links to its pricing page. Check them before quoting
   any of these numbers to anyone.

---

## The one thing that will actually bite you

New AWS accounts default to a **Free Plan** that **closes the account after six months**
and deletes everything in it. You must be on the **Paid Plan** (pay-as-you-go) for the
account to survive, and the always-free allowances apply on both plans anyway. This is the
first item in `03-implementation/phase-00-foundations.md` and it is the single most
expensive mistake available at this stage.
