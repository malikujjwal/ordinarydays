const API = API_BASE_URL || 'http://127.0.0.1:3000';
const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:8474';
const ZONE = 'America/New_York';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': `req_maestro_cleanup_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    'X-Client-Timezone': ZONE,
    'X-Client-Version': 'ios/maestro',
  };
}

http.post(`${CONTROL}/online`, { body: '' });
const cleanupListTitles = output.cleanupListTitles || [];
if (cleanupListTitles.length > 0) {
  const response = http.get(`${API}/v1/lists`, { headers: headers() });
  const lists = JSON.parse(response.body).data || [];
  lists.forEach((list) => {
    if (cleanupListTitles.includes(list.title)) {
      http.delete(`${API}/v1/lists/${list.listId}`, { headers: headers() });
    }
  });
}
const ids = output.activityIds || [];
const cleanupTitles = output.cleanupTitles || [];
if ((output.title || cleanupTitles.length > 0) && output.today) {
  const response = http.get(
    `${API}/v1/agenda?from=${output.today}&to=${output.today}&tz=${encodeURIComponent(ZONE)}&include=anytime_unscheduled,overdue`,
    { headers: headers() },
  );
  const days = JSON.parse(response.body).data.days || [];
  days.forEach((day) => {
    ['schedule', 'anytime', 'earlier'].forEach((section) => {
      (day[section] || []).forEach((item) => {
        if (
          (item.title === output.title || cleanupTitles.includes(item.title)) &&
          !ids.includes(item.activityId)
        )
          ids.push(item.activityId);
      });
    });
  });
}
ids.forEach((activityId) => {
  http.delete(`${API}/v1/activities/${activityId}`, { headers: headers() });
});
