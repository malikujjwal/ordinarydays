#!/usr/bin/env node
import { buildApp } from '../lib/app.js';

/**
 * The CDK CLI entry point. `cdk.json` runs `node dist/bin/ordinarydays.js`, and CDK
 * synthesises the app at process exit.
 *
 * Thin on purpose. The app itself is `lib/app.ts` so that `test/all-stacks.test.ts` can
 * build the real thing and sweep every stack in it — including the ones Phases 4 to 9 add —
 * without importing a module whose top level constructs an app as a side effect.
 */
buildApp();
