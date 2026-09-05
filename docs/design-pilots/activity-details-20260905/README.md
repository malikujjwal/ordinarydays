# Activity details design pilot — checkpoint

Status: v1 produced and reviewed through browser checks; explicit whole-mock approval has not been recorded. This checkpoint does not authorize production implementation or contract amendments.

## Reviewable artifacts
- [Interactive mock v1](activity-mock-v1/index.html)
- [Mock behavior, checks and limitations](activity-mock-v1/README.md)
- [Before: activity detail](activity-evidence/01-meal.png)
- [Before: expanded notes](activity-evidence/02-notes-open.png)
- [After: notes editor](activity-mock-v1/v1-notes-light.png)
- [After: dark long-content editor](activity-mock-v1/v1-notes-dark-long.png)
- [Activity inspection findings](ACTIVITY-FINDINGS.md)
- [Earlier calendar findings, now parked](FINDINGS.md)
- [Historical process log](PILOT.md)

From the repository root, serve the mock with:

```sh
python3 -m http.server 8100 --bind 127.0.0.1 --directory docs/design-pilots/activity-details-20260905/activity-mock-v1
```

Preview: http://127.0.0.1:8100/ . Reuse the existing pilot server if running; do not stop an unknown service. The interactive mock needs only its HTML and bundled Newsreader font, whose license is included. The inspection export and its temporary fixture servers are not needed to run it and are not committed.

## Decisions and input
The user selected Activity details after initial calendar exploration. They reported that notes are difficult to discover and require tapping outside to save despite scarce blank space. This drove the visible Add/Edit notes entry, labeled bordered editor, explicit Save/Cancel, draft retention and more spacing. Inspection also motivated wrapping titles and clearer Repeat/Reminder edit cues.

Explicit notes saving is a proposed exception to blur-save, pending approval. Preserve title blur-save and existing scheduling, reminder, recurrence, permissions, relationships and content-section behavior. Removing the empty Related plan row remains a separate proposal; the implementation prompt should preserve current behavior unless authorized.

The user requested an implementation prompt and instructions for sharing the mock. The response incorrectly called the design approved and directed contract updates. Those words were premature: neither requesting the prompt nor committing this checkpoint establishes explicit approval. A later agent must establish approval of the specific version and proposed contract amendment before implementing from it.

## Evidence and limits
Inspection used an isolated copied web export with schema-valid in-memory fixtures. Its source revision was unknown; findings must not be represented as verified defects in the latest native build. Browser checks covered notes editing, blur retaining the draft, failed save, retry, discard confirmation, phone-width overflow and dark long content. All mock actions are in memory. Native keyboard avoidance, Dynamic Type, VoiceOver and device gestures remain unverified. Secondary mock dialogs deliberately simplify existing production capabilities.

## Workflow assessment so far
One initial mock; zero user-requested revision rounds. Target selection redirected the work, and the user's notes observation changed the saving model. Shared Maestro resources and a stopped backend complicated inspection; isolated fixtures avoided competing for the simulator. Some early calendar investigation became parked work. Approval language in the generated prompt was unnecessary confusion and is corrected here. Final acceptance criteria and implementation handoff remain pending explicit mock approval.

This archival commit contains no production, canonical-contract or workflow-instruction changes. Concurrent implementation changes in the main checkout are owned by other work and are excluded.

Archive verification: local Markdown links checked, extracted mock JavaScript syntax checked, staged whitespace and repository Biome checks passed. Commit hooks run the secret scan and commit-message check. Production/native tests are not applicable to this artifact-only checkpoint. The archived HTML adds explicit button types and registers its existing inline handlers for lint compatibility; no design revision is intended.
