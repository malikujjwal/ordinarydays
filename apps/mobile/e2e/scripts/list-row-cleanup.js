const API = API_BASE_URL || 'http://127.0.0.1:13000';
if (output.rowListId) {
  const response = http.delete(`${API}/v1/lists/${output.rowListId}`, {
    headers: {
      'X-Request-Id': `req_rows_cleanup_${Date.now()}`,
      'X-Client-Timezone': 'America/New_York',
      'X-Client-Version': 'ios/maestro',
    },
  });
  if (response.status < 200 || response.status >= 300) throw new Error(response.body);
}
