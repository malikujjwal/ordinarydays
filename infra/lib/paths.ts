import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Paths into the workspace, resolved from the workspace root rather than from this file.
 *
 * `infra` compiles to `infra/dist/`, so a path built from a fixed number of `..` segments
 * off `import.meta.url` means one thing in the source tree and a different thing in the
 * built output that `cdk.json` actually runs. That mistake resolves to a directory that
 * does not exist and fails at synth with a confusing "cannot find entry file".
 *
 * Walking up for `pnpm-workspace.yaml` is correct in both layouts, and stays correct if the
 * compiled output ever moves.
 */
function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the workspace root: no pnpm-workspace.yaml above ' +
      dirname(fileURLToPath(import.meta.url)),
  );
}

const WORKSPACE_ROOT = findWorkspaceRoot();

export const fromWorkspaceRoot = (...segments: string[]): string =>
  join(WORKSPACE_ROOT, ...segments);

/**
 * The API Lambda's entry point.
 *
 * A **path**, not an import: `repo-structure.md` §3 forbids `infra` from importing
 * `services/api`, and this does not. `NodejsFunction` hands it to esbuild, which is what
 * makes `cdk synth` compile the API and therefore what makes a broken API build a failing
 * CI job (`infrastructure.md` §1.3).
 */
export const API_ENTRY = fromWorkspaceRoot('services', 'api', 'src', 'index.ts');
