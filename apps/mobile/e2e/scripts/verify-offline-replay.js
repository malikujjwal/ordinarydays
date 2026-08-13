const API = API_BASE_URL || 'http://127.0.0.1:3000';
const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:8474';
const ZONE = 'America/New_York';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': `req_maestro_verify_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    'X-Client-Timezone': ZONE,
    'X-Client-Version': 'ios/maestro',
  };
}

const waited = http.get(`${CONTROL}/wait-for-completions?count=3`);
if (!waited.ok) throw new Error(`Timed out waiting for replay: ${waited.body}`);
const stats = JSON.parse(http.get(`${CONTROL}/stats`).body);
const completions = Object.keys(stats.byRoute)
  .filter((route) => /^POST \/v1\/activities\/[^/]+\/complete$/.test(route))
  .reduce((total, route) => total + stats.byRoute[route], 0);
if (completions !== 3)
  throw new Error(`Expected exactly 3 completion requests, received ${completions}`);

output.activityIds.forEach((activityId) => {
  const response = http.get(`${API}/v1/activities/${activityId}`, { headers: headers() });
  const activity = JSON.parse(response.body).data.activity;
  if (activity.status !== 'completed')
    throw new Error(`${activityId} is ${activity.status}, not completed`);
});

const agenda = http.get(
  `${API}/v1/agenda?from=${output.today}&to=${output.today}&tz=${encodeURIComponent(ZONE)}&include=anytime_unscheduled,overdue`,
  { headers: headers() },
);
const days = JSON.parse(agenda.body).data.days || [];
const rows = [];
days.forEach((day) => {
  ['schedule', 'anytime', 'earlier'].forEach((section) => {
    (day[section] || []).forEach((item) => {
      rows.push(item.activityId);
    });
  });
});
output.activityIds.forEach((activityId) => {
  const count = rows.filter((candidate) => candidate === activityId).length;
  if (count !== 1) throw new Error(`${activityId} appears ${count} times in the agenda`);
});
