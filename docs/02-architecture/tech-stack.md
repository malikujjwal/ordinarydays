# Tech stack

**Status:** canonical for dependency and layering decisions. The locked choices come from
the project brief; everything marked `> **Decision:**` is a judgement call made here.

Read alongside `data-model.md` (storage shapes) and `api-contract.md` (wire shapes). This
document says *what we install* and *how the code is arranged*. It does not restate
entities or endpoints.

---

## 1. Repository layout

pnpm workspaces + Turborepo. One repo, five workspace roots.

```
ordinarydays/
├─ apps/
│  └─ mobile/            Expo app. Ships to iOS via EAS and to web via static export.
├─ services/
│  └─ api/               The single Lambda: Hono router, handlers, services, repositories.
├─ packages/
│  ├─ shared/            Types, Zod schemas, recurrence engine, money math, API client.
│  └─ ui/                Design-system primitives (RN + RNW compatible).
├─ infra/                AWS CDK v2 app.
├─ docs/
├─ pnpm-workspace.yaml
├─ turbo.json
└─ package.json          Root scripts only. No runtime dependencies here.
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
  - "infra"
```

Turborepo pipeline (`turbo.json`, abbreviated):

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".expo/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "lint":      {},
    "gen:openapi": { "outputs": ["../../docs/generated/openapi.json"] }
  }
}
```

Turborepo exists for two things only: task graph ordering (`shared` builds before `api`
and `mobile`) and remote-cache-free local caching so CI reruns skip unchanged packages.
We do not use Turborepo remote caching — it is another vendor account for no benefit at
this scale.

---

## 2. Dependency table

Exact versions are pinned in `pnpm-lock.yaml`. The table gives the **minimum major** we
target. `pnpm` is configured with `save-exact=true` in `.npmrc`, so `package.json` carries
exact versions and the lockfile is the single source of truth. Renovate/Dependabot raises
version bumps as PRs (see `security-privacy.md` §7).

### 2.1 Language and toolchain

| Package | Min major | What it is for | Why it beat the alternative |
| --- | --- | --- | --- |
| `typescript` | 5.9.x | Types everywhere, `strict: true`, `noUncheckedIndexedAccess: true` | JS with JSDoc types is unusable for a shared schema package. Flow is dead. **Pinned to 5.9.x, not the 7.x native compiler** — see the decision below and the reversal that follows it. |
| `pnpm` | 9.x | Package manager, workspaces | Content-addressed store means the monorepo installs once; strict node_modules catches phantom dependencies that npm/yarn-classic hide. Yarn Berry PnP breaks React Native's Metro resolver. |
| `turbo` | 2.x | Task graph + local cache | Nx is a heavier framework with generators and plugins we do not want. `pnpm -r run` alone has no dependency-aware ordering or caching. |
| `node` | 22.x | Runtime for Lambda, CI, and tooling | Matches the Lambda `nodejs22.x` runtime exactly, so local behaviour equals deployed behaviour. Pinned in `.nvmrc` and in the CI setup step. |
| `git-cliff` | 2.x | Generates `CHANGELOG.md` from Conventional Commits in `deploy-prod.yml` | Required by `04-conventions/git-workflow.md` §5.4. A hand-maintained changelog goes stale; `git-cliff` reads the commit history we already lint. |

> **Decision:** TypeScript **7**, the native compiler, rather than staying on 5.x. Taken in
> P0-06 while the repository has no TypeScript in it, because the migration cost is the one
> thing here that only grows — every module added on 5.x is a module to re-verify later, and
> `packages/shared` starts filling up in the very next task.
>
> The risk is that a ground-up compiler rewrite silently drops a check we depend on, which
> would be invisible until it let a real bug through. So the pin was not taken on trust.
> Every option `04-conventions/coding-standards.md` §1.1 calls non-negotiable was asserted to
> still produce its error under 7.0.2 — `strictNullChecks` (TS2322),
> `noUncheckedIndexedAccess` (TS2322), `exactOptionalPropertyTypes` (TS2375),
> `noImplicitOverride` (TS4114), `noFallthroughCasesInSwitch` (TS7029) and
> `verbatimModuleSyntax` (TS1205) — and a two-project composite build was checked to order
> its references correctly, emit `.d.ts` plus declaration maps, and carry
> `noUncheckedIndexedAccess` across the reference boundary. Re-run that check on any future
> major bump; a flag that stops firing is worse than one that never existed.
>
> **Revisit if** an editor, `ts-node`, `tsx`, Metro, Vitest or `NodejsFunction`'s esbuild
> step turns out to need the JavaScript compiler's API surface, which the native build does
> not expose in full. The fallback is pinning 5.9.x, and it is a one-line change while the
> only consumers are `tsc -b` invocations.

> **Reversed. The repository is pinned to `typescript@5.9.3`, everywhere.** The clause above
> fired three times in Phase 0, and the third had no workaround left.
>
> | Where | What broke under 7.0.2 |
> | --- | --- |
> | **P0-19**, Expo CLI | `@expo/cli`'s `evaluateTsConfig` calls `ts.sys.getCurrentDirectory`, `ts.readConfigFile` and `ts.parseJsonConfigFileContent` to discover `paths`. `ts.sys` is `undefined` on the native compiler, so **every** `expo start` and `expo export` died before bundling. Not avoidable by dropping the `@/*` alias — the crash happens while *discovering* whether paths exist. Worked around by pinning `typescript@5.9.3` in `apps/mobile` alone, which left the repository with two compilers. |
> | **P0-27**, dependency-cruiser | Needs the same API. Left on its default it printed `missing-typescript-transpiler` and then **exited 0 having cruised 3 modules and 0 dependencies** — a green check that had inspected nothing. Worked around with `@swc/core`, whose parser cannot read `.tsx` at all (dependency-cruiser 18 hard-codes `syntax: "typescript"` with no `tsx` flag), so `no-cross-feature-imports` and `no-server-code-in-client` went blind to every component file. |
> | **No scoped fix existed** | dependency-cruiser declares no `typescript` peer, so it resolves whatever the root hoists. A `pnpm.overrides` entry cannot reach it, and both compiler versions cannot occupy one resolution path. |
>
> **P0-06's own argument is what settled it, pointing the other way.** It took 7.x because
> "the migration cost is the one thing here that only grows" — true when the repository held
> no TypeScript. Four phases in, the thing growing was the cost of *staying*: three
> workarounds, one of them a permanent hole in the layer that mechanically enforces
> `CLAUDE.md`'s non-negotiables, and `.tsx` files about to arrive in bulk in Phase 1. The
> benefit was never collected either — `turbo run typecheck` finishes in about three seconds
> warm across seven tasks, and nothing here waits on the compiler.
>
> **Measured on a spike before the decision, not predicted.** With 5.9.3 repo-wide:
> dependency-cruiser cruises 74 modules including `.tsx` with no transpiler warning;
> `no-cross-feature-imports` correctly fails a `.tsx` violation written both as an alias
> import *and* as a relative one — the textual fallback in `scripts/check-forbidden.mjs`
> catches only the first, so the relative form was passing CI entirely; typecheck, the full
> test suite with coverage gates, lint and the OpenAPI staleness check all pass; and
> `expo export` plus `expo-doctor` (18/18) succeed with no workspace-local TypeScript.
>
> **The one real risk was losing a check, and it was closed empirically.** Every flag
> `coding-standards.md` §1.1 calls non-negotiable still produces its error under 5.9.3, with
> the codes P0-06 recorded: `TS2322` (`noUncheckedIndexedAccess`), `TS2375`
> (`exactOptionalPropertyTypes`), `TS4114` (`noImplicitOverride`), `TS7029`
> (`noFallthroughCasesInSwitch`).
>
> The change was a net deletion: the `apps/mobile` pin and its two-compiler split, `@swc/core`,
> the `.tsx` exclusion and the orphan exemption that existed only because those files'
> importers were unparseable.
>
> **Revisit when** dependency-cruiser and the Expo CLI support TypeScript 7 — going back is
> the same one-line change in the other direction, and P0-06's verification of the
> non-negotiable flags under 7.0.2 still stands for whoever does it.

### 2.2 Client

| Package | Min major | What it is for | Why it beat the alternative |
| --- | --- | --- | --- |
| `expo` | SDK 54 | App framework, native module layer, EAS Build, OTA updates | Bare React Native means hand-managing Xcode projects, CocoaPods, and native upgrades solo. Expo's prebuild + EAS removes the Mac-in-the-loop requirement for most builds. |
| `expo-router` | 4.x (ships with SDK 54) | File-based routing, shared between native and web | React Navigation alone requires hand-written navigator trees and has no URL story on web. Expo Router gives real URLs on web and deep links on iOS from the same file tree. |
| `react-native` | 0.81+ (whatever SDK 54 pins) | The runtime | — |
| `react-native-web` | 0.20+ | Renders RN primitives to DOM | The alternative is a second Next.js web app duplicating every screen. One founder cannot maintain two clients. |
| `react` / `react-dom` | 19.x | — | — |
| `@react-navigation/native` + `@react-navigation/bottom-tabs` | 7.x | The navigation engine Expo Router is built on | Not a choice — Expo Router delegates to it. We depend on it directly only for typed navigation helpers and tab-bar customisation. |
| `@tanstack/react-query` | 5.x | Web server state and shared HTTP/request machinery; never migrated native domain state or persistence | Redux Toolkit Query is coupled to Redux. SWR lacks the settled web cache adapter. Native uses the same endpoint clients behind typed SQLite repositories after ADR-057 cutover. |
| `@tanstack/query-async-storage-persister` | 5.x, pinned with React Query | Web persisted reads and the temporary legacy-native import source | The first-party persister owns its cache serialization. P2-63 retires native query-domain persistence after verified SQLite import; it remains valid for web. |
| `@react-native-async-storage/async-storage` | Expo SDK 54-compatible | Non-domain preferences plus the legacy native cache/outbox migration source | P2-63 retires native persisted domain/query and intent paths after a verified migration receipt. It is never token storage or migrated native domain authority. |
| `expo-sqlite` | SDK 54-compatible | Sole native visible domain state, transactional outbox, versioned migrations and account-scoped databases after feature cutover | SQLite provides atomic local action + materialization, indexed typed queries and crash durability without a generic local-first framework. Installed/configured by P2-61. |
| `@react-native-community/netinfo` | Expo SDK 54-compatible | Schedules native `syncNow()` and drives web online state | Connectivity is a scheduling signal only; it never clears or rematerializes native rows. Polling with failed requests wastes retries. |
| `zustand` | 5.x | **Client state**: UI-only state — composer draft, filter selections, sheet visibility, onboarding step | Redux for this volume of state is ceremony. Context re-renders the whole subtree. Jotai is fine but Zustand's single-store-per-domain model is easier for an agent to follow. |
| `zod` | 4.x | Runtime validation + type inference, defined once in `packages/shared` | Yup has weaker inference. `io-ts` is unreadable. Valibot is smaller but lacks the OpenAPI generator we rely on. **OQ-11 closed in P0-07:** the ecosystem has followed — `@asteasolutions/zod-to-openapi@9` now requires `zod ^4.0.0`, making v3 the version that would need a pin. |
| `react-native-reanimated` | 4.x | Gesture-driven and layout animations on the UI thread — swipe actions, sheet transitions, checkbox spring | The `Animated` API drops frames on the JS thread during list scrolling, which is exactly when Today's swipe actions fire. Installed with Expo and declared directly in `apps/mobile` by P2-22; a lockfile-only peer entry is not an installation. |
| `react-native-gesture-handler` | 2.x | Native-thread gestures backing swipe rows | Peer requirement of Reanimated gestures; RN's `PanResponder` is JS-thread bound. |
| `expo-image` | 3.x | Attachment and poster rendering, with disk + memory caching and blurhash placeholders | RN's `Image` has no persistent disk cache and no placeholder story; posters are the heaviest content in the app. |
| `expo-notifications` | 0.3x/1.x (SDK-pinned) | Push token registration, permission prompts, local notification scheduling, notification response handling | Bare `@react-native-firebase/messaging` drags in Firebase for a feature Expo Push already covers for free. Installed with Expo and declared directly in `apps/mobile` by P2-34; web resolves the sanctioned no-op push adapter. |
| `expo-image-picker` | 16.x (SDK-pinned) | Camera + library access for the photo/screenshot capture path | `react-native-image-picker` needs manual native config; Expo's version handles the iOS permission strings via app config. |
| `expo-contacts` | 15.x (SDK-pinned) | **`presentContactPickerAsync` only** — the OS contact picker behind `⊕ Choose from Contacts` in the participant picker (Phase 6, P6-35) | A picker, not a sync. The system picker runs out of process and returns the one contact the user tapped, so no `CONTACTS` read permission is requested, the App Store privacy label does not grow, and no address book is stored. `react-native-contacts` only offers the bulk-read API, which is the thing being avoided. Every other `expo-contacts` export is banned by lint. |
| `expo-secure-store` | 14.x (SDK-pinned) | Keychain-backed token storage on iOS | `AsyncStorage` is plaintext on disk. See `auth.md` §4. |
| `expo-crypto` | 14.x (SDK-pinned) | `Idempotency-Key` UUID generation, PKCE verifier/challenge | `crypto.randomUUID` is not present in the Hermes global scope on all SDK versions. |
| `date-fns` | 4.x | Date arithmetic, formatting, comparison | Moment is deprecated. Luxon is good but heavier and duplicates what `date-fns-tz` gives us. `Temporal` is not yet available on Hermes. Declared on `packages/ui` as well from P1-22: the two pickers resolve `This weekend` and render `Sat, Aug 8`, and §4.4 of `04-conventions/coding-standards.md` rules out slicing the string or carrying a month-name array to avoid the dependency. P2-01 also declares it directly on `packages/shared`; same pinned version, which is what `syncpack` polices. |
| `date-fns-tz` | 3.x | IANA-zone conversion between user-local wall-clock time and UTC instants | Required by `data-model.md` §6 (DST-stable expansion). Nothing else in the `date-fns` family does zone maths. P2-01 declares it directly on `packages/shared`, where `toUtcInstant` and recurrence consumers share it. |
| `react-native-svg` | 15.x (SDK-pinned) | Renders the hand-authored icon set in `packages/ui/src/icons/` on native and web | Required by `04-conventions/design-system.md` §5.4. An icon font ships 60–200 KB of glyphs for ~30 shapes and cannot take a per-instance colour. Expo-managed, so installed with `npx expo install`. **Stubbed under Vitest** (`packages/ui/test/svg-stub.tsx`): it declares `"react-native": "src/index.ts"`, so under the RN condition it resolves to untranspiled TypeScript and fails to parse. Nothing in the suite asserts SVG rendering, and the shapes are reviewed in the token gallery in a real browser. |
| `react-native-safe-area-context` | 5.6.x (SDK-pinned) | Notch, home-indicator and status-bar insets | Already an `apps/mobile` dependency; **declared on `packages/ui` from P2-41** as a **peer plus dev** dependency, the same shape as `@react-native-community/datetimepicker`, because `Sheet` reads `insets.bottom`. A bottom sheet's last control sat under the home indicator without it, and the alternative — every caller passing an inset prop down into a primitive — puts a platform detail in the signature of every sheet in the product. The app owns the provider; the package only reads. **Stubbed under Vitest** (`packages/ui/test/safe-area-stub.tsx`, shared with `apps/mobile`): its RN-condition entry is untranspiled TypeScript and its compiled build reaches into `react-native`'s Flow source. Nothing in either suite asserts an inset — they are judged on a device. |
| `expo-font` | 14.x (SDK-pinned) | Loads Newsreader at app start (P1-22) | The serif is the product's one typographic signature (`design-system.md` §3). `expo-font` handles the native and web `@font-face` paths from one call and, critically, **does not block text**: the platform serif renders until the file arrives. |
| `@react-native-community/datetimepicker` | 8.4.x (SDK-pinned) | The platform date and time wheels behind `@od/ui`'s `DatePicker` and `TimePicker` (P1-22) | Required by `04-conventions/design-system.md` §6, which specifies the **native wheel on iOS** and `<input type="date">` on web. Writing a calendar grid instead would mean re-implementing keyboard navigation, localisation, and the month arithmetic `04-conventions/coding-standards.md` §4.4 rules out doing by hand — for a control every user already knows. Expo-managed, so SDK-pinned and installed with `npx expo install`. Declared on `packages/ui` as a **peer plus dev** dependency, the same shape as `react-native`: the app supplies the native module, the package renders into it. Reached only by `pickerSurface.tsx`; the web build resolves `pickerSurface.web.tsx` and never bundles it. **Stubbed under Vitest** (`packages/ui/test/datetimepicker-stub.tsx`) because it is a native module with nothing for jsdom to render — the wheel is asserted by Maestro on the simulator (P1-29). |
| `@expo-google-fonts/newsreader` | 0.4.x | The Newsreader face itself, latin subset | **Static `Newsreader_500Medium`, not the variable font `design-system.md` §3 describes.** Both serif roles — `display` and `title` — are weight 500, so a variable axis would ship a range nothing varies across. One file, latin-subset, SDK-compatible, and swappable for the variable build if a third serif weight is ever specified. |

> **Decision — amended by ADR-057:** web server state lives in TanStack Query; migrated
> native domain state lives in typed SQLite repositories; Zustand remains UI-only state.
> Native screens never copy API data into Zustand or combine TanStack data and intents at
> read time. Shared use cases depend on repository interfaces, with web and native adapters.

### 2.3 Server

| Package | Min major | What it is for | Why it beat the alternative |
| --- | --- | --- | --- |
| `hono` | 4.x | HTTP router, middleware chain, request/response primitives inside one Lambda | Express pulls in a large dependency tree and its Lambda adapters are slow to boot. Fastify is Node-server-shaped, not edge/handler-shaped. Hono has a first-party `aws-lambda` adapter, zero dependencies, and boots in single-digit milliseconds. |
| `@hono/zod-validator` | 0.4+ | Wires the shared Zod schemas into route validation | Hand-written `schema.parse(await c.req.json())` in every handler is the same thing with more places to forget it. |
| `tsx` | 4.x | `pnpm --filter @od/api dev` — runs `src/local.ts` under `tsx watch`, so a save restarts the API without a build step (P0-21) | Added in P0-14, which is the first task with a server worth running. A **devDependency**: the deployed artifact is bundled by esbuild through `NodeLambda` and never sees it. `node --watch` on the compiled output would work but puts a build between saving and seeing the change, and `--experimental-strip-types` cannot handle the TypeScript enums `aws-cdk-lib` and other dependencies use. |
| `@hono/node-server` | 1.x | Runs the same Hono app under Node for local development (`services/api/src/local.ts`) | Added in P0-13, which is the first task with a local server to run. A **devDependency**, so it cannot reach the deployed artifact: `NodeLambda` bundles from `index.ts`, which uses the `hono/aws-lambda` adapter instead. The alternative — a second Express or `node:http` server for local dev — is a second request pipeline that would drift from the deployed one, which is the exact failure mode `local.ts` exists to avoid. |
| `aws-jwt-verify` | 5.x | Verifies Cognito ID tokens: signature, `iss`, `aud`, `token_use`, expiry, with cached JWKS | AWS-maintained, understands Cognito's claim conventions. `jose` + hand-rolled JWKS caching is the same code with our bugs in it. |
| `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` | 3.x | DynamoDB access; `lib-dynamodb`'s `DynamoDBDocumentClient` marshals plain JS objects | Raw `AttributeValue` maps (`{"S": "..."}`) everywhere is unreadable and error-prone. ElectroDB/OneTable add an entity abstraction over a key design we have already specified by hand in `data-model.md`; a second source of truth for keys is a liability. |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | 3.x | Presigned `PUT` URLs for attachment upload | Uploading through Lambda burns duration and hits the 6 MB payload limit. |
| `@aws-sdk/client-scheduler` | 3.x | Creating/deleting one-shot EventBridge schedules for reminders | — |
| `@aws-sdk/client-sesv2` | 3.x | Invite and RSVP emails | — |
| `@aws-sdk/client-secrets-manager` | 3.x | Reading the Anthropic API key in Phase 8 | — |
| `ulid` | 2.x | Prefixed, time-sortable entity IDs (`act_01J…`) per `data-model.md` §8 | UUIDv4 has no sort order, so `sk` ranges lose their natural ordering. UUIDv7 is close but `ulid` has the crockford-base32 encoding we already specified. |
| `date-fns` + `date-fns-tz` | 4.x / 3.x | Deriving `scheduledAtUtc` from a wall-clock `date` + `time` + `timezone` (P1-10 rule 3) | Already sanctioned for the client in §2.2 and installed server-side in P1-10, which is the first task that converts a zone. Pinned to the version §2.2 already uses, so one zone implementation serves both sides — Phase 2's recurrence expansion needs the same maths in `packages/shared`, and two spellings of it is exactly the drift §5.1 warns about. `Intl.DateTimeFormat` would work in Node alone, but it is not what the client can use and it is not what `data-model.md` §6 specifies. |
| `pino` | 9.x | Structured JSON logs, one line per event, redaction of PII fields | `console.log` produces unparseable text in CloudWatch Logs Insights. Winston is heavier and slower to boot. AWS Powertools Logger is good but pulls in the wider Powertools surface for one feature. |
| `esbuild` | 0.25+ | Bundles the Lambda to a single minified ESM file with `@aws-sdk/*` treated correctly | `webpack` is slow and configuration-heavy. `rollup` needs plugins for node resolution. SWC does not bundle. Sub-second builds keep the deploy loop tight. |

> **Decision:** we bundle the AWS SDK v3 clients into the artifact rather than relying on
> the Lambda runtime's bundled copy. The runtime's version drifts and is only partially
> present; a self-contained bundle makes local, CI, and deployed behaviour identical. Cost
> is roughly 1–2 MB of artifact per SDK client used, which is well inside limits and, once
> tree-shaken and minified, adds only a few milliseconds to cold start.

### 2.4 Infrastructure

| Package | Min major | What it is for | Why it beat the alternative |
| --- | --- | --- | --- |
| `aws-cdk-lib` | 2.x | All infrastructure as TypeScript constructs | See `decisions.md` ADR-007. Terraform is another language and state backend; SAM only covers serverless primitives and its YAML cannot express the Cognito + CloudFront + Scheduler surface cleanly; Serverless Framework changed its licence and adds a vendor dashboard. |
| `constructs` | 10.x | CDK's construct base library | Peer requirement. |
| `aws-cdk` (CLI) | 2.x | `cdk deploy`, `cdk diff`, `cdk synth` | Installed as a dev dependency in `infra/`, never globally, so CI and local use the same version. |

### 2.5 Quality and testing

| Package | Min major | What it is for | Why it beat the alternative |
| --- | --- | --- | --- |
| `vitest` | 3.x | Unit tests for `packages/shared` and `services/api` | Jest's ESM support is still awkward and it is slow on a monorepo. Vitest reuses the esbuild transform we already have, runs in-band watch mode fast, and its `expect` API is Jest-compatible so agents write familiar assertions. |
| `@vitest/coverage-v8` | 3.x | Coverage gates. `packages/shared/src/recurrence/**` and `.../money/**` are held at 100% statements/branches. | — |
| `fast-check` | 3.x | Property-based tests (dev dependency of `packages/shared` only) for money splitting, lexo ranks, and recurrence | Required by `04-conventions/testing.md` §7. Example-based tests prove the cases someone thought of; these three modules have invariants that must hold for every input. |
| `aws-sdk-client-mock` + `aws-sdk-client-mock-jest` | 4.x | Unit-level mocking of SDK clients for service-layer tests | Hand-rolled stubs of `send()` drift from the SDK's actual command shapes. |
| `@testing-library/react` | 16.x | Component tests for `packages/ui` and `apps/mobile`, under jsdom with `react-native` aliased to `react-native-web` (P1-31) | **Not `@testing-library/react-native`,** which `04-conventions/testing.md` §5 named until P1-31 corrected it. RNTL renders through `react-test-renderer` to a JavaScript tree — it does not use jsdom, does not use `react-native-web`, and would still require `react-native`'s Flow-typed source to be transformed by `@react-native/babel-preset`. The two are alternative setups, and §5 described a hybrid of both that does not exist. The alias is chosen because React Native Web is a shipping target rather than a shim (ADR-001), so these tests exercise code the product actually serves, and because it keeps one transform pipeline in the repository instead of two. The trade is that component tests do not exercise the iOS host components; Maestro (P1-29) and the physical-device criterion cover that. |
| `jsdom` | 30.x | The DOM the above renders into | `happy-dom` is faster but its accessibility-tree support is thinner, and every query in `testing.md` §5 is by role and accessible name. |
| `@playwright/test` | 1.6x | Web E2E against the exported static site | Cypress cannot drive multiple origins cleanly (the Cognito Hosted UI redirect) and is slower in CI. A **root** devDependency, not a workspace one: `e2e/` is deliberately not a pnpm workspace (`repo-structure.md` §7 places it at the root with its own config), so there is no owning `package.json` to put it in — the same shape as `turbo`, `biome` and `syncpack`. Pinned at 1.6x rather than the 1.4x this row first named, because that is what installs today. |
| `@axe-core/playwright` | 4.12.x | The accessibility scan on every web route a flow reaches (P1-29) | `definition-of-done.md` §5 item 11 requires zero `serious` or `critical` violations per route and names Playwright as the automation; this is the official axe binding for it. It injects `axe-core` into the page under test and returns the violation list, so the gate is one call per route rather than a hand-rolled DOM walk that would drift from WCAG as the rules change. Root devDependency for the same reason as `@playwright/test`. It earned its place on the first run, finding an empty `<title>` on every exported page and `textDisabled` used for informative copy at 2.53:1. |
| `maestro` | 1.x (CLI, not an npm dep) | iOS E2E flows on simulator and device | Detox requires a custom debug build and a brittle native bridge. Maestro's YAML flows are readable by an agent and run against the same build TestFlight gets. |
| `minio/minio` | latest (Docker image, not an npm dep) | The local S3-compatible object store for attachments, alongside `amazon/dynamodb-local` in `docker-compose.yml` (`infrastructure.md` §6.1) | Attachments must be buildable and testable in Phases 0–3, when nothing is deployed. MinIO implements the S3 API including SigV4 presigned `PUT`, so the application code stays `@aws-sdk/client-s3` and only the endpoint differs. `s3rver` and LocalStack's free S3 are less faithful on presigned-URL signature validation, which is precisely what these tests must exercise. |
| `@biomejs/biome` | 2.x | Linting **and** formatting, one tool, one config | See decision below. |
| `syncpack` | 13.x | Keeps dependency versions identical across workspaces | Divergent React versions between `apps/mobile` and `packages/ui` produce hook-dispatcher errors that take a day to diagnose. |
| `lefthook` | 1.x | Git hooks: `biome check --write --staged` and `gitleaks git --staged` pre-commit, the commit-message lint on commit-msg (P0-06) | Husky + lint-staged is two packages, a shell shim per hook and a `node_modules` round-trip per commit. Lefthook is one Go binary driven by a single `lefthook.yml`, runs hooks in parallel, and is fast enough that nobody reaches for `--no-verify`. |
| `@commitlint/cli` + `@commitlint/config-conventional` | 21.x | The commit-message lint on the `commit-msg` hook and on the PR title in CI, per `04-conventions/git-workflow.md` §2.1 | Named by that document and by the `lefthook` row above, but absent from this table until P0-06. `commitlint` is the reference implementation of Conventional Commits and the only one with a config the project can extend — required here, because `git-workflow.md` §2.1 adds a project-specific `infra` type that stock `config-conventional` rejects. The alternative, a regex in a shell hook, cannot be reused by CI to lint the squash-commit title. |
| `@asteasolutions/zod-to-openapi` | 9.x | Generates `docs/generated/openapi.json` from the Zod schemas in `packages/shared` (`api-contract.md` §6, P0-25) | Named by the `zod` row above but absent from this table until P0-25. The spec is generated rather than written, so it cannot drift from the code that serves it — a hand-maintained document is one that is wrong in a way nobody notices until a client has been built against it. v9 requires `zod ^4`, which OQ-11 already settled. Registration uses Zod 4's native `.meta({ id })` rather than the package's `extendZodWithOpenApi` patch, because that patch only reaches schemas constructed after it runs and every schema here is built at module load. |
| `openapi3-ts` | 4.x | The OpenAPI 3.1 document types, for the return annotation on `buildOpenApiDocument` | A dependency of `zod-to-openapi` that it does not re-export, so inferring the return type produces TS2883 ("cannot be named without a reference … not portable"). Declared directly rather than reached through another package's `node_modules`, which is the phantom dependency pnpm's strict linking exists to prevent. Types only; nothing imports it at runtime. |
| `@types/node` | 22.x | Node's type definitions, for the `types: ["node"]` in the `services/api` and `infra` compiler configs (`04-conventions/repo-structure.md` §5.3) | Not optional and not a choice: it is the type half of the `node` 22.x runtime in §2.1, pinned to the same major so the types cannot describe APIs the Lambda runtime does not have. |
| `gitleaks` | 8.x (CLI, not an npm dep) | Secret scanning, pre-commit via `lefthook` and on every PR via `gitleaks/gitleaks-action` (`security-privacy.md` §6, `infrastructure.md` §7) | A Go binary rather than an npm package, so it is a prerequisite alongside Node and pnpm, and the hook **fails closed** if it is missing — a skip-if-absent guard was tried in P0-06 and removed, because lefthook evaluated it in a shell that could not resolve `command -v` and silently skipped the scan with gitleaks installed. `trufflehog` is slower on a full-history scan and its detector set is tuned for live-credential verification, which is not what a pre-commit hook should be doing. |
| `dependency-cruiser` | 18.x | Enforces the seven import rules in `04-conventions/repo-structure.md` §3 as a **required CI check** (P0-27) | The rules are architectural, not stylistic, so a lint rule cannot express them. `dependency-cruiser` validates the real module graph, detects cycles at file granularity, and fails `ci.yml` with the offending edge named. It parses through `typescript` itself, which is why §2.1's compiler pin is load-bearing rather than a preference: on the native compiler it silently cruises nothing. |

> **Decision:** Biome over ESLint + Prettier. One binary, one config file, no plugin
> resolution graph, and roughly an order of magnitude faster on a monorepo — lint+format
> finishes in under a second, so it runs on every pre-commit hook without friction. The
> cost is real: the React Native and `react-hooks` ESLint plugin ecosystem is richer, and
> Biome's rule coverage for `exhaustive-deps` is newer. We accept that because the rules
> we depend on most (`noUnusedVariables`, `useExhaustiveDependencies`, import sorting,
> `noExplicitAny`) are all present. **Revisit if** a React Native-specific lint rule we
> need turns out to have no Biome equivalent; the fallback is ESLint flat config +
> Prettier, which is a half-day migration.

Config lives at the repo root in `biome.json` with per-workspace overrides. `lefthook`
runs `biome check --write --staged` pre-commit.

---

## 3. Client architecture

### 3.1 Expo Router file layout

```
apps/mobile/
├─ app/
│  ├─ _layout.tsx                  Root: providers (Query, auth, theme, gesture root)
│  ├─ +not-found.tsx
│  ├─ (auth)/
│  │  ├─ _layout.tsx               Redirects to (app) if a session exists
│  │  ├─ sign-in.tsx
│  │  ├─ sign-up.tsx
│  │  └─ verify.tsx
│  ├─ (app)/
│  │  ├─ _layout.tsx               Auth guard + bottom tabs (native) / sidebar (web)
│  │  ├─ (tabs)/
│  │  │  ├─ _layout.tsx
│  │  │  ├─ index.tsx              Today
│  │  │  ├─ plans.tsx
│  │  │  └─ lists.tsx
│  │  ├─ activity/
│  │  │  ├─ [id].tsx               Plan / activity detail
│  │  │  └─ [id]/expenses.tsx
│  │  ├─ list/
│  │  │  └─ [id].tsx
│  │  ├─ people/
│  │  │  ├─ index.tsx
│  │  │  └─ [id].tsx
│  │  ├─ compose.tsx               Presented modally: the unified Add screen
│  │  ├─ compose/review.tsx        The capture review screen (concept §13)
│  │  └─ settings/
│  │     ├─ index.tsx
│  │     ├─ notifications.tsx
│  │     └─ account.tsx
│  └─ invite/
│     └─ [token].tsx               Public invite page. Web-only route; see §3.5.
├─ src/
│  ├─ components/                  Screen-specific composites
│  ├─ features/                    Vertical slices: agenda/, lists/, people/, expenses/
│  │  └─ agenda/
│  │     ├─ hooks/useAgenda.ts
│  │     ├─ components/AgendaSection.tsx
│  │     └─ model/                 Feature actions and re-exports of shared projections
│  ├─ hooks/                       Cross-feature hooks (useSession, useTimezone)
│  ├─ lib/                         queryClient.ts, apiClient.ts, storage.ts, analytics.ts
│  │  └─ agenda/                   Pure partition/up-next helpers used by UI and SQLite
│  └─ stores/                      Zustand stores, one per UI domain
├─ app.config.ts
└─ eas.json
```

### 3.2 Layering

Four layers, strictly one-directional. A screen never talks to `fetch`; a hook never
renders.

| Layer | Location | Rules |
| --- | --- | --- |
| Route / screen | `app/**` | Reads params, composes feature components, owns nothing. No data fetching logic beyond calling a feature hook. Under ~150 lines. |
| Feature component | `src/features/<f>/components/**` | Presentational + local interaction. Receives data as props or from a feature hook. No direct API calls. |
| Feature hook | `src/features/<f>/hooks/**` | The only place `useQuery`/`useMutation` appears. Owns query keys, optimistic updates, invalidation. Returns view-ready data. |
| API client | `packages/shared/src/client/**` | Typed functions, one per endpoint, that validate responses with the shared Zod schemas. No React. |

`packages/ui` sits beside all of this: pure primitives (`Text`, `Stack`, `Button`, `Sheet`,
`Checkbox`, `Row`) with no knowledge of activities, lists, or the API.

### 3.3 Consuming the shared package

`packages/shared` is consumed as a **workspace source dependency**, not a built artifact,
during development:

```json
// apps/mobile/package.json
{ "dependencies": { "@od/shared": "workspace:*", "@od/ui": "workspace:*" } }
```

Metro must be told to watch the workspace root, or edits to `shared` will not hot-reload:

```js
// apps/mobile/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '../..');
const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
```

> **Amended in P0-19: none of those three overrides survives contact with SDK 54, and one of
> them breaks the build.** `metro.config.js` is now `module.exports = getDefaultConfig(__dirname)`
> and nothing else. Each line was checked against the real default rather than reasoned about:
>
> | Override | What `getDefaultConfig` already returns |
> | --- | --- |
> | `watchFolders = [workspaceRoot]` | The root `node_modules` **plus every workspace package**, `packages/shared` included. The override replaces six precise entries with one broad one and drops the `node_modules` entry that symlinked packages resolve through — and `expo-doctor` fails the project for it. |
> | `nodeModulesPaths` | Exactly `[<project>/node_modules, <workspace root>/node_modules]`. Identical; the override is a no-op. |
> | `disableHierarchicalLookup = true` | `false`, and it has to stay `false`. |
>
> The third is the one that matters. `disableHierarchicalLookup` comes from the Yarn/npm
> hoisted-monorepo playbook, where every dependency is flat in one of the two
> `nodeModulesPaths`. This repository sets **`node-linker=isolated`** in `.npmrc`, so a
> package's own dependencies live in `node_modules/.pnpm/<pkg>@<ver>/node_modules/` and are
> reachable **only** by walking up from the importing file. Switching hierarchical lookup off
> therefore makes every transitive dependency unresolvable: `expo-router` importing
> `@react-navigation/native` — a plain dependency of it, not a peer — is simply the first to
> fail, and the list behind it is unbounded.
>
> The stale-copy risk the override was written to prevent is already handled here by the
> thing that causes the incompatibility: pnpm's content-addressed store gives one physical
> copy per version, which is §2.1's stated reason for choosing pnpm in the first place. Where
> the two collide, the package manager wins and the bundler config yields.
>
> `@expo/metro-runtime` is a direct dependency of `apps/mobile` for the same family of
> reasons: it is an `expo-router` **peer**, and peers are the consumer's job to install.

`packages/shared` exports through explicit subpath entries so the client never
accidentally imports server-only code:

```json
// packages/shared/package.json
{
  "exports": {
    ".":            "./src/index.ts",
    "./schemas":    "./src/schemas/index.ts",
    "./types":      "./src/types/index.ts",
    "./table":      "./src/table/index.ts",
    "./recurrence": "./src/recurrence/index.ts",
    "./money":      "./src/money/index.ts",
    "./client":     "./src/client/index.ts",
    "./constants":  "./src/constants.ts",
    "./errors":     "./src/errors.ts"
  }
}
```

> **Amended in P0-12: the entries are conditional.** As written above, every subpath
> resolves to `./src/*.ts` for every consumer. That is correct for Metro and correct for
> `tsc`, which follows project references to `dist/*.d.ts` — and wrong for **Node**, which
> follows the `exports` map literally and cannot execute TypeScript. `infra` is a Node
> program (`cdk synth` runs `node dist/bin/ordinarydays.js`), so the first import of
> `@od/shared/table` failed with `ERR_MODULE_NOT_FOUND` on `src/table/definition.js`.
>
> The prose two paragraphs down already stated the intent — "for `services/api` and `infra`,
> `shared` is compiled by `tsc` to `dist/`; for the Expo app, Metro consumes the TypeScript
> source directly" — the map just had no way to express it. Each subpath is now:
>
> ```json
> "./table": {
>   "types":        "./dist/table/index.d.ts",
>   "react-native": "./src/table/index.ts",
>   "default":      "./dist/table/index.js"
> }
> ```
>
> Metro resolves the `react-native` condition and keeps consuming source, so hot reload is
> unaffected. Everything else gets `dist`. `packages/shared`'s own `test` script gained a
> `tsc -b` for the same reason: its exports-map test now resolves through `dist`, which is
> what the API and `infra` actually consume, so it is a stricter test than before.

`./table` and `./constants` were missing from this list until P0-07 and are not optional:
`repo-structure.md` §2.5 permits `infra` to import `@od/shared` **only** through those two
subpaths, and `create-local-table.ts` (P0-21) imports `@od/shared/table`. An entry is added
here as its directory is created, because an `exports` entry pointing at a file that does
not exist typechecks fine and then fails at import time in Metro — so `./recurrence` and
`./money` join the map with the phase tasks that write them (Phases 1–2), not before.
`packages/shared/src/index.test.ts` asserts that every declared subpath resolves.

For `services/api` and `infra`, `shared` is compiled by `tsc` to `dist/` as part of
`turbo build`. For the Expo app, Metro consumes the TypeScript source directly.

### 3.4 Offline and optimistic updates

The app must be usable on a subway. **ADR-057 is the production native architecture after a
domain cutover:** typed SQLite repositories are the sole visible state, and local actions
materialize rows in the same transaction that appends the durable outbox intent. Reads never
fold a server response with intents. One serialized sync engine owns push/pull reconciliation;
connectivity and pull-to-refresh only schedule `syncNow()`. The API remains authoritative for
ownership, versions, capabilities, derived fields and recurrence semantics.

The four numbered mechanisms below document the P2-33/P2-48…P2-59 lineage and remain the web
adapter or legacy migration input where stated. Their native TanStack/AsyncStorage
materialization is superseded by mechanism 5 when P2-62 cuts Activity/Agenda over.

**1. Persisted query cache (web; legacy native import source).** TanStack Query's cache is
persisted to `localStorage` on web. The pre-cutover native `AsyncStorage` cache is read only
by the P2-61/P2-63 verifier/importer, then retired; migrated native screens do not render it.

```ts
// src/lib/queryClient.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,               // matches the API's 60 s client-cache guidance
      gcTime: 7 * 24 * 60 * 60 * 1000, // a week of offline history
      retry: false,                     // the HTTP transport is the only retry layer
      networkMode: 'offlineFirst',
    },
    mutations: { networkMode: 'offlineFirst', retry: false },
  },
});
```

**Retry ownership is singular.** `createHttpClient` performs the bounded retry policy for
retryable requests; TanStack retries neither queries nor mutations. If both layers retried
three times, four transport attempts inside four Query attempts would produce up to 16 HTTP
requests for one user action. A hook may keep `networkMode: 'always'` for an explicit
query-side retry control, as activity detail does, but it does not re-enable Query retries.

**2. Optimistic updates (web and pre-cutover native only).** Specifically:
task completion, occurrence snooze/skip, list-item check, RSVP change, and list-item
reorder. Pattern, applied uniformly:

```ts
useMutation({
  mutationFn: (v) => api.completeActivity(v),
  onMutate: async (v) => {
    await queryClient.cancelQueries({ queryKey: agendaKey(v.date) });
    const previous = queryClient.getQueryData(agendaKey(v.date));
    queryClient.setQueryData(agendaKey(v.date), (old) => applyCompletion(old, v));
    return { previous };
  },
  onError: (_e, v, ctx) => queryClient.setQueryData(agendaKey(v.date), ctx?.previous),
  onSettled: (_d, _e, v) => queryClient.invalidateQueries({ queryKey: agendaKey(v.date) }),
});
```

`applyCompletion` and its siblings live in `src/features/*/model/` as pure functions and
are unit-tested — the optimistic projection must agree with what the server will return,
or the row will visibly flip back.

**3. Replay-safe mutation execution (web adapter and migration lineage).** Web mutations use
registered `mutationKey` defaults as TanStack request recipes. Every creating `POST`, plus the
explicitly replay-protected complete/uncomplete/skip mutations, carries a client-generated
`Idempotency-Key` (`expo-crypto`'s `randomUUID`), generated once when the action is accepted
and stored in its variables before `mutationFn` runs. Every retry and process-death replay
reuses it — this is why the API's idempotency records exist. New native writes are **not**
persisted or replayed as TanStack mutations; mechanism 5's SQLite transaction/outbox owns
that job. A one-time upgrade bridge imports legacy paused mutations and the old account log
into SQLite, verifies receipt-backed read-back, records the query-domain migration receipt,
and only then retires both legacy native sources. If verification fails, the SQLite session
may still pull canonical state, but native query-cache saving remains disabled and the
retained legacy records are not executed or retired; the next launch retries the same
idempotent import. The native runtime never executes those MutationCache records. Web has no
durable mutation queue.

Scope guard after ADR-057: native SQLite is a typed materialized application model, not a
DynamoDB mirror, CRDT or generic local-first replica. Existing-series and completion-relative
recurrence remain server-expanded. Web keeps "read what you had" and no durable queue.

**4. Client-minted canonical identity and the durable intent log (historical P2-48…P2-59
storage; semantics retained by ADR-057).**
The three mechanisms above make a write *survive a retry*; they do not make it durable or
visible. This one does.

```
                 ┌──────────────────────────────┐
   user action ─►│  durable intent log          │  what must reach the server
                 │  (own key, own schemaVersion)│
                 │            │                 │
                 │            ▼                 │
                 │  query cache / projection    │  what the UI shows
                 └────────────┬─────────────────┘
                              │ ordered replay on reconnect
                              ▼
                    server: canonical entities, ownership,
                    versions, capabilities, derived state
