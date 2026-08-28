#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves `apps/mobile/dist` — the `expo export --platform web` output — for the Playwright
 * run (P1-29).
 *
 * ## Why a file rather than a package
 *
 * The obvious alternative is a static-server dependency. This is ~90 lines and no dependency,
 * and more importantly a generic server would be **wrong** here: `app.config.ts` sets
 * `web.output: 'static'`, so every route pre-renders to its own `.html` file rather than to a
 * single SPA shell. A server that fell everything back to `index.html` would serve the Today
 * tab's HTML for `/plans` and the test would pass or fail for reasons that have nothing to do
 * with the app. The resolution order below is that export's layout, written down.
 *
 * It is also what CloudFront will have to do in Phase 5, which makes getting it right here
 * worth more than the dependency it saves.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'apps', 'mobile', 'dist');
const PORT = Number(process.env.E2E_WEB_PORT ?? 8082);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/**
 * The one dynamic-route case: `/activity/abc123` has no `abc123.html`, and the export writes
 * the segment's literal Expo filename — `activity/[id].html`. Matched by looking for a single
 * bracketed sibling rather than by parsing the route table, because the filename *is* the
 * route table.
 */
function dynamicSibling(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return undefined;
  // Cheap and deterministic: one bracketed file per directory is what expo-router emits.
  const match = readdirSync(directory).find(
    (name) => name.startsWith('[') && name.endsWith('.html'),
  );
  return match === undefined ? undefined : join(directory, match);
}

/**
 * A URL path to a file on disk, in the order the export's layout implies.
 *
 * `undefined` means "nothing matched", which is a 404 and `+not-found.html` — the same page
 * the app itself renders for an unknown route, so a wrong link looks the same in the test as
 * it does to a user.
 */
function resolve(urlPath) {
  // `normalize` plus the prefix check is the path-traversal guard: a request for
  // `/../../etc/passwd` resolves outside DIST and is refused rather than served.
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const base = join(DIST, relative);
  if (!base.startsWith(DIST + sep) && base !== DIST) return undefined;

  if (relative === '' || relative === '.') return join(DIST, 'index.html');
  if (isFile(base)) return base;
  if (isFile(`${base}.html`)) return `${base}.html`;
  if (isFile(join(base, 'index.html'))) return join(base, 'index.html');

  const parent = dirname(base);
  const fallback = dynamicSibling(parent);
  if (fallback !== undefined) return fallback;

  return undefined;
}

export const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://localhost:${PORT}`).pathname;
  const file = resolve(path);

  if (file === undefined) {
    const notFound = join(DIST, '+not-found.html');
    if (isFile(notFound)) {
      response.writeHead(404, { 'Content-Type': TYPES['.html'] });
      createReadStream(notFound).pipe(response);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    // No caching. A stale bundle served to a test is a failure nobody can reproduce.
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

if (!existsSync(DIST)) {
  console.error(`No web export at ${DIST}.\n  Run: pnpm --filter @od/mobile build\n`);
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`e2e static server: ${DIST} on http://127.0.0.1:${PORT}`);
});
