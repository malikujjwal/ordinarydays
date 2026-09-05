> Historical inspection record. Later decisions and current status are in [README.md](README.md). Statements about pending work describe that inspection stage.

# Ordinary Days collaborative UI pilot

Status: scope and priorities requested; no design direction or mock approved.

User boundary: inspection, discussion, isolated prototype, iteration, then approved handoff only. No production implementation, canonical contracts, workflow edits, dependency additions, or real-data mock writes.

Baseline: HEAD dd22fd5e209bac848fc415fbb1bd9c52892e6b40 with pre-existing working-tree changes, including calendar/navigation changes. Existing exported bundle revision is unverified and must not be represented as current HEAD.

Resources: other task owns iPhone 16 Pro simulator (iOS 26.5); observed detail screen only, no navigation performed. Existing API/proxy ports 3000/3001/8474 left alone. Private export copied to current-export; route-aware repository server copied to serve-current.mjs and bound to 127.0.0.1:8098. Initial generic server on 8097 is unnecessary and can be stopped. Export embeds API port 3100, which was not listening. No builds or shared fixture mutations performed.

Observed evidence: private web /plans showed accessible Loading plans indicator, then Couldn't load this. and Try again. Screenshots emitted in conversation. Environment failure, not established product defect. Native simulator had a test plan detail open; complete journey has not been walked.

Candidate scope recommended for user selection: Plans distant date -> day landing -> detail -> return -> Today. Alternatives: Today/task detail; Lists/add/item detail.

Preliminary code-only questions, not validated usability defects:
- DayCell.tsx marks isToday but receives no selected date and exposes no selected accessibility state. Test whether users can identify their chosen day after landing.
- CalendarNavigator MonthYearSheet copy uses internal concepts: 'The stage decides what this offers, not the month on screen.' Test simpler explanation while retaining directional restrictions.
- CalendarNavigator has no explicit jump-to-current-day control; clarify whether returning to Today means Today tab or resetting Plans calendar. Treat any added control as proposed behavior pending user input.

Existing requirements to preserve for calendar: Needs a date / Upcoming / Past order, today eligible only in Upcoming, day selection never writes or switches stage, known versus unknown Past coverage, same projection for list and density, exact-day landing below overlay, bounded loading before fallback, retained cached content with retry, locally remembered calendar expansion, no animated traversal through distant rows, accessible targets/focus and reduced motion.

Pending: user chooses journey/priorities; then finish relevant document reading, obtain populated read-only or isolated fixture inspection, state coverage and visual evidence, conduct direction interview, and only then build v1. Mock must use realistic in-memory fixtures with explicit simulated loading/error/empty/long/populated state controls. No approval has been given.

Workflow observations: shared native resource constrained inspection; existing web export pointed to stopped API; generic static server did not support Expo extensionless routes, so switched to repository route-aware server. Revisions: 0. User design inputs beyond initial boundaries: none yet.

## Isolated inspection setup completed
User authorized isolating fixtures/server after identifying concurrent Maestro work. Copied export API URL now points to 127.0.0.1:8099; original export unchanged. Fixture API has no upstream/database connection and rejects POST/PATCH/DELETE (verified 405). Schema validation passed for profile, populated/empty initial and distant upcoming/past windows, and all generated activity details. Browser verified populated Plans -> detail -> Back. Controls at http://127.0.0.1:8099/ select populated/empty/slow/error, followed by app reload; cached state may remain visible on refresh failures, intentionally following current app behavior. Lists currently uses empty fixtures; richer Lists fixture coverage awaits scope selection. This is a current-UI inspection harness, not redesign v1. Source bundle revision still unverified. Generic port 8097 server stopped.
Launch API: node /private/tmp/od-ui-pilot-20260904/fixture-api.mjs
Launch UI: node /private/tmp/od-ui-pilot-20260904/serve-current.mjs

## Inspection round 1
User directed starting the original prompt. Assumed Plans distant-date journey, announced scope. See FINDINGS.md and evidence/*.png. Walked distant Upcoming/Past, detail/back, empty-day neighbor, Today, loading/error/retry and all-empty. Recommended direction pending user input; no mock approval. Scope now Plans unless user redirects.

## Target changed by user: Activity details
Calendar findings retained as parked investigation. Activity details is active. See ACTIVITY-FINDINGS.md and activity-evidence/. Five new detail fixtures validated. Server launch commands unchanged; detail-cases.mjs supplies added fixtures. No design approved, mock revision count remains zero. Priority question pending.