```

**Identity is client-minted; authority never is.** The client generates the real
`act_<ULID>` / `rem_<ULID>` (`data-model.md` §8) before the request leaves the device, so an
offline-created entity is identity-complete from birth — no temporary id, no reconciliation
pipeline. The server still owns `ownerId`, `createdAt`, versions, capabilities and every
derived field, and the `201` reconciles them into the projection: identity never changes,
authority still arrives late.

**Four invariants.**

1. **Identity is client-mintable; authority is not.** An id addresses nothing its principal
   does not own; authorization is tenancy, never id unpredictability.
2. **Every queued intent is replay-safe and idempotent, preferring absolute desired state
   over relative transformation.** `checked: true`, never `checked: !checked`; `complete`
   and `uncomplete` as separate sets, never a toggle; absolute `lexoRank`. `CREATE` gets the
   property from client id + persisted `Idempotency-Key` + conditional write.
3. **Chronology comes from explicit timestamp fields, never from an id.** `gsi1sk` leads
   with `localDateTime`/`createdAt`/`lastActivityAt`; the ULID is a stable tiebreaker. A
   wrong device clock therefore cannot corrupt ordering.
4. **The client projects only what it can compute correctly.** Its own unacknowledged
   creates: yes — no server state can contradict them. For a recurring create this includes
   expanding the user-supplied first segment with the shared recurrence engine across agenda
   windows already present in the query cache, plus the minimal Today fallback described
   below. Those rows are disposable projections, not stored Occurrences. Occurrence overrides,
   roll-forward, balances, or expansion of a server-known series: never.

If no Today window has ever been cached, an accepted pending create that belongs in Today or
tomorrow seeds a minimal, immediately-stale Today window containing its local projection.
This prevents a valid offline create from falling into the screen-level no-data error; the
offline bar remains the explicit signal that no complete server view is available. Opening a
pending row reads its detail from the durable create intent and makes no guaranteed-to-fail
server request. Acknowledgement removes that exception and enables the canonical detail read.

**Two stores, two durability contracts.**

| | Query cache | Intent log |
| --- | --- | --- |
| Contains | Server responses | Accepted user actions not yet acknowledged |
| Reconstructable | Yes, from the server | **No. It is the only copy.** |
| Age expiry | Yes (`MAX_AGE`) | **Never.** Age only bounds *automation* |
| Cache-buster | Discards freely | **Never silently discarded** — migrate or surface |
| Account boundary | Cleared on sign-out | Namespaced by `userId`, quarantined on sign-out |

An intent is persisted **before** the user is told the action was accepted and before the
request is attempted — a write-ahead record, not a replica. Persisted schema v2 lifecycle:
`queued → in_flight → acknowledged`; transient failure → `queued`; permanent failure →
`needs_attention/rejected`, with structured status/code/details where available. `refused`
exists only as the action coordinator's result when append fails; it is never stored. After
`MAX_AUTOMATIC_INTENT_AGE_DAYS` (`packages/shared`, shared with the server's deletion
tombstones so the two windows cannot be tuned apart), or whenever the persisted timestamp is
implausible or clock rollback is detected, an intent moves to
`needs_attention/parked` with an enumerated cause: **clock uncertainty reduces automation,
never extends the replay window.** `lastError` is display/diagnostic text only and is never
parsed for behavior. Cancellation is valid in `queued` only.

Stable, unique `intentId` is a schema invariant. Appending the same id and canonically
equivalent semantic payload is an idempotent no-op; reusing it for a different mutation,
entity, variables or dependency is an invariant/corruption failure. PATCH and DELETE mint
that id once and carry it through settlement — a newly evaluated clock value cannot identify
a logical write. v1 migration preserves every distinct user write, maps `failed` and
`needs_confirmation` into structured v2 attention, and deterministically disambiguates
conflicting legacy duplicate ids.

An inverse action is another durable intent with a causal dependency on the original.
`queued`, `in_flight` and `needs_attention` dependencies block; `acknowledged` permits the
dependent. Acknowledged parents retain lightweight receipts while any dependent or strong
recurrence reconciliation needs the outcome, and compact only afterward. A missing dependency
blocks unless a schema invariant proves its acknowledgement; it is never assumed successful.
Queued Undo atomically cancels the original and projection. Undo after claim durably appends
the inverse. Response-loss ambiguity recovers the original authoritatively before either
retiring or dispatching that inverse.

**Historical P2-59 runtime.** TanStack was the execution layer, not the durability boundary.
On cold start the log was
authoritative and pending work is rebuilt from it — including mutations that were mid-flight
rather than paused when the process died. The iOS intent-log session is the sole replay owner:
enqueue, transient backoff, foreground and connectivity request a bounded/coalesced,
process-wide serial drain; an atomic claim either moves one eligible `queued` intent to
`in_flight` or leaves it byte-for-byte untouched. The serial owner enforces a per-entity
barrier: a requeued or attention-requiring N blocks N+1 for that entity while another entity
may progress. A second trigger cannot dispatch the same intent, overtake the barrier, or
reinterpret a failed claim as deletion. This is level-triggered liveness, not a fixed loop and
not a dependency on observing an offline→online edge.

P2-63 removes that native session and its MutationCache replay registration after receipt-
backed migration. Mechanism 5 now owns the same stable identity, barrier, dependency,
attention and level-triggered semantics in SQLite; this paragraph remains lineage evidence,
not a callable native replay path.

The final P2-63 consolidation removes the callable AsyncStorage replay module entirely.
Platform-neutral `Intent` contracts live in `src/lib/intent.ts`; the old envelope parser and
restart-safe paused-mutation merge live in the explicitly migration-only
`src/lib/legacyIntentLog.ts`. That compatibility module has no replay, subscriptions, HTTP,
TanStack registration, or presentation role. It may be deleted only when the minimum
supported native build is SQLite-authoritative **and** two stable release cycles have shown
no remaining legacy migration source. Until that milestone, deleting it could strand an
accepted pre-cutover write on upgrade.

**Pending is not synced.** A client-minted id is not server acceptance. §5.4's `Pending`
indicator and offline bar are entity-generic and copy-parameterised (Phase 3's
`Plan will finish syncing` is a parameter of the same mechanism, not a second system); a
pending entity accepts no server-directed mutation until acknowledged (P2-58 would change
this and is parked), and which capabilities exist before acknowledgement is declared per
feature, defaulting to online-only. Sharing, invitations, expenses and settlements stay
online-only by nature.

**Platforms.** iOS only, exactly as the §3.5 table and ADR-024 already rule: a browser tab
is closed, not backgrounded, and a queue that never flushes is worse than an error toast.
The web keeps the persisted read cache and no mutation queue.

**5. SQLite materialized native state and transactional outbox (P2-61…P2-63, ADR-057).**

```
 local action ─► BEGIN IMMEDIATE
                 ├─ append outbox intent
                 ├─ materialize typed visible rows
                 └─ COMMIT ─► repository subscriptions ─► native UI

 connectivity / foreground / refresh ─► syncNow()
                                          │
                                          ▼
                             serialized push/pull engine
                                          │ transaction
                                          ├─ canonical response
                                          ├─ rematerialized rows
                                          └─ retire/park intent
