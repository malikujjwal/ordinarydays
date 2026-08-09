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
          // Vitest setup files (P1-31). Referenced by string from `setupFiles` in a vitest
          // config, so nothing *imports* them and the module graph cannot see the edge.
          // Tightening `pathNot` is what this rule's own note prescribes over tolerating a
          // permanent warning.
          '(^|/)vitest\\.setup\\.ts$',
          // Test doubles reached through a vitest `resolve.alias` (P1-22's `react-native-svg`
          // stub). Same shape of invisibility: the edge is a config string, not an import.
          '^packages/ui/test/',
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
        ],
      },
      to: {},
    },
  ],

  options: {
    /**
     * `tsPreCompilationDeps` makes **`import type` edges visible**, which several rules
     * above depend on: a type-only import of a repository from a handler is still a
     * layering violation, and without this it is invisible.
     *
     * It also selects the `tsc` parser, and that is load-bearing. dependency-cruiser needs
     * the TypeScript compiler's JavaScript API; the 7.x native compiler does not have one,
     * and on it this tool reports `missing-typescript-transpiler` and then **exits 0 having
     * cruised 3 modules and 0 dependencies** — a green check that inspected nothing, which
     * is the worst possible outcome for a file whose whole job is to fail loudly. P0-27
     * worked around that with `@swc/core`, whose parser cannot read `.tsx` at all and so
     * blinded the two client rules to every component file.
     *
     * `tech-stack.md` §2.1 pins the repository to `typescript@5.9.3` instead, substantially
     * because of this file. **If that pin is ever lifted, re-check this line and the module
     * count** — the failure is silent.
     */
    tsPreCompilationDeps: true,
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
         * Ambient declarations only. `apps/mobile/types/expo.d.ts` references `expo/types`,
         * a types-only subpath with no runtime entry, so it cannot be resolved and would
         * trip `not-to-unresolvable` on every run.
         *
         * **`.tsx` is deliberately absent from this list.** P0-27 had to exclude it, because
         * the swc parser it was forced onto cannot read TSX at all; that blinded the two
         * client rules to every component file. The compiler pin in `tech-stack.md` §2.1
         * removed the need, and `no-cross-feature-imports` was verified to fire on a `.tsx`
         * violation — including the relative-path form that the textual fallback misses.
         */
        '\\.d\\.ts$',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
