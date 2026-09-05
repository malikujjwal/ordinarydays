# Activity details — mock v1

Status: awaiting user review; not approved for implementation.
Preview: http://127.0.0.1:8100/
Run: python3 -m http.server 8100 --bind 127.0.0.1 --directory docs/design-pilots/activity-details-20260905/activity-mock-v1

## Direction and evidence
User reported that the notes field is hard to find, blur-to-save requires tapping scarce blank space, and the screen feels crowded. This drove a visible Edit/Add notes action, labeled bordered editor, explicit Save notes and Cancel, and spacing around the editing controls. Inspection additionally found clipped titles in the copied web export and weak edit cues on Repeat/Reminder. v1 wraps titles and adds action-colored values and chevrons. The source export revision is unknown; these observations are not proof of current native defects. Earlier evidence is in ../ACTIVITY-FINDINGS.md and ../activity-evidence/.

## Proposals requiring review
- Notes explicitly save only through Save notes; tapping outside retains the draft. This proposes an exception to the current blur-save contract, not a canonical amendment.
- Failed saves retain the draft; retry is available. Dirty cancellation/back navigation asks to keep editing or discard. Saved content remains unchanged until success.
- Omit the empty Related plan row in the Task example, subject to approval; existing relationship behavior must be preserved in production.
- Preserve title blur-save, type-specific primary verbs, schedule sheet entry, compact Notes-first settings, and preparation first-three/show-all behavior.

## Simulation boundaries
Everything is in browser memory and resets on reload. No APIs, persistent storage, uploads, notifications, or production writes. Controls provide populated, loading, load-error, empty, long-content, completed/skipped examples and normal/slow/failing notes saves. Date, repeat and reminder dialogs, preparation detail, lists, snooze and overflow are contextual simplifications, not full production behavior specifications. Ownership, recurring-instance restrictions, all reminder capabilities and the complete list catalogue need preservation in any later implementation. Calendar navigation is outside the selected Activity details scope.

## Verification performed
Browser at 390x844: visible notes field and Save/Cancel; no horizontal overflow, including long title; dark editor inspected. Exercised editing, tapping outside, failed save retaining text, successful retry updating preview, dirty Cancel confirmation and discard preserving saved text. Screenshot v1-notes-light.png records the editor. JavaScript syntax checked separately. Native keyboard reachability, keyboard avoidance, Dynamic Type, VoiceOver, actual sheet gestures and real loading/error integration remain native verification work.

## Workflow record
One initial mock, zero user revision rounds so far. User selected Activity details after calendar exploration, and their notes feedback changed the recommendation from blur-saving to explicit draft saving. Shared Maestro/simulator services were left untouched; isolated copied export and fixture API enabled inspection when the original embedded backend was unavailable. This setup added friction and limits how strongly findings apply to current native code. Final handoff and workflow assessment follow explicit approval of a version.