```

One hashed database filename belongs to one immutable account namespace; metadata asserts
the owner before reads or replay. Sign-out closes/quarantines, account switching opens a
different database, confirmed deletion purges, and unresolved outbox work prevents age-based
deletion. Every open enables WAL and foreign keys. Migrations are monotonic and transactional.

Tables and repositories are domain-specific. Indexed columns own filters, ordering and render
fields; opaque nested values may use JSON. There is no generic entity table, `base_json` /
`view_json` contract, DynamoDB key mirror or ORM requirement. A verified server snapshot or
version may be retained for rollback/rebase, but the materialized row is what the UI queries.

The SQLite outbox preserves P2-59: stable mutation ids, canonically equivalent append as an
idempotent no-op, structured attention, durable inverse dependencies, explicit
`ordering_key` barriers, necessary receipts and bounded level-triggered replay. The serialized
sync engine may let unrelated keys progress but need not dispatch concurrently. Connectivity
never changes visible rows directly.

Recurring CREATE may materialize across known local coverage; one occurrence edit may update
its explicit row. Existing-series edits retain canonical rows with queued/updating state until
the targeted strong activity-agenda read atomically replaces that activity's rows, including
zero rows. Failure retains rows and records retryable sync state. Completion-relative
recurrence remains server-reconciled.

Legacy migration imports only provenance-verified server base plus all distinct intents,
statuses and dependencies in one transaction, verifies read-back, writes a receipt, then
retires old data. P2-60 overlay output is never canonical base; ambiguous provenance keeps
intents and schedules sync. Existing collection/detail endpoints, coverage-aware pulls,
canonical write responses, tombstones and targeted recurrence reconciliation are sufficient;
a generic change-feed/cursor is not a Phase 2.6 prerequisite.

After P2-63, the native persister filters `activity`, `activities` and `agenda` query roots on
both hydration and save. Startup reads the unfiltered legacy envelope only as migration input,
including expired/buster-old envelopes that may still contain user writes. It purges the
account AsyncStorage intent log and retires those query/mutation records only after SQLite
read-back receipts commit. Web persistence remains unchanged.

### 3.5 One codebase, two platforms

**Platform-specific files.** Metro and the web bundler resolve `.ios.tsx` / `.web.tsx` /
`.native.tsx` suffixes automatically. We use this sparingly — only where the platforms
genuinely differ:

| File | Why it forks |
| --- | --- |
| `src/lib/storage.web.ts` / `storage.ios.ts` | Keychain vs. in-memory + cookie. See `auth.md` §4. |
| `src/lib/queryClient.ts` / `queryClient.native.ts` | Web Activity/Agenda request/cache adapter vs. native non-domain queries only; SQLite owns the native domain. |
| Activity/Agenda base hooks / `.native.ts` hooks | Web uses the online-first TanStack/HTTP adapter; native uses typed SQLite repositories, coordinator, sync engine and outbox presentation. |
| `src/lib/push.web.ts` | No-op stub; web push is out of scope for v1. |
| `src/components/DateTimePicker.web.tsx` | Native wheel picker vs. `<input type="datetime-local">`. |
| `src/lib/haptics.web.ts` | No-op. |

Everything else uses `Platform.select()` inline for one- or two-line divergences, or
`Platform.OS === 'web'` guards. A file that is 60% platform branches should be split; a
file with one branch should not.

**Responsive layout.** Breakpoints live in `packages/ui/src/theme/breakpoints.ts` and are
read through a `useBreakpoint()` hook backed by `useWindowDimensions()`:

| Name | Min width | Layout |
| --- | --- | --- |
| `compact` | 0 | Single column, bottom tab bar, modals as full-screen sheets. iPhone and narrow browser windows. |
| `medium` | 768 | Single column capped at 720 px and centred; tab bar becomes a left rail. iPad, small laptop. |
| `expanded` | 1200 | Two panes: list on the left (400 px), detail on the right. Modals become centred dialogs. |

Layout is expressed in flexbox and percentage/`maxWidth` constraints, never in absolute
pixel positions, so the same tree reflows. No `Dimensions.get()` at module scope — it is
wrong after rotation and wrong on web resize.

**What web deliberately does differently:**

| Behaviour | iOS | Web | Reason |
| --- | --- | --- | --- |
| Public invite page (`/invite/:token`) | Not routed; deep links open the authed plan | The primary surface. Server-agnostic static page that fetches `/public/v1/invites/:token` | Non-users have no app. This route is the entire point of concept §15. |
| Push notifications | `expo-notifications` + Expo Push | Not implemented | Web Push needs a service worker, VAPID keys, and a separate permission model. Out of scope for v1. |
| Camera capture | Camera + library via `expo-image-picker` | File input (library/screenshot only) | No reliable cross-browser camera capture worth the code. |
| Token storage | Keychain via `expo-secure-store` | In-memory access token + HTTP-only refresh cookie | `auth.md` §4. |
| Navigation gestures | Swipe-back, sheet drag | Browser back/forward, real URLs, no drag-to-dismiss | Users expect the browser's model on web. |
| Animations | Reanimated worklets | Reanimated's web build (CSS/WAAPI backend); heavy list animations disabled at `compact` | Web animation fidelity is not worth debugging; correctness first. |
| Haptics | Yes | No-op | No API. |
| `⊕ Choose from Contacts` in the participant picker | OS contact picker via `expo-contacts` | **Row not rendered.** Manual name + email entry only | There is no OS picker on the web. The browser Contact Picker API is Chromium-on-Android only, so a shim would give web a capability iOS Safari and desktop lack. `03-implementation/phase-06-sharing.md` P6-37. |
| Offline | Typed SQLite repositories + transactional outbox after migration | Online-first TanStack adapter with persisted reads; durable mutation queue disabled | Native must survive process/connectivity transitions; a browser tab is usually closed, so queued mutations that never flush are worse than an error toast. |

**The web build ships as a static export.** `npx expo export --platform web` produces
`dist/` — HTML, JS, and assets, no server. Expo Router is configured with
`web.output: "static"` in `app.config.ts` so each route pre-renders to its own HTML file,
which gives the invite page a real URL that CloudFront can serve and crawlers can read.
CloudFront handles SPA fallback for dynamic segments (see `aws-services.md`).

---

## 4. Server architecture

### 4.1 Shape

One Lambda function, `od-api-{env}`, Node 22 on ARM64, invoked by API Gateway HTTP API
with a `$default` route so **all** paths reach the same function. Hono does the routing
inside.

```
services/api/src/
├─ index.ts               handler = handle(app)  — the Lambda entry point
├─ app.ts                 Hono instance, middleware chain, route mounting
├─ middleware/
│  ├─ requestId.ts
│  ├─ logger.ts
│  ├─ auth.ts             aws-jwt-verify
│  ├─ rateLimit.ts
│  ├─ idempotency.ts
│  └─ errorHandler.ts
├─ routes/                one file per resource; mirrors api-contract.md §2
│  ├─ me.ts   agenda.ts   activities.ts   participants.ts   attachments.ts
│  ├─ lists.ts  people.ts  expenses.ts  notifications.ts  capture.ts
│  └─ public/invites.ts
├─ handlers/              request → DTO → service call → response envelope
├─ services/              business rules. No AWS SDK types cross this boundary.
├─ repositories/          DynamoDB access. The only place pk/sk strings are constructed.
├─ lib/
│  ├─ ddb.ts              DocumentClient singleton
│  ├─ logger.ts           pino instance
│  ├─ errors.ts           AppError -> re-exports the shared error codes
│  └─ config.ts           env parsing, validated with Zod at module load
└─ reminder/              the separate reminder Lambda's entry point (see infrastructure.md)
```

### 4.2 Middleware chain, in order

Order is load-bearing. Each entry states what it does and why it sits where it does.

| # | Middleware | Does | Why here |
| --- | --- | --- | --- |
| 1 | `requestId` | Reads `X-Request-Id` or generates `req_<ulid>`; puts it on the context and the response header | Everything downstream logs it, including failures in later middleware. |
| 2 | `logger` | pino child logger bound to `requestId`, `route`, `userId` (once known); logs one line on completion with status and duration | Must wrap everything so timing includes all work. Redacts per `security-privacy.md` §4. |
| 3 | `errorHandler` (`app.onError`) | Maps thrown errors to the contract's error envelope | Registered early so it catches throws from every later middleware. |
| 4 | `cors` | Allows the web origins only (`https://ordinarydays.app`, `https://dev.ordinarydays.app`, `http://localhost:8081`); `credentials: true` | Must answer `OPTIONS` before auth rejects it as unauthenticated. |
| 5 | `securityHeaders` | `X-Content-Type-Options`, `Referrer-Policy`, `Cache-Control: no-store` by default | Cheap, applies to every response including errors. |
| 6 | `bodyLimit` | Rejects bodies over 256 KB with `413` | Before parsing, so a large body is never buffered into a JS object. |
| 7 | `routeSplit` | Resolves the route Hono matched against a **registry** in which every mounted route declares its `routeAuth` — `public` (`/public/v1/*`, by prefix), `unauthenticated-private` (`/v1/health`) or `authenticated` — and sets it on the context. A path matching neither prefix returns `404`; a path under a known prefix that nothing handled returns `501`. | The single place the public/private boundary is decided. See `auth.md` §7 and `phase-01-activity-core.md` P1-30. Registering a route is part of adding one: app construction throws when the registry and the mounted routes disagree. |
| 8 | `identity` | Reads `c.get('routeAuth')` from step 7 and, for an `authenticated` route, delegates to the module-scope `IdentityProvider` selected by `AUTH_MODE` and sets `c.set('userId', …)`. `LocalIdentityProvider` returns the constant `usr_local_dev`; `CognitoIdentityProvider` verifies the bearer ID token with `CognitoJwtVerifier` and returns the `custom:app_user_id` claim. | After CORS/limits, before anything that reads user data. It decides *whether* to resolve a user by asking step 7, never by re-deriving the boundary from the path. Nothing downstream knows which provider ran — see `phase-01-activity-core.md` P1-01. |
| 9 | `rateLimit` | DynamoDB counter keyed by `userId` (authed) or hashed IP (public); returns `429` + `Retry-After` | Needs the identity from step 8 for authed routes; runs with the IP key for public ones. |
| 10 | `idempotency` | On every mutating `POST`: reads `IDEM#<userId>#<key>`; on hit drains referenced cleanup before returning the stored status and body; on miss the domain transaction conditionally writes the receipt (and, for multi-phase work, a transaction-attached cleanup item) | After rate limiting so a retry storm cannot consume idempotency reads or contend on receipt writes for free. |
| 11 | `zValidator` (per route) | Validates params/query/body against the shared Zod schema | Route-local, because the schema differs per route. |
| 12 | Handler | — | — |

