const CONTROL = PROXY_CONTROL_URL;
const response = http.get(
  `${CONTROL}/wait-for-activity?date=${output.today}&title=${encodeURIComponent(output.title)}`,
);
const result = JSON.parse(response.body);
if (!result.activityId)
  throw new Error('Offline-created Activity did not reach the server after reconnect.');
output.activityIds = [...(output.activityIds || []), result.activityId];
output.offlineCreateSubmitted = false;
