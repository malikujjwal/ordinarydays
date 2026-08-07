# Git workflow

**Status:** canonical for branching, commits, pull requests, releases, and how several
coding agents work on this repository at once without corrupting each other's work. The CI
workflows themselves are specified in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §7 and are
not restated here.

---

## 1. Branching model

**Trunk-based on `main`, with short-lived branches.** There is no `develop`, no `release/*`,
no long-lived feature branch. `main` is always deployable and is deployed to dev on every
merge.

| Property | Value |
| --- | --- |
| Base branch | `main`, always |
| Branch lifetime | Under 2 days. A branch older than 5 days is rebased or abandoned. |
| Merge strategy | **Squash only.** Linear history is enforced on `main`. |
| Rebase vs merge while in flight | `git pull --rebase origin main`. Never `git merge main` into a branch — it produces a merge commit that squash-merge then flattens into an unreadable diff. |
| Deletion | Branches are deleted on merge, automatically. |
| Direct pushes to `main` | Blocked by branch protection, including for the founder. |

### 1.1 Branch naming

```
<type>/<PHASE-TASK-ID>-<slug>
```

| Part | Rule | Example |
| --- | --- | --- |
| `<type>` | One of the Conventional Commit types in §2.1 | `feat` |
| `<PHASE-TASK-ID>` | `P<phase><-><task>`, uppercase, exactly as it appears in the phase doc | `P2-07` |
| `<slug>` | 2–5 words, lowercase, hyphenated, describing the change not the file | `recurrence-engine` |

```
feat/P2-07-recurrence-engine
fix/P3-12-agenda-dst-boundary
refactor/P4-03-extract-authz-helper
chore/P1-04-biome-config
docs/P0-02-conventions
```

One branch per task ID. One task ID per branch. A branch that needs a second task ID is two
branches.

---

## 2. Commits

### 2.1 Conventional Commits

```
<type>(<scope>): <subject>

<body>

<footer>
```

| Type | Use for | In changelog |
| --- | --- | --- |
| `feat` | A user-visible capability | Yes — Features |
| `fix` | A defect corrected | Yes — Fixes |
| `perf` | A measured performance improvement | Yes — Performance |
| `refactor` | Behaviour-preserving restructuring | No |
| `test` | Tests only | No |
| `docs` | Documentation only | No |
| `build` | Bundling, packaging, dependency changes | No |
| `ci` | Workflow and pipeline changes | No |
| `infra` | CDK, AWS resources, IAM. **Project-specific type**, because infrastructure changes are neither `feat` nor `chore` here and deserve their own changelog section | Yes — Infrastructure |
| `chore` | Anything else: config, tooling, housekeeping | No |
| `revert` | Reverting a previous commit | Yes |

Scopes match the workspace packages plus the areas that cut across them:

| Scope | Covers |
| --- | --- |
| `shared` | `packages/shared` |
| `ui` | `packages/ui` |
| `mobile` | `apps/mobile` |
| `api` | `services/api` |
| `infra` | `infra/` |
| `docs` | `docs/` |
| `ci` | `.github/` |
| `repo` | Root config: workspace, turbo, biome, tsconfig |

A commit touching two scopes uses the primary one, or omits the scope if it genuinely spans
the repo. A commit touching four scopes is usually a PR that should have been two.

Rules for the subject line:

- Imperative mood, lowercase, no trailing period: `add occurrence override merge`, not
  `Added occurrence override merging.`
- Under 72 characters.
- Describes the change, not the file: `fix(api): return 404 for non-participants` beats
  `fix(api): update authz.ts`.

The body explains **why**, references the task ID, and names any decision that is not
obvious from the diff. The footer carries `BREAKING CHANGE:` where applicable and
`Refs: P2-07`.

```
feat(shared): expand recurring series without materialising rows

Occurrences are computed at read time from the series plus override rows,
per data-model.md §6. Materialising future rows was considered and rejected:
it would make a recurrence edit an unbounded write.

Refs: P2-07
```

Commit messages are validated by `commitlint` in a `lefthook` `commit-msg` hook and again in
CI on the PR title, because the PR title becomes the squash commit.

### 2.2 Signed commits

Branch protection requires signed commits (`infrastructure.md` §7.6). Configure once:

