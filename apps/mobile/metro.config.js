// Metro's config. Expo owns the monorepo defaults; the one resolver bridge below keeps the
// shared package's Node ESM output and React Native source entry compatible.
//
// §3.3 prescribes three overrides for workspace support. Under Expo SDK 57 all three are
// still wrong (re-checked against `getDefaultConfig` after the 57 hop), and `getDefaultConfig`
// already does the job:
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
//                            Setting it true makes every transitive dependency unresolvable.
//
// A future SDK's defaults are still worth re-checking against the three lines above.
//
// CommonJS on purpose: Metro loads this with `require`, so `apps/mobile` must not declare
// `"type": "module"`.
const { getDefaultConfig } = require('expo/metro-config');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const config = getDefaultConfig(__dirname);
const sharedSourceRoot = resolve(__dirname, '..', '..', 'packages', 'shared', 'src');

function isInsideSharedSource(filePath) {
  const fromSharedRoot = relative(sharedSourceRoot, filePath);
  return (
    fromSharedRoot !== '..' &&
    !fromSharedRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromSharedRoot)
  );
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    isInsideSharedSource(context.originModulePath)
  ) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      // TypeScript preserves `.js` in ESM output so Node can run `dist/`. React Native reads
      // the package's `src/*.ts` export instead, where that emitted file does not exist.
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    }
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