Authorisation (owner vs. participant vs. stranger) is **not** in this chain — it needs the
loaded activity. It lives in a single `assertActivityAccess(userId, activityId, level)`
helper in `services/authz.ts`, called at the top of every activity-scoped service method,
per `api-contract.md` §3.

### 4.3 Layering

```
route (Hono)  →  handler  →  service  →  repository  →  DynamoDBDocumentClient
```

| Layer | Owns | Must not |
| --- | --- | --- |
| Route | Path, method, per-route validator, calling one handler | Contain business logic |
| Handler | Mapping validated input to a service argument; wrapping the result in the `{ data, meta }` envelope; choosing the status code | Touch the AWS SDK; construct keys |
| Service | Business rules, authorisation checks, orchestration across repositories, transaction composition, domain errors | Know about HTTP, Hono, headers, or status codes |
| Repository | Key construction (`ACT#${id}` etc.), `Query`/`GetItem`/`TransactWriteItems`, cursor encode/decode, `schemaVersion` upgrade-on-read | Know about users' permissions or HTTP |
| `lib/ddb.ts` | One `DynamoDBDocumentClient` created at module scope with `removeUndefinedValues: true` | Be re-created per request |

Pure domain logic — recurrence expansion, split arithmetic, lexo ranks — lives in
`packages/shared`, not in `services/`. The service layer calls it. That is what makes it
testable without AWS and reusable by the client for optimistic updates.