```bash
git config --global commit.gpgsign true
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
```

An agent working in an environment without the signing key must say so rather than
disabling the setting.

---

## 3. Pull requests

### 3.1 Size

| Limit | Value | Enforcement |
| --- | --- | --- |
| Target diff | Under 400 changed lines, excluding lockfiles, generated files, and tests | Reviewer judgement |
| Hard ceiling | 800 changed lines, same exclusions | A CI job labels the PR `oversized` and comments; it does not block, because a genuine mechanical rename can exceed it |
| Files touched | Under 20, excluding generated | Reviewer judgement |
| Commits | Any number — they are squashed |

A PR over the ceiling must open with one sentence explaining why it could not be split. "It
is all one feature" is not that sentence; a vertical slice through six files is normal, a
rewrite of two subsystems is not.

### 3.2 Description template

`.github/pull_request_template.md`:

```markdown
## Task
Implements **P<phase>-<task>** — <task title from the phase doc>
Link: docs/03-implementation/phase-<n>.md#p<phase>-<task>

## What changed
<Two to five bullets. What a reviewer needs to know, not a file list.>

## Why this approach
<Only where a choice was made. Name the alternative that was rejected and why.>

## Docs touched
- [ ] `data-model.md` §5 — new access pattern added
- [ ] `api-contract.md` §2 — new or changed endpoint
- [ ] `docs/generated/openapi.json` — regenerated (`pnpm run gen:openapi`)
- [ ] No doc change needed

## New dependencies
<For each: what it does, why nothing present does it, weekly downloads, last publish,
transitive count. Delete this section if none. Required by security-privacy.md §7.>

## Testing
<What was added, and how a reviewer reproduces the behaviour manually.>

## Checklist
- [ ] `pnpm verify` passes locally
- [ ] No `Scan`, no `any`, no floating promises, no float money arithmetic
- [ ] No `pk`/`sk` outside `repositories/keys.ts`, none in any response or log
- [ ] Error messages are user-facing copy, not exception text
- [ ] New interactive elements have `accessibilityRole` and `accessibilityLabel`
- [ ] Nothing hard-coded that belongs in tokens or `constants.ts`
- [ ] Scope guard respected: nothing built that the phase doc says "do not do yet"
```

A PR whose description is only the template with nothing filled in is closed, not reviewed.

### 3.3 Review checklist

The reviewer — human or agent — works through this in order and comments on the first
failure rather than reading on.

| # | Check | Reference |
| --- | --- | --- |
| 1 | Does it implement the stated task ID, and only that? | §1.1 |
| 2 | Does it contradict a canonical doc? | `agent-playbook.md` §2 |
| 3 | Any of the 24 rejection smells? | `coding-standards.md` §11 |
| 4 | New access pattern → row in `data-model.md` §5? New endpoint → row in `api-contract.md` §2 and a regenerated OpenAPI? | — |
| 5 | Layering intact: no DDB outside repositories, no HTTP inside services, no cross-feature imports? | `repo-structure.md` §3 |
| 6 | Tests at the right layer, and the required cases present? | `testing.md` §1, §4.4 |
| 7 | Error paths: correct code, correct status, safe message? | `coding-standards.md` §2 |
| 8 | Anything user-facing: matches `interaction-contract.md` for gestures, states, and copy? | — |
| 9 | Anything visual: uses tokens only? | `design-system.md` §9 |
| 10 | Anything new in the data path: reflected in `security-privacy.md` §3 and the redaction list? | — |

### 3.4 Required CI checks

A PR cannot merge until these pass:

| Check | Job | What it runs |
| --- | --- | --- |
| `validate` | `ci.yml` | Biome, typecheck, unit + component tests with coverage thresholds, OpenAPI staleness, bundle size ≤ 5 MB, gitleaks |
| `integration` | `ci.yml` | Repository tests against DynamoDB Local |
| `synth` | `ci.yml` | `cdk synth` and `cdk diff` against dev, posted as a comment |
| `depcruise` | `ci.yml` | Architectural dependency rules (`repo-structure.md` §4) |

