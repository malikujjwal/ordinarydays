import http from 'node:http';

const listenPort = Number(process.env.MAESTRO_PROXY_PORT ?? 3000);
const controlPort = Number(process.env.MAESTRO_CONTROL_PORT ?? 8474);
const upstream = new URL(process.env.MAESTRO_API_URL ?? 'http://127.0.0.1:3001');

let online = true;
let requests = [];
let plansRequests = [];
let holdPlans = false;
let heldPlans = [];
const timers = new Set();
function later(callback, delay) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delay);
  timers.add(timer);
}

function releasePlans() {
  holdPlans = false;
  const pending = heldPlans;
  heldPlans = [];
  for (const forward of pending) forward();
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function stats() {
  const byRoute = {};
  for (const request of requests) {
    const key = `${request.method} ${request.pathname}`;
    byRoute[key] = (byRoute[key] ?? 0) + 1;
  }
  return { online, total: requests.length, byRoute, plansRequests };
}

const proxy = http.createServer((request, response) => {
  if (!online) {
    request.socket.destroy();
    return;
  }

  const incoming = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );
  requests.push({ method: request.method ?? 'GET', pathname: incoming.pathname });
  if (incoming.pathname === '/v1/plans') {
    // Retain only navigation bounds: never headers, credentials or arbitrary query fields.
    const query = incoming.searchParams;
    const mode = query.get('mode');
    plansRequests.push({
      mode,
      from: query.get(mode === 'past_window' ? 'pastFrom' : 'upcomingFrom'),
      through: query.get(mode === 'past_window' ? 'pastBefore' : 'upcomingTo'),
    });
  }
  const headers = { ...request.headers, host: upstream.host };
  delete headers.connection;

  const forward = () => {
    const forwarded = http.request(
      new URL(`${incoming.pathname}${incoming.search}`, upstream),
      { method: request.method, headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    forwarded.on('error', () => {
      if (!response.headersSent) json(response, 502, { error: 'upstream unavailable' });
      else response.destroy();
    });
    request.pipe(forwarded);
  };
  if (holdPlans && incoming.pathname === '/v1/plans') heldPlans.push(forward);
  else forward();
});

const control = http.createServer((request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );
  if (request.method === 'POST' && url.pathname === '/online') {
    online = true;
    releasePlans();
    json(response, 200, stats());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/hold-plans') {
    holdPlans = true;
    json(response, 200, stats());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/release-plans') {
    releasePlans();
    json(response, 200, stats());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/offline') {
    online = false;
    json(response, 200, stats());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/reset') {
    requests = [];
    plansRequests = [];
    json(response, 200, stats());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/stats') {
    json(response, 200, stats());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/wait') {
    const epoch = Number(url.searchParams.get('epoch'));
    if (!Number.isFinite(epoch)) {
      json(response, 400, { error: 'epoch is required' });
      return;
    }
    later(
      () => json(response, 200, { now: Date.now() }),
      Math.max(0, epoch - Date.now()),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/wait-for-activity') {
    const title = url.searchParams.get('title');
    const date = url.searchParams.get('date');
    if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      json(response, 400, { error: 'title and date are required' });
      return;
    }
    const agenda = new URL('/v1/agenda', upstream);
    agenda.search = new URLSearchParams({
      from: date,
      to: date,
      tz: 'America/New_York',
      include: 'anytime_unscheduled,overdue',
    }).toString();
    // Observe durable server state, not merely a queued or started POST. This is the
    // existing harness wait deadline, not an application performance requirement.
    const deadline = Date.now() + 20_000;
    const poll = async () => {
      try {
        const result = await fetch(agenda, {
          signal: AbortSignal.timeout(2000),
          headers: { 'X-Client-Timezone': 'America/New_York' },
        });
        if (result.ok) {
          const body = await result.json();
          const rows = (body.data?.days ?? []).flatMap((day) => [
            ...(day.schedule ?? []),
            ...(day.anytime ?? []),
            ...(day.earlier ?? []),
          ]);
          const activity = rows.find((item) => item.title === title);
          if (activity) {
            json(response, 200, { activityId: activity.activityId });
            return;
          }
        }
      } catch {
        /* Reconnection can precede the API becoming available. */
      }
      if (Date.now() >= deadline)
        json(response, 408, { error: 'Activity did not persist' });
      else if (!response.destroyed) later(poll, 100);
    };
    void poll();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/wait-for-item') {
    const listId = url.searchParams.get('listId');
    const itemId = url.searchParams.get('itemId');
    const note = url.searchParams.get('note');
    if (
      !/^lst_[0-9A-HJKMNP-TV-Z]{26}$/.test(listId ?? '') ||
      !/^itm_[0-9A-HJKMNP-TV-Z]{26}$/.test(itemId ?? '') ||
      note === null
    ) {
      json(response, 400, { error: 'listId, itemId and note are required' });
      return;
    }
    const deadline = Date.now() + 20_000;
    const poll = async () => {
      try {
        const result = await fetch(
          new URL(`/v1/lists/${listId}/items/${itemId}`, upstream),
          {
            signal: AbortSignal.timeout(2000),
            headers: { 'X-Client-Timezone': 'America/New_York' },
          },
        );
        if (result.ok && (await result.json()).data?.note === note) {
          json(response, 200, { persisted: true });
          return;
        }
      } catch {
        /* Reconnection can precede the API becoming available. */
      }
      if (Date.now() >= deadline)
        json(response, 408, { error: 'Item note did not persist' });
      else if (!response.destroyed) later(poll, 100);
    };
    void poll();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/wait-for-completions') {
    const expected = Number(url.searchParams.get('count'));
    const deadline = Date.now() + 20_000;
    const poll = () => {
      const count = requests.filter(
        ({ method, pathname }) =>
          method === 'POST' && /^\/v1\/activities\/[^/]+\/complete$/.test(pathname),
      ).length;
      if (count >= expected) json(response, 200, { count });
      else if (Date.now() >= deadline) json(response, 408, { count, expected });
      else later(poll, 100);
    };
    poll();
    return;
  }
  json(response, 404, { error: 'not found' });
});

proxy.listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(
    `mobile proxy listening on ${listenPort}, upstream ${upstream.href}\n`,
  );
});
control.listen(controlPort, '0.0.0.0', () => {
  process.stdout.write(`mobile proxy control listening on ${controlPort}\n`);
});

function close() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  heldPlans = [];
  proxy.close();
  control.close();
  proxy.closeAllConnections();
  control.closeAllConnections();
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
