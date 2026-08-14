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
  const recurring = activityId === output.recurringOfflineId;
  const response = http.get(
    `${API}/v1/activities/${activityId}${recurring ? `?occurrenceDate=${output.today}` : ''}`,
    { headers: headers() },
  );
  const detail = JSON.parse(response.body).data;
  if (recurring) {
    if (detail.activity.status !== 'scheduled')
      throw new Error(`${activityId} series changed to ${detail.activity.status}`);
    if (detail.occurrence?.status !== 'completed_occurrence')
      throw new Error(`${activityId} occurrence is ${detail.occurrence?.status}`);
  } else if (detail.activity.status !== 'completed') {
    throw new Error(`${activityId} is ${detail.activity.status}, not completed`);
  }
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

const tomorrowAgenda = http.get(
  `${API}/v1/agenda?from=${output.tomorrow}&to=${output.tomorrow}&tz=${encodeURIComponent(ZONE)}&include=anytime_unscheduled,overdue`,
  { headers: headers() },
);
const tomorrowRows = [];
(JSON.parse(tomorrowAgenda.body).data.days || []).forEach((day) => {
  ['schedule', 'anytime', 'earlier'].forEach((section) => {
    (day[section] || []).forEach((item) => {
      tomorrowRows.push(item);
    });
  });
});
const nextOccurrence = tomorrowRows.find(
  (item) => item.activityId === output.recurringOfflineId,
);
if (nextOccurrence?.status !== 'scheduled') {
  throw new Error('The recurring offline completion leaked onto tomorrow.');
}