> **Decision:** `integration` and `depcruise` are added to the required-check set alongside
> `validate` and `synth`. `infrastructure.md` §7.6 lists only the first two because it was
> written before the repository test harness and the dependency rules existed; that table
> must be updated in the same PR that lands this document. Integration tests add about 90
> seconds and are the only thing that proves the single-table key design works;
> `depcruise` takes two seconds and is the only thing that prevents the layering from
> eroding one convenient import at a time.

### 3.5 Squash-merge policy

- **Squash and merge is the only enabled merge button.** Merge commits and rebase-merge are
  disabled in repository settings.
- The **PR title becomes the commit subject** and must itself be a valid Conventional Commit
  header. CI lints it.
- The squash body is the PR description's "What changed" section plus `Refs: P<n>-<nn>`.
- The branch is deleted automatically on merge.

Why: `main`'s history is one line per merged task, which makes `git log --oneline` a readable
project log, makes `git bisect` land on a whole feature rather than a half-built one, and
makes a revert a single commit.

---

## 4. Branch protection settings

Configure on GitHub for `main`. The first six rows restate `infrastructure.md` §7.6; the rest
are additions this document owns.

| Setting | Value |
| --- | --- |
| Require a pull request before merging | Yes |
| Required approvals | 0 while solo. Set to 1 when a second engineer joins. |
| Dismiss stale approvals on new commits | Yes |
| Require status checks to pass | `validate`, `integration`, `synth`, `depcruise` |
| Require branches to be up to date before merging | Yes |
| Require conversation resolution | Yes |
| Require linear history | Yes |
| Require signed commits | Yes |
| Allow force pushes | No |
| Allow deletions | No |
| Rules apply to administrators | **Yes.** A solo founder who can bypass protection has no protection. |
| Allowed merge methods | Squash only |
| Automatically delete head branches | Yes |
| Require deployments to succeed before merging | No — dev deploy happens after merge |

Repository-level settings that belong with these:

| Setting | Value |
| --- | --- |
| Secret scanning | Enabled |
| Push protection for secrets | Enabled |
| Dependabot alerts and security updates | Enabled |
| `production` environment | Required reviewer, 5-minute wait timer, deployment branches restricted to `v*` tags (`infrastructure.md` §7.7) |
| `development` environment | No reviewer |
| Default branch | `main` |
| Actions permissions | Read-only `GITHUB_TOKEN` by default; jobs opt in to `id-token: write` |

---

## 5. Releases and tagging

### 5.1 Versioning

**Semver on the mobile app**, and the mobile app's version is the product's version. The
backend is deployed continuously and is not separately versioned — it is always compatible
with the shipped clients, which is what `api-contract.md` §5 exists to guarantee.

| Bump | When |
| --- | --- |
| **Major** | A change that makes an older client unusable — the case `426 upgrade_required` exists for. Expected: never, or once. |
| **Minor** | Any user-visible feature. Most releases. |
| **Patch** | Fixes only, no new capability. |

The version lives in **one** place, `apps/mobile/app.config.ts`'s `version` field, and is
read from `package.json`'s `version` in that same package. Nothing else hard-codes it.

### 5.2 Version → build number → App Store

| Concept | Value | Set by |
| --- | --- | --- |
| Marketing version (`CFBundleShortVersionString`) | `1.4.0` — the semver string | `app.config.ts` `version` |
| iOS build number (`CFBundleVersion`) | A monotonically increasing integer, never reset between marketing versions | EAS `autoIncrement: true` on the `production` profile (`infrastructure.md` §6.4) |
| Web build | No version; the deployed commit SHA is returned by `GET /v1/health` | `deploy-prod.yml` |
| Git tag | `v1.4.0` | Created by hand on `main`, from a commit that has passed CI |

Two rules that are easy to get wrong:

1. **The build number never resets.** App Store Connect rejects a build whose number is not
   higher than the last one uploaded for that app, regardless of the marketing version.
   `autoIncrement` handles this; do not set it manually.
2. **A tag is created only from `main`,** and only from a commit already deployed to dev and
   green. `deploy-prod.yml` triggers on the tag, and the `production` environment restricts
   deployments to `v*` refs, so a tag on any other branch cannot reach prod.

### 5.3 Cutting a release

```bash
git checkout main && git pull
pnpm verify                                    # the same checks CI runs
pnpm version minor --workspace @od/mobile      # bumps package.json, no tag
git commit -am "chore(mobile): release v1.4.0"
git push
# wait for ci.yml + deploy-dev.yml to go green on that commit
git tag -s v1.4.0 -m "v1.4.0"
git push origin v1.4.0
```