### 4.4 Error to HTTP mapping

One error class, one table, one place.

```ts
// services/api/src/lib/errors.ts
import type { ErrorCode } from '@od/shared/errors';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: { path: string; message: string }[],
    readonly retryAfterSeconds?: number,
  ) { super(message); }
}
```

| Error code | HTTP | Thrown when | Body notes |
| --- | --- | --- | --- |
| `unauthenticated` | 401 | Missing, malformed, expired, or unverifiable token | `WWW-Authenticate: Bearer` |
| `forbidden` | 403 | Authenticated, identified as a participant, attempting an owner-only action | Only used where existence is already known to the caller |
| `not_found` | 404 | Resource absent **or** caller has no relationship to it | Never 403 for strangers — `api-contract.md` §3 |
| `validation_failed` | 400 | Zod failure, 62-day window exceeded, unparseable cursor | `details[]` from `ZodError.issues`, path-mapped |
| `payload_too_large` | 413 | Request body over 256 KB, rejected by `bodyLimit` before parsing | Added in P0-13 — see the note below |
| `conflict` | 409 | `If-Match` mismatch, deleting a person still on an active activity | Includes current `updatedAt` |
| `participant_limit_exceeded` | 422 | > 50 participants | — |
| `reminder_limit_exceeded` | 422 | > 3 reminders for one user on one activity | — |
| `series_limit_exceeded` | 200 | > 200 active series — returned as a `warnings[]` entry, not an error | Response still succeeds |
| `invite_expired` | 410 | Invite past expiry | Public surface |
| `invite_revoked` | 410 | `revoked: true` | Public surface |
| `rate_limited` | 429 | Over the limits in `api-contract.md` §4 | `Retry-After` |
| `not_implemented` | 501 | `/v1/capture/*` before Phase 8 | Stable stub |
| `upgrade_required` | 426 | Kill-switched client version | `updateUrl` in details |
| `internal` | 500 | Anything uncaught | Message is always the literal string `"An unexpected error occurred."` — never the exception text |

