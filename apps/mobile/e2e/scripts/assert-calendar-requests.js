const stats = JSON.parse(http.get(`${PROXY_CONTROL_URL}/stats`).body);
const windows = stats.plansRequests;
output.calendarRequests = windows;
if (
  windows.length !== 1 ||
  windows[0].mode !== 'upcoming_window' ||
  windows[0].from !== output.gridFrom ||
  windows[0].through !== output.gridThrough
) {
  throw new Error(
    `Expected only ${output.gridFrom}..${output.gridThrough}; requested ${JSON.stringify(windows)}`,
  );
}
