/**
 * Criterion 8's device-side half: UP NEXT advances off the local minute ticker.
 *
 * Both fixtures are created by `setup.js` before the app ever launches, and the proxy's
 * request log is reset at the end of setup. Nothing in this flow writes. So the agenda the
 * server would serve after foregrounding is identical to the one it served before, and
 * proving that no write reached the API is enough to prove the UP NEXT advance from
 * `firstTitle` to `secondTitle` came from the ticker rather than from newly arrived data.
 *
 * This deliberately does **not** assert the absence of a GET refetch. Foregrounding does
 * refetch the current key — `useAgenda`'s `AppState` listener, shipped in P2-18 and covered
 * by its own unit test — and asserting the opposite here would make an E2E flow the reason a
 * shipped behaviour was deleted.
 */
const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:8474';
const stats = JSON.parse(http.get(`${CONTROL}/stats`).body);
const routes = Object.keys(stats.byRoute);

const writes = routes
  .filter((route) => route.includes(' /v1/') && !route.startsWith('GET '))
  .map((route) => `${route} x${stats.byRoute[route]}`);
if (writes.length > 0) {
  throw new Error(
    `UP NEXT must advance from the local ticker with the data unchanged, but the flow issued: ${writes.join(', ')}`,
  );
}

const agendaReads = routes
  .filter((route) => route === 'GET /v1/agenda')
  .reduce((total, route) => total + stats.byRoute[route], 0);
if (agendaReads === 0) {
  throw new Error(
    'The app never requested an agenda, so the UP NEXT assertion proved nothing.',
  );
}