> **Added in P0-13: `payload_too_large`.** §4.2 requires `bodyLimit` to reject an oversized
> body with **413**, and no code in the closed union mapped to 413. Without one, that
> rejection either leaves through a status the contract does not describe, or through an
> envelope whose `code` says something untrue — `validation_failed` is a 400, and a body
> that was never parsed did not fail validation. Added to
> `packages/shared/src/errors.ts` and to `api-contract.md` §1 in the same PR.

`errorHandler` also translates `ZodError` → `validation_failed` and known DynamoDB errors:
`ConditionalCheckFailedException` → `conflict`, `TransactionCanceledException` with a
conditional-check reason → `conflict`, `ProvisionedThroughputExceededException` /
`RequestLimitExceeded` → `503` with `Retry-After: 1`. Every 5xx logs at `error` with the
stack; every 4xx logs at `warn` without one.

### 4.5 Cold start budget

**Budget: under 400 ms of init duration (p95) and under 700 ms total for a cold
`GET /v1/agenda`.** Warm p95 target is 60 ms server-side.

How it is held:

| Lever | Detail |
| --- | --- |
| ARM64 (Graviton2) | Cheaper per GB-second and, for this workload, no slower to boot than x86. |
| Memory 1024 MB | CPU scales with memory. 512 MB roughly doubles init time; above 1024 MB gains flatten. Re-measure with a power-tuning run before Phase 6 and adjust — this figure is a starting point, not a measurement. |
| esbuild bundle, ESM, minified, `target: node22` | One file, no `require` resolution walk over `node_modules` at boot. |
| Tree-shaken SDK imports | Import specific clients (`@aws-sdk/client-dynamodb`), never `aws-sdk`. Only clients actually used per code path are imported at module scope; SES, Scheduler, and Secrets Manager clients are lazily created inside the functions that need them. |
| Module-scope singletons | `DynamoDBDocumentClient`, `CognitoJwtVerifier`, and the pino logger are created once outside the handler and reused across warm invocations. The JWKS is fetched once and cached. |
| No dependency injection container, no ORM, no decorators, no `reflect-metadata` | Each of these adds tens of milliseconds of boot for no benefit at this size. |
| `NODE_OPTIONS` free of `--enable-source-maps` in prod | Source maps cost boot time; we ship them to the artifact store, not the runtime. Dev enables them. |
| Bundle size ceiling | CI fails if the zipped artifact exceeds **5 MB**. Checked in the build job. |

