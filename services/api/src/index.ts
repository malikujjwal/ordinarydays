import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';

/**
 * The deployed entry point. Thin by design: the same Hono app runs under the Lambda adapter
 * here and under Node in `local.ts`, so local behaviour and deployed behaviour differ only
 * in the adapter (`infrastructure.md` §6.2).
 */
export const handler = handle(createApp());
