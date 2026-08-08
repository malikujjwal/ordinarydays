// Metro's config. A deliberate passthrough — see the amendment in `tech-stack.md` §3.3.
//
// §3.3 prescribes three overrides for workspace support. Under Expo SDK 54 all three are
// wrong, and `getDefaultConfig` already does the job, which was checked rather than assumed:
//
//   watchFolders             the default is the root `node_modules` plus every workspace
//                            package, including `packages/shared`. The doc's `[workspaceRoot]`
//                            replaces those six precise entries with one broad one and drops
//                            the `node_modules` entry symlinked packages resolve through.
//                            `expo-doctor` fails the project for it.
//   nodeModulesPaths         the default is already exactly
//                            `[<project>/node_modules, <workspace root>/node_modules]`.
//   disableHierarchicalLookup  the default is `false`, and it has to stay false. It is a
//                            Yarn/npm hoisted-monorepo setting, incompatible with this
//                            repository's `node-linker=isolated`: under pnpm a package's own
//                            dependencies live in `node_modules/.pnpm/<pkg>@<ver>/node_modules/`
//                            and are reachable only by walking up from the importing file.
//                            Setting it true makes every transitive dependency unresolvable —
//                            `expo-router` importing `@react-navigation/native` is simply the
//                            first to fail.
//
// The file stays because it is where a real Metro change belongs, and because a future
// SDK's defaults are worth re-checking against the three lines above.
//
// CommonJS on purpose: Metro loads this with `require`, so `apps/mobile` must not declare
// `"type": "module"`.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