Explicitly **not** used: provisioned concurrency (it bills continuously and would break the
$0 target), SnapStart (Java/.NET only), and Lambda extensions.

A cold start budget test runs in CI as part of the deploy job: after a dev deploy, invoke
the function three times with a forced cold start (update an environment variable to
recycle execution environments) and fail the job if p95 init duration exceeds 400 ms.

---

## 5. `packages/shared`

The reason the monorepo exists. Everything here is isomorphic: no Node built-ins beyond
`node:crypto` behind a platform shim, no AWS SDK, no React.

```
packages/shared/src/
├─ index.ts
├─ types/           Activity, Recurrence, List, Person, Expense, … (data-model.md §4)
├─ schemas/         Zod schemas + inferred types. One file per resource.
│  ├─ activity.ts   createActivityInput, patchActivityInput, activity
│  ├─ list.ts  person.ts  expense.ts  agenda.ts  invite.ts  capture.ts
│  └─ common.ts     isoDate, hhmm, ianaTimezone, cents, ulidId, cursor
├─ recurrence/
│  ├─ expand.ts     expandRecurrence(rec, from, to, tz) — pure, no I/O
│  └─ describe.ts   "Every weekday at 6:00 PM" for the UI
├─ money/
│  ├─ split.ts      equal/exact/shares splitting with exact remainder distribution
│  └─ balance.ts    net balance computation from Expense rows and settledPersonIds;
│                   Settlement rows are audit-only and never balance deltas
├─ rank/            lexoRankBetween(a, b) for list reordering
├─ client/          Typed API client: one function per endpoint
│  ├─ http.ts       fetch wrapper: base URL, auth header injection, retry, error mapping
│  └─ endpoints/*.ts
├─ errors.ts        The closed ErrorCode union + AppErrorBody type
├─ constants.ts     Limits: MAX_PARTICIPANTS=50, MAX_AGENDA_DAYS=62, MAX_UPLOAD_BYTES
└─ openapi.ts       zod-to-openapi registration; emits docs/generated/openapi.json
```

