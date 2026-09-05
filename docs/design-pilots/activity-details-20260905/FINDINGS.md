> Historical inspection record. Later decisions and current status are in [README.md](README.md). Statements about pending work describe that inspection stage.

# Plans design pilot — inspection round 1

Status: inspection complete enough for direction interview; no proposed mock built or approved.

## Evidence boundary
Inspected isolated previously exported web UI at 390×844 and 320×740, with current-schema-valid generated fixtures. Bundle commit is unknown; findings are observed in this export, not verified defects in the latest working tree or native build. Current source checked for calendar selection, month picker, landing adapter, and range behavior. Maestro simulator and shared build/services untouched. Dark appearance inherited from browser; light theme, native gestures, VoiceOver, Dynamic Type AX5 and reduced-motion runtime remain unverified.

## Journey walked
Upcoming rolling strip -> expand -> month/year sheet -> next year -> March 2027 -> March 12 -> plan detail -> Back -> full calendar -> March 13 (empty) -> next populated March 20 -> Today tab -> Plans -> Past -> March 2026 -> March 12. Also navigated earlier months under 2-second delayed responses and simulated failure, clicked retry after restoring success, and reloaded into all-empty and initial-error modes. Mode restored to populated afterward.

## Prioritized findings

1. Observed contract defect in export: March 12 selection lands with Nov 4 and Mar 4 above selected day; target heading around y=510 instead of directly below compact header. It remains so after settling and detail return. User may think wrong date was chosen. Preserve existing exact-day-below-overlay requirement; fix landing in later implementation. Evidence 03-march12-settled.png, 05-return.png. Current source contains landing corrections from concurrent work, so do not assume this export proves current code still fails.
2. Observed accessibility defect in export: expanded day button at width 320 measures 38.5625×51 CSS px, under required 44×44. At width 390 it measures 48.5625×51. Evidence 08-320-targets.png; read-only DOM measurement of Fri 12 Mar button. Current grid uses flex seven columns. Canonical geometry conflict: even seven 44px targets plus 16px side gutters total 340px before gaps; with six 8px gaps total 388px. Need agreed narrow-width alternative or explicit requirement amendment; do not silently relax target sizes.
3. Suspected usability issue supported by observation: no persistent selected-day state. After selecting Mar 12 and reopening calendar, accessible selected/pressed attributes are absent, and DayCell source only marks isToday. Focus outline on Mar 13 is transient focus, not retained selection. Selecting empty Mar 13 lands on Mar 20 without explanatory list copy. Directional fallback after known-empty coverage is existing behavior, not itself a defect. Proposed improvement: selected date + non-color-only indication and concise empty-day context while retaining fallback. Evidence 06-no-selection.png, 07-empty-day.png.
4. Suspected wording/discoverability issue: month sheet says 'Months entirely before today are unreachable from Upcoming. The stage decides what this offers, not the month on screen.' Accurate restriction, internal vocabulary. Proposed copy: 'For earlier dates, open Past.' Preserve directional clamp and fixed stage semantics. Evidence 02-month-picker.png.
5. Optional behavior proposal, not defect: no explicit current-day reset within calendar. Today tab works and Plans retains distant month on return. Ask whether user wants a current-day reset within Plans as well; distinguish from Today tab navigation.

## What worked
Month/year chooser reaches dates beyond initial response. Directional clamp visible: Past Next month disabled at current month; Upcoming prior months unavailable. Detail shows requested full date/year and long title; Back preserves distant month and prior position. Loading wheel is below calendar. Month failure keeps older cards and offers Try again. All-empty state reads prescribed No plans copy and Add. Today tab navigates correctly. No aesthetic defect inferred merely from warm dark palette/card spacing.

## Existing contract versus changes
Preserve stage order and eligibility, shared projection for calendar/list, no calendar writes, exact-day landing, known-empty-only fallback, Past unknown markers, card-per-day grouping, gap-line behavior, locally remembered expansion, stable overlay, row-body opens detail, Today tab, cached failure behavior, standard empty copy and accessibility/focus/reduced-motion rules.
Proposals requiring user direction: persistent selection and explanatory empty-day feedback; in-calendar current-day reset; narrow-width date-list alternative. No canonical amendments made. Any new selection visual/feedback wording and responsive alternate must be recorded in approved handoff for separate contract approval.

## Next step
Focused interview: orientation versus density priority; current-day reset semantics; narrow-width fallback. Then isolated prototype skill, one recommended v1, explicit approval loop. Mock must simulate selection/loading/landing/nearby/Today and loading/empty/error/long-content/populated states, expose harness state outside app surface, use existing tokens/fonts/icons, and never touch real data. No production implementation authorized.

## Workflow assessment so far
0 mock revisions; no design approval. User's Maestro clarification led to independent in-memory fixtures and a copied export, avoiding shared database resets. Initial environment work required separate turns before meaningful design inspection; user explicitly asked to resume original prompt. Shared source changes and unknown bundle revision limit attribution. UI inspection now supplies reproducible behavior and screenshots rather than taste-only feedback.
