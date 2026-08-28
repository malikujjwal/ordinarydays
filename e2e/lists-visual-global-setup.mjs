import { once } from 'node:events';

/**
 * The visual suite owns its static server in-process so Windows can close it deterministically.
 * Playwright's child-process webServer teardown can leave the command waiting after every test
 * has passed; returning this close function makes process lifetime part of the gate.
 */
export default async function listsVisualGlobalSetup() {
  const { server } = await import('./serve-export.mjs');
  if (!server.listening) await once(server, 'listening');

  return async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  };
}