The tag push starts `deploy-prod.yml`, which waits at the `production` environment approval
before any AWS credential is issued (`infrastructure.md` §7.7). The iOS build is a separate,
manually dispatched `mobile.yml` run, because EAS queues must never block an infrastructure
deploy.

### 5.4 Changelog

> **Decision: `CHANGELOG.md` is generated from Conventional Commits with `git-cliff`, and is
> committed.** The alternative — GitHub's auto-generated release notes — produces a list of
> PR titles that is not readable by a user and does not exist outside the GitHub UI. A
> committed changelog is readable from the repo, diffable, and can be pasted into the App
> Store "What's New" field, which is a mandatory submission field.

`cliff.toml` groups by commit type: Features (`feat`), Fixes (`fix`), Performance (`perf`),
Infrastructure (`infra`), and Breaking Changes (any `BREAKING CHANGE:` footer). `refactor`,
`test`, `docs`, `build`, `ci`, and `chore` are excluded — they are not news.

`deploy-prod.yml` regenerates `CHANGELOG.md` for the tag, attaches the section to the GitHub
release, and opens a follow-up commit on `main` with the updated file. The App Store
"What's New" text is written by hand from that section, in product language, not commit
language.

---

## 6. Several agents at once

This repository is expected to have multiple coding agents working in parallel. The rules
below exist because the failure mode is not a merge conflict — Git handles those — but two
agents independently changing the same shared contract in incompatible ways and both passing
CI.

### 6.1 The ownership rule

> **One agent owns one task ID and one branch. An agent never commits to a branch it did not
> create, and never edits a file outside the scope of its task ID.**

Consequences:

- If your task requires a change in another agent's area, you do not make it. You either
  wait for their branch to land and rebase, or you raise it (`agent-playbook.md` §8).
- If you find a bug outside your task, you file it with a proposed task ID. You do not fix
  it in your PR. A drive-by fix in an unrelated file is the thing that makes two PRs conflict
  in a way neither author can resolve.
- Two agents must never be assigned task IDs that touch the same file in the same phase. That
  is a planning error, and the fix is sequencing the tasks, not coordinating the agents.

### 6.2 High-contention files

These are edited by many tasks and are where parallel work collides. Each has a rule.

| File or directory | Why it is contended | Rule |
| --- | --- | --- |
| `packages/shared/src/types/**` | Every feature adds a type | **One type per file**, named for the type. Adding a type is a new file plus one line in the subpath barrel. Two agents adding two types then conflict on one line, which Git resolves. |
| `packages/shared/src/schemas/**` | Same | One file per resource, already. Adding a field to an existing resource's schema is the contended case — see §6.3. |
| `packages/shared/src/constants.ts` | Every limit lands here | Append-only, alphabetically grouped by area with a blank line between groups. Never reorder the file in a feature PR. |
| `packages/shared/src/errors.ts` | The closed `ErrorCode` union | One code per line, alphabetical. Adding a code is a one-line insert. |
| `infra/lib/stacks/**` | Every backend feature may need a resource | One stack per file, already. Two agents needing the same stack sequence their tasks; they do not both edit `api-stack.ts` on the same day. |
| `infra/lib/config.ts` | New config keys | Append to the Zod object and to both stage objects, in the same order, in one commit. |
| `docs/generated/openapi.json` | Regenerated by every API change | **Never hand-edit, never hand-merge.** On a conflict: `git checkout --ours` (or `--theirs`, it does not matter), then `pnpm run gen:openapi` and commit the result. The file is a build output that happens to be committed. |
| `pnpm-lock.yaml` | Every dependency change | On a conflict: `git checkout --theirs pnpm-lock.yaml && pnpm install --lockfile-only`, then commit. Never resolve it by hand. |
| `apps/mobile/app/**` route tree | New screens | One route file per screen, already. Layout files (`_layout.tsx`) are contended — treat them like `infra` stacks and sequence. |

### 6.3 Merge order when two agents touch the schema

