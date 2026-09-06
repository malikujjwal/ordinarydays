// Only removes the Plan created for this independent journey.
const API = API_BASE_URL || 'http://127.0.0.1:3000';
const response = http.delete(`${API}/v1/activities/${output.activityId}`, {
  headers: { 'X-Client-Timezone': 'America/New_York' },
});
if (response.status !== 200 && response.status !== 204) {
  throw new Error(`Fixture deletion failed: ${response.status}`);
}