### 5.1 The one rule

> **A validation schema is defined exactly once, in `packages/shared/src/schemas/`, and is
> imported by both the Lambda and the client. Neither side may define its own.**

Consequences that follow from it, and are enforced in review:

- The Lambda validates inbound requests with the same object the client used to build the
  request. A field the client can send is a field the server accepts, by construction.
- Types are **inferred**, never hand-written alongside a schema:
  `export type CreateActivityInput = z.infer<typeof createActivityInput>;`
- The client validates responses too, in dev and test builds. In production the response
  parse is `safeParse` and a failure logs a warning rather than throwing — a server that
  added a field must not break a shipped app.
- `docs/generated/openapi.json` is generated from these schemas and checked in. CI
  regenerates and fails on a diff, so the spec cannot drift.
- Any limit that both sides enforce (participant cap, agenda window, upload size) is a
  constant in `constants.ts`, imported by both. Two copies of `50` is a bug waiting.

### 5.2 What must never enter `shared`

React or React Native imports (that is `packages/ui`), AWS SDK clients, `process.env`
reads, DynamoDB key construction, or anything that makes a network call other than through
the injected `fetch` in `client/http.ts`.

---

## 6. Version policy

- **Exact versions are pinned in `pnpm-lock.yaml`.** `.npmrc` sets `save-exact=true`;
  `package.json` therefore also carries exact versions, not ranges. The lockfile is
  committed and CI installs with `--frozen-lockfile`.
- The table in §2 gives the **minimum major** we target. Anything at or above that major
  is acceptable; anything below is not.
- Expo-managed packages (`expo-*`, `react-native`, `react`, `react-native-web`,
  `react-native-reanimated`, `react-native-gesture-handler`) are upgraded **only** via
  `npx expo install --fix` after an SDK bump. Their versions are dictated by the SDK, not
  by us. `npx expo-doctor` runs in CI and fails on a mismatch.
- Security-only transitive patch floors live in root `package.json#pnpm.overrides`; they add
  no direct dependency and are removed once every parent resolves a safe version without the
  override. The 2026-08-11 audit baseline floors are `minimatch@9.0.7` and `postcss@8.5.18`.
- Node is pinned in `.nvmrc`, `package.json#engines`, and the CDK Lambda runtime
  (`Runtime.NODEJS_22_X`). All three must agree; a CI check asserts it.
- Dependency updates arrive as grouped Dependabot PRs weekly (patch/minor grouped, major
  individual). See `security-privacy.md` §7.