"Schema" here means anything that both the client and the server depend on: a Zod schema, a
type in `packages/shared/src/types`, an entry in `constants.ts`, a DynamoDB key pattern, or
an endpoint in `api-contract.md`.

The rule, in order:

1. **The schema change lands first, alone.** If two tasks both need a change to
   `activity.ts`, the shared change is extracted into its own task and its own PR, merged
   before either feature branch.
2. **The schema PR is additive and optional-only.** A new field is optional; a new union arm
   is added, none removed. This makes it safe for the other agent's in-flight branch, which
   does not know the field exists.
3. **Both feature branches then rebase onto `main`** before continuing. Not merge — rebase,
   so the squash diff stays readable.
4. **A required (non-optional) field or a removal is a two-step change across two merges:**
   add it optional, backfill or migrate, then make it required in a later PR. Never in one.
   `data-model.md` §9 says the same thing about stored data; this is the wire-format version.
5. **If two agents have already both changed the schema in conflicting ways,** neither
   resolves the conflict. Both branches stop, the conflict is raised
   (`agent-playbook.md` §8), a single reconciling task ID is created, and the two branches
   rebase onto its result.
6. **Ties break by task ID order.** If sequencing is genuinely ambiguous, the lower phase
   number goes first; within a phase, the lower task number goes first. This is arbitrary and
   deliberate — an arbitrary rule everyone follows beats a negotiation.

### 6.4 Keeping a branch current

```bash
git fetch origin
git rebase origin/main
pnpm install --frozen-lockfile      # the lockfile may have moved under you
pnpm verify
git push --force-with-lease         # --force-with-lease, never --force
```

`--force-with-lease` refuses to overwrite work that appeared on the remote since your last
fetch. Plain `--force` on a branch another agent has pushed to destroys it silently.

---

## 7. What must never be committed

`.gitignore` covers all of these. `gitleaks` runs pre-commit and in CI
(`security-privacy.md` §6), and GitHub push protection is on. Belt, braces, and a third
belt, because a secret in git history is public the moment it is pushed and deleting the
commit does not undo that — **rotate first, clean history second**
(`security-privacy.md` §9.2).

| Never | Pattern | Note |
| --- | --- | --- |
| Environment files | `.env`, `.env.local`, `.env.*.local` | `.env.example` **is** committed, with placeholder values, documenting every variable |
| Any credential | `*.p8`, `*.p12`, `*.pem`, `*.key`, `*.keystore`, `*.mobileprovision`, `*.cer` | Apple signing keys and provisioning profiles live in EAS, not in git |
| EAS credentials | `credentials.json`, `.easignore`-excluded artefacts | EAS-managed credentials stay server-side |
| AWS config | `.aws/`, any file containing an access key ID | There are no long-lived AWS keys in this project at all |
| Dependencies | `node_modules/` | |
| Build output | `dist/`, `build/`, `.expo/`, `.expo-shared/`, `web-build/`, `cdk.out/`, `*.tsbuildinfo` | |
| Native projects | `ios/`, `android/` | Generated by `expo prebuild`. Committing them forks the managed workflow. |
| Test and tool output | `coverage/`, `playwright-report/`, `test-results/`, `.turbo/`, `.maestro/` | |
| Local data | `.dynamodb-data/`, `*.sqlite`, seeded dumps | |
| Editor and OS files | `.DS_Store`, `.idea/`, `.vscode/*` except `extensions.json` and a shared `settings.json` | |
| Large binaries | Anything over 5 MB that is not an app asset | No Git LFS in this project; if something needs it, that is a decision to raise |
| Real user data | Any export, screenshot, or fixture containing a real person's email, name, or address | Builders generate fake data (`testing.md` §8) |

**Generated files that are committed — the complete list, and nothing else:**

| File | Why | Regenerated by |
| --- | --- | --- |
| `docs/generated/openapi.json` | It is how an agent discovers the API without reading every handler (`api-contract.md` §6). CI fails if it is stale. | `pnpm run gen:openapi` |
| `pnpm-lock.yaml` | Reproducible installs; `--frozen-lockfile` in CI (`security-privacy.md` §7) | `pnpm install` |
| `CHANGELOG.md` | §5.4 | `git-cliff`, in `deploy-prod.yml` |

Anything else generated and committed is a bug: it will drift, and the drift will be
discovered at the worst moment.
