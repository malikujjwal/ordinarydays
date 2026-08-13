import http from 'node:http';

const listenPort = 3000;
const controlPort = 8474;
const upstream = new URL('http://127.0.0.1:3001');

let online = true;
let requests = [];

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
  return { online, total: requests.length, byRoute };
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
  const headers = { ...request.headers, host: upstream.host };
  delete headers.connection;

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
});

const control = http.createServer((request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );
  if (request.method === 'POST' && url.pathname === '/online') {
    online = true;
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
    setTimeout(
      () => json(response, 200, { now: Date.now() }),
      Math.max(0, epoch - Date.now()),
    );
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
      else setTimeout(poll, 100);
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
  proxy.close();
  control.close();
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
