> Historical inspection record. Later decisions and current status are in [README.md](README.md). Statements about pending work describe that inspection stage.

# Activity details pilot — inspection round 1

User explicitly changed pilot target from Plans to Activity details. Calendar questions and proposed direction are parked, not approved. No redesign version exists.

Evidence: isolated old web export, schema-valid in-memory fixtures; 390×844 dark viewport. Export revision unverified; do not claim these are confirmed defects in latest/native code. Current ActivityDetailScreen source inspected. No real-data writes, production changes, shared builds or simulator interaction.

Cases: scheduled Task, Meal with long notes and four prep tasks, undated General Plan, completed Task, skipped Task. Verified Notes expand/collapse, Reminder menu open/dismiss, reschedule open/dismiss, empty Related plan disclosure, Show all 4 prep expansion. Earlier Plan detail/back journey verified; new Task-specific return navigation, cold failure/retry, mutation failure, native pending/recurring/participant states remain to inspect or simulate in approved mock. No writes attempted because inspection server rejects mutations.

Findings:
1. Observed title readability defect in export: 'Sunday dinner with Maya and Jordan' clips in single-line editable header, with final name invisible at rest. Source title InlineText lacks multiline and defaults false. Full title available to accessibility but not visually. Proposed fix uses existing scalable title role, wraps at rest/editing while preserving inline field and blur-save contract. Evidence activity-evidence/01-meal.png.
2. Observed inconsistent editor affordances: Notes has chevron; Repeat and Reminder have neutral text values and no chevron, though both open sheets. Likely discoverability issue; not user-tested. Current caller supplies onPress to SettingRow without explicit disclosure role. Propose consistent existing SettingRow opening treatment, no new component/system. Evidence 05-task.png, 03-reminder.png.
3. Suspected unnecessary disclosure: Related plan None opens only explanatory copy; user can’t attach a plan here. Do not invent attachment behavior. Candidate simplify absent relationship presentation; contract implications must be discussed. Evidence 06-related-plan-empty.png.
4. Aesthetic/product tradeoff, not defect: recurrence and reminder are summarized below date and repeated as rows; supporting plan content starts lower down. Both are existing requirements. Do not remove/reorder simply to compact screen. Ask whether user's concern is hierarchy or discoverability before exploring changes.

What worked: primary Complete/Had it/Done action stays directly under date; Task secondary Snooze/Skip are visible; Notes has accessible full value and collapsed state; 4 prep tasks show first 3 then Show all 4; populated section has add action; completed Done/Undo differs from Skipped/Undo skip; undated Plan offers editable Not scheduled; date opens sheet and never inline editing. Future People row explicitly says Coming later.

Recommended first direction pending input: fix title readability and editor affordance consistency, preserving header/action ordering, warm tokens, supporting-section thresholds and inline editing. Scope main mock around a Plan rich enough to show Notes + Preparation, with simple Task and resolved-state toggles. Read prototype UI.md before building. One recommended version, no production implementation.

Existing requirements to preserve: owner editing authority; inline text blur-save; schedule sheet; own reminders only; type-derived completion labels; undo/scoped recurrence/capability semantics; Notes first; sections grow at 1–3/show-all thresholds; no fake future actions; no real-data writes. Any proposed altered section/summary/empty relationship behavior listed separately as pending amendment.

Workflow: user target selection changed direction before prototyping, saving premature mock work. 0 mock revisions. Fixture servers had stopped between sessions and were restarted on owned ports only. Extended harness with five validated cases, no dependencies or shared data. Next user input: priorities question pending. Need full state/accessibility verification in mock and native limitations in handoff.
