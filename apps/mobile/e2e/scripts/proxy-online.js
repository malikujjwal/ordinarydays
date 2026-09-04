const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:8474';
if (NETWORK_MODE !== 'physical') http.post(`${CONTROL}/online`, { body: '' });
