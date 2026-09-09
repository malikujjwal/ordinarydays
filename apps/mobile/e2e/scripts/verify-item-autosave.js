const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:18474';
const waited = http.get(
  `${CONTROL}/wait-for-item?listId=${output.rowListId}&itemId=${output.rowItemId}&note=${encodeURIComponent('Saved offline and kept after relaunch')}`,
);
if (waited.status !== 200) throw new Error(waited.body);
const API = API_BASE_URL || 'http://127.0.0.1:13000';
const response = http.get(
  `${API}/v1/lists/${output.rowListId}/items/${output.rowItemId}`,
  {
    headers: {
      'X-Request-Id': `req_item_save_${Date.now()}`,
      'X-Client-Timezone': 'America/New_York',
      'X-Client-Version': 'ios/maestro',
    },
  },
);
if (response.status !== 200) throw new Error(response.body);
const saved = JSON.parse(response.body).data;
if (saved.note !== 'Saved offline and kept after relaunch')
  throw new Error(
    `The server did not receive the locally acknowledged note: ${response.body}`,
  );
