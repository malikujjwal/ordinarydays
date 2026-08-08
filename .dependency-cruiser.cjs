/**
 * The architectural rules from `docs/04-conventions/repo-structure.md` §3 and §4, as
 * something CI can fail on.
 *
 * These are the mechanical half of `CLAUDE.md`'s non-negotiables. Biome still runs — it owns
 * formatting, unused code and specifier-level bans — but it matches import *specifiers*, and
 * the rules that matter here are about **reachability**: "nothing under `services/`
 * `routes/`, `handlers/`, `services/` or `middleware/` may reach `lib/ddb.ts`, however many
 * hops it takes" is not something a lint rule can express. `dependency-cruiser` resolves the
 * real module graph, so a violation laundered through three re-exports still fails.
 *
 * **Configured in Phase 0, when most of these have nothing to catch.** `shared-is-a-leaf`,
 * `ui-is-a-leaf`, `no-react-in-shared`, `no-aws-sdk-in-shared-or-ui` and
 * `no-server-code-in-client` have real subjects today; `ddb-only-in-repositories`,
 * `layers-are-one-way` and `no-cross-feature-imports` have none until Phases 1 to 3 and are
 * written anyway. A rule added after the violating import exists is a refactor and an
 * argument; added before, it is a two-second CI step nobody has ever had to debate.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'A cycle at any granularity — package, directory or file. `repo-structure.md` §3 ' +
        'rule 7. Cycles make module initialisation order load-bearing, which surfaces as an ' +
        'undefined import at runtime in whichever file happened to be evaluated first.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    {
      name: 'shared-is-a-leaf',
      comment:
        '`packages/shared` imports no workspace package (§3 rule 1). It is imported by the ' +
        'app, the API and infra, so anything it reaches becomes a dependency of all three.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^(packages/ui|apps|services|infra)/' },
    },

    {
      name: 'ui-is-a-leaf',
      comment:
        '`packages/ui` imports no workspace package, not even `@od/shared` (§3 rule 2). A ' +
        'primitive that needs a domain type is not a primitive; it is a feature component ' +
        'and belongs in `apps/mobile/src/features/<f>/components/`. This is what keeps the ' +
        'dependency graph a tree rather than a diamond, and keeps `ui` extractable.',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: '^(packages/shared|apps|services|infra)/' },
    },

    {
      name: 'not-to-unresolvable',
      comment:
        "An import that does not resolve. Under pnpm's strict linking this is how a " +
        'forbidden dependency usually presents: `packages/shared` importing ' +
        '`@aws-sdk/client-dynamodb` cannot resolve it, because `shared` does not declare ' +
        'it. Without this rule dependency-cruiser reports **nothing** for that import — ' +
        'the module-path bans below never match, because an unresolved dependency has no ' +
        'resolved path to match against. Verified in P0-27 by writing exactly that file ' +
        'and watching the suite pass. It catches typos and deleted modules too.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },

    {
      name: 'no-aws-sdk-in-shared-or-ui',
      comment:
        'Neither leaf package may reach an AWS SDK, the CDK or the JWT verifier. `shared` ' +
        'ships to the phone inside the app bundle; an SDK client in it is dead weight in ' +
        'the download and a signal that server code has drifted into the isomorphic layer.',
      severity: 'error',
      from: { path: '^packages/(shared|ui)/' },
      to: { path: '(^|node_modules/)(@aws-sdk|aws-cdk-lib|aws-jwt-verify)' },
    },

    {
      name: 'no-react-in-shared',
      comment:
        '`packages/shared` runs in the Lambda as well as in the app. A React import there ' +
        'is either a hook that cannot run server-side or a component in the wrong package.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '(^|node_modules/)(react|react-native|react-native-web)(/|$)' },
    },

    {
      name: 'no-server-code-in-client',
      comment:
        'Nothing imports `services/api` or `infra` (§3 rule 6). The client talks to the API ' +
        'over HTTP through `@od/shared/client`; reaching into the handler would bundle the ' +
        'server — and its DynamoDB key construction — into the app.',
      severity: 'error',
      from: { path: '^apps/mobile/' },
      to: { path: '^(services|infra)/' },
    },

    {
      name: 'ddb-only-in-repositories',
      comment:
        'The `DynamoDBDocumentClient` is reachable only from `services/api/src/repositories/**` ' +
        '(`CLAUDE.md`, `tech-stack.md` §4.3). Key construction in one layer is what makes ' +
        'tenant isolation auditable: there is one place to check that every key is scoped to ' +
        'the caller. Nothing to catch until Phase 1, which is the point of writing it now.',
      severity: 'error',
      /**
       * **`from` is everything except the repository layer**, rather than the four layer
       * directories `repo-structure.md` §4 lists. That is deliberate and it is stronger.
       *
       * §4 chose this tool because a lint rule "cannot express: files under
       * `services/api/src/services/` may not reach `lib/ddb.ts` transitively". A direct-edge
       * rule from those four directories cannot express it either — verified in P0-27, where
       * a scratch middleware importing a scratch `lib/` module that imported `ddb.ts` passed
       * without a murmur. And the obvious fix, `reachable: true`, is worse than useless
       * here: the *legitimate* architecture is routes → handlers → services → repositories →
       * `ddb.ts`, so reachability would flag every correct route. `via`/`viaOnly` cannot
       * rescue it, because in v18 those apply to circular rules only.
       *
       * Naming the whole repository as `from` closes the laundering path at its own edge
       * instead: any module outside `repositories/` that imports `ddb.ts` fails, so there is
       * nothing left for a handler to launder the import through.
       */
      from: { pathNot: '^services/api/src/repositories/' },
      to: { path: '^services/api/src/lib/ddb\\.ts$' },
    },

    {
      name: 'no-sdk-outside-repositories-and-lib',
      comment:
        'The same rule one level out: a handler that reaches an AWS SDK directly has ' +
        'bypassed the repository layer even if it never touches `ddb.ts`.',
      severity: 'error',
      // Everything except the two layers allowed to hold an SDK client, for the same
      // laundering reason as the rule above. `lib/` is included because `lib/ddb.ts` is
      // where the client is constructed.
      from: {
        path: '^services/api/src/',
        pathNot: '^services/api/src/(repositories|lib)/',
      },
      to: { path: '(^|node_modules/)@aws-sdk/' },
    },

    {
      name: 'no-hono-in-services',
      comment:
        'HTTP is a transport concern. A service or repository that imports Hono has taken a ' +
        'dependency on how it was called, which is what makes business rules untestable ' +
        'without a request object.',
      severity: 'error',
      from: { path: '^services/api/src/(services|repositories)/' },
      to: { path: '(^|node_modules/)hono(/|$)' },
    },

    {
      name: 'layers-are-one-way',
      comment:
        'routes → handlers → services → repositories → lib/ddb.ts, and never back up ' +
        '(§3.1). A repository that calls a service is a repository that can be made to ' +
        'depend on an authorisation decision it is supposed to be underneath.',
      severity: 'error',
      from: { path: '^services/api/src/repositories/' },
      to: { path: '^services/api/src/(services|handlers|routes)/' },
    },

    {
      name: 'no-cross-feature-imports',
      comment:
        'Feature slices are vertical. `agenda/` reaching into `lists/` is how two features ' +
        'become one feature nobody can change independently; shared pieces belong in ' +
        '`src/components/`, `src/hooks/` or `@od/ui`.',
      severity: 'error',
      from: { path: '^apps/mobile/src/features/([^/]+)/' },
      to: {
        path: '^apps/mobile/src/features/([^/]+)/',
        pathNot: '^apps/mobile/src/features/$1/',
      },
    },

    {
      name: 'no-orphans',
      comment:
        'A module nothing imports. `warn`, not `error`, and it stays that way: config ' +
        'files, `.d.ts` shims and generation scripts trip it constantly, and a warning that ' +
        'is always present is a rule nobody reads (P0-27). If it becomes noise, tighten ' +
        '`pathNot` rather than deleting the rule.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.(d\\.ts|config\\.(ts|js|cjs|mjs))$',
          // Entry points, which are orphans by definition: nothing in the repo imports the
          // Lambda handler, the dev server, the CDK app or a generation script.
          '^apps/mobile/app/',
          '^(infra/bin|packages/shared/scripts|services/api/scripts)/',
          '^services/api/src/(index|local)\\.ts$',
          '^infra/lib/functions/',
          // Package barrels. `@od/ui`'s is empty until P1-22 and `@od/shared`'s is reached
          // through the `exports` map, which dependency-cruiser does not follow.
          '^packages/(shared|ui)/src/index\\.ts$',
          // Test fixtures exist to be read by a test, and tests are excluded below.
          '/(fixtures|__fixtures__)/',
          // The 100%-coverage placeholders (P0-24). Deliberately imported by nothing but
          // their own tests; these two entries are deleted with the files, in P2-01 and
          // Phase 7 respectively.
          '^packages/shared/src/(recurrence|money)/placeholder\\.ts$',
          /**
           * Collateral from the `.tsx` exclusion below, not a real orphan: these are
           * imported by `app/_layout.tsx` and `app/(app)/index.tsx`, which the cruise
           * cannot parse. Delete this entry when `.tsx` can be cruised again — it is the
           * clearest measure of what that exclusion costs.
           */
          '^apps/mobile/src/lib/(apiClient|queryClient)\\.ts$',
        ],
      },
      to: {},
    },
  ],

  options: {
    /**
     * **swc, not the TypeScript compiler.**
     *
     * dependency-cruiser prefers `tsc` and falls back to swc, and with TypeScript 7 the
     * `tsc` path is simply unavailable: v7 is the native (Go) compiler and does not expose
     * the JavaScript API this tool needs. Left on the default it reports
     * `missing-typescript-transpiler`, then **exits 0 having cruised 3 modules and 0
     * dependencies** — a green check that has inspected nothing, which is the worst
     * possible outcome for a file whose entire job is to fail loudly.
     *
     * `@swc/core` parses TypeScript natively, needs no `typescript` package, and sees
     * `import type` edges — which several rules above depend on, because a type-only import
     * of a repository from a handler is still a layering violation.
     *
     * This is the third tool to collide with the TypeScript 7 decision (`tech-stack.md`
     * §2.1's "revisit if" clause), after the Expo CLI in P0-19. Unlike that one it has no
     * scoped fix: dependency-cruiser declares no `typescript` peer, so it resolves whatever
     * the root hoists and a pnpm override cannot reach it.
     */
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    doNotFollow: { path: 'node_modules' },

    /**
     * Without this, every **subpath export** is reported as unresolvable — `hono/factory`,
     * `hono/cors`, `@od/shared/schemas`, all of which are correct imports of packages that
     * are installed. The default resolver does not consult `exports` maps, and this
     * repository routes almost everything through them: `@od/shared` deliberately exposes
     * `./schemas`, `./client` and `./table` rather than one barrel, so that a consumer
     * cannot reach code it has no business having (`tech-stack.md` §3.3).
     *
     * `conditionNames` includes `require` alongside `import` because Hono publishes both,
     * and omitting it makes half its subpaths unresolvable.
     */
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
    exclude: {
      path: [
        'node_modules',
        '\\.test\\.tsx?$',
        '(^|/)(dist|cdk\\.out|coverage|\\.expo|\\.turbo)/',
        /**
         * **`.tsx` cannot be cruised, and this is a real hole rather than a preference.**
         *
         * dependency-cruiser 18.1.1's swc parser hard-codes `syntax: "typescript"` with no
         * `tsx` flag — its own source carries the comment `// TODO: {tj}sx ?` — so every
         * `.tsx` file is a parse error, not a skipped file. The `tsc` parser would handle
         * them, and it is unavailable under TypeScript 7.
         *
         * What that costs today is small and grows: the only `.tsx` files are the four
         * thin Expo Router route files, whose logic lives in hooks and feature components
         * that *are* cruised. It stops being small in Phase 1, when
         * `no-cross-feature-imports` starts mattering and feature components are `.tsx`.
         *
         * `scripts/check-forbidden.mjs` covers the two client rules textually in the
         * meantime, so the gap is narrowed rather than merely noted. The real fix is
         * `tech-stack.md` §2.1's own fallback, and it is one line — see the P0-27 pull
         * request.
         */
        '\\.tsx$',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
