# Activity details design pilot — checkpoint

Status: v1 and v2 produced and reviewed through browser checks; explicit whole-mock approval has not been recorded for either. This checkpoint does not authorize production implementation or contract amendments.

## Reviewable artifacts
- [Implementation prompt](IMPLEMENTATION-PROMPT.md)
- [Interactive mock v2 — the type-specific details](activity-mock-v2/index.html)
- [v2 rationale, decisions, conflicts and checks](activity-mock-v2/README.md)
- [Interactive mock v1](activity-mock-v1/index.html)
- [Mock behavior, checks and limitations](activity-mock-v1/README.md)
- [Before: activity detail](activity-evidence/01-meal.png)
- [Before: expanded notes](activity-evidence/02-notes-open.png)
- [After: notes editor](activity-mock-v1/v1-notes-light.png)
- [After: dark long-content editor](activity-mock-v1/v1-notes-dark-long.png)
- [Activity inspection findings](ACTIVITY-FINDINGS.md)
- [Earlier calendar findings, now parked](FINDINGS.md)
- [Historical process log](PILOT.md)

From the repository root, serve the mocks with:

```sh
python -m http.server 8101 --bind 127.0.0.1 --directory docs/design-pilots/activity-details-20260905
```

Preview <http://127.0.0.1:8101/activity-mock-v1/> and <http://127.0.0.1:8101/activity-mock-v2/>. The server root is the pilot folder, so both mocks share the one bundled Newsreader font, whose license is included; v2 borrows it rather than duplicating the binary. A `design-pilot` entry in `.claude/launch.json` runs exactly this command. Reuse the existing pilot server if running; do not stop an unknown service. The inspection export and its temporary fixture servers are not needed to run either mock and are not committed.

## What v2 adds

v1 addressed the notes editor. It did not touch the type-specific details, and the
`ACTIVITY-FINDINGS.md` inspection did not look for them.

v2 renders them. `ActivityDetailScreen.tsx` touches `activity.details` in exactly two places,
both meal ingredients, so a Watch plan loses its season and episode, a Meal loses its recipe
link, and an Event loses its reservation, tickets, organiser and public description the moment
it is saved. The pasted `sourceUrl`, the `listId` backlink and the parent plan's name are
unrendered too.

It also makes them **editable**, because everything else on that screen is and the API already
accepts `details` on `PATCH /v1/activities/:id`. Editing is section-level, and one sheet per
type carries the whole `details` object — `PATCH` replaces it wholesale, so a partial save
would silently drop the rest. Its proposal, its thirteen raised conflicts and its verification
are in [activity-mock-v2/README.md](activity-mock-v2/README.md). Nothing in it is approved, and
it changes no production code.

## Decisions and input

**2026-09-09, founder — Task detail gains an `Add to this task` row.** Task detail has no chip
row today (`AddToPlanRow` is plans-only), so a Task whose `sourceUrl` was empty could not reach
it. `Link` is the only chip a task can carry: no prep children, no lists, no attachments
(`today-and-tasks.md` §5.6). That section still describes the screen as lacking the affordance,
and must be amended by whoever implements this.
The user selected Activity details after initial calendar exploration. They reported that notes are difficult to discover and require tapping outside to save despite scarce blank space. This drove the visible Add/Edit notes entry, labeled bordered editor, explicit Save/Cancel, draft retention and more spacing. Inspection also motivated wrapping titles and clearer Repeat/Reminder edit cues.

Explicit notes saving is a proposed exception to blur-save, pending approval. Preserve title blur-save and existing scheduling, reminder, recurrence, permissions, relationships and content-section behavior. Removing the empty Related plan row remains a separate proposal; the implementation prompt should preserve current behavior unless authorized.

The user requested an implementation prompt and instructions for sharing the mock. The response incorrectly called the design approved and directed contract updates. Those words were premature: neither requesting the prompt nor committing this checkpoint establishes explicit approval. A later agent must establish approval of the specific version and proposed contract amendment before implementing from it.

## Evidence and limits
Inspection used an isolated copied web export with schema-valid in-memory fixtures. Its source revision was unknown; findings must not be represented as verified defects in the latest native build. Browser checks covered notes editing, blur retaining the draft, failed save, retry, discard confirmation, phone-width overflow and dark long content. All mock actions are in memory. Native keyboard avoidance, Dynamic Type, VoiceOver and device gestures remain unverified. Secondary mock dialogs deliberately simplify existing production capabilities.

## Workflow assessment so far
One initial mock; zero user-requested revision rounds. Target selection redirected the work, and the user's notes observation changed the saving model. Shared Maestro resources and a stopped backend complicated inspection; isolated fixtures avoided competing for the simulator. Some early calendar investigation became parked work. Approval language in the generated prompt was unnecessary confusion and is corrected here. Final acceptance criteria and implementation handoff remain pending explicit mock approval.

This archival commit contains no production, canonical-contract or workflow-instruction changes. Concurrent implementation changes in the main checkout are owned by other work and are excluded.

Archive verification: local Markdown links checked, extracted mock JavaScript syntax checked, staged whitespace and repository Biome checks passed. Commit hooks run the secret scan and commit-message check. Production/native tests are not applicable to this artifact-only checkpoint. The archived HTML adds explicit button types and registers its existing inline handlers for lint compatibility; no design revision is intended.
