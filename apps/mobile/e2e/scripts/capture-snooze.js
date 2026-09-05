// Capture only this flow's seeded occurrence projection before cleanup removes it.
try {
  const response = http.get(
    `${API_BASE_URL}/v1/agenda?from=${output.today}&to=${output.tomorrow}&tz=America%2FNew_York&include=anytime_unscheduled,overdue`,
  );
  const data = JSON.parse(response.body).data;
  const rows = [];
  (data.days || []).forEach((day) => {
    ['schedule', 'anytime', 'earlier'].forEach((bucket) => {
      (day[bucket] || [])
        .filter((item) => item.activityId === output.activityId)
        .forEach((item) => {
          rows.push({
            date: day.date,
            bucket,
            time: item.time,
            originalTime: item.originalTime,
            isSnoozed: item.isSnoozed,
            status: item.status,
            occurrenceDate: item.occurrenceDate,
          });
        });
    });
  });
  console.log(`Snooze projection evidence: ${JSON.stringify(rows)}`);
} catch (error) {
  console.log(`Snooze evidence unavailable: ${String(error)}`);
}
