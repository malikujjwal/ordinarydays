import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

/**
 * The local dev server. **Never bundled** — `NodeLambda` entries at `index.ts`, and
 * `@hono/node-server` is a devDependency so it cannot reach the deployed artifact.
 *
 * Binds `0.0.0.0`, not `localhost`: P0-22 loads the app on a physical iPhone over the LAN,
 * and a server bound to the loopback interface is unreachable from the phone. That is the
 * single most common cause of "it works on the simulator and not on the device".
 */
const port = Number(process.env.PORT ?? 3000);

export const server = serve(
  { fetch: createApp().fetch, port, hostname: '0.0.0.0' },
  (info) => {
    // `stage` is not repeated here: pino's `base` already puts it on every line, and a
    // duplicate key in a JSON log makes CloudWatch Logs Insights parse the line wrong.
    logger.info({ port: info.port, ddbEndpoint: config.DDB_ENDPOINT }, 'api listening');
  },
);
