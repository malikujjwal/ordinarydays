import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/openapi.js';

/**
 * Writes `docs/generated/openapi.json`.
 *
 * All the thinking lives in `src/openapi.ts`, which is pure and tested. This is the I/O
 * half, kept separate for the same reason `create-local-table.ts` is: a module that writes
 * a file when imported cannot be asserted in a test.
 *
 * The output is **checked in** and CI fails on a diff, so the formatting below is part of
 * the contract rather than a preference:
 *
 * - Two-space indent and a trailing newline, matching every other JSON file in the repo and
 *   keeping `git diff` legible.
 * - The document is serialised exactly as the generator produces it. No key sorting, no
 *   post-processing — a transform here is a place the spec can differ from the schemas,
 *   which is the one property this whole harness exists to guarantee.
 */
const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(here, '..', '..', '..', 'docs', 'generated', 'openapi.json');

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');

console.log(`Wrote ${outputPath}`);
