// Maestro 2.10's iOS CLI waits for animation before/after tapOn, even with a zero
// settle timeout. The calendar's accessible spinner therefore consumes the app's
// real HTTP deadline. Use the SAME running XCTest driver's snapshot/touch seam
// for these two race taps only. Ordinary navigation/assertions stay in YAML.
// Protocol: maestro-ios-driver XCTestDriverClient.viewHierarchy/tap (2.10.0).
// For a non-default --driver-host-port, pass matching IOS_DRIVER_URL to the flow.
const driver = IOS_DRIVER_URL;
const appId = 'app.ordinarydays.ios.local';

function post(path, body) {
  const response = http.post(`${driver}/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(
      `Maestro iOS ${path} failed (${response.status}); check IOS_DRIVER_URL and driver version.`,
    );
  }
  return response.body;
}

const snapshot = JSON.parse(
  post('viewHierarchy', {
    appIds: [appId],
    excludeKeyboardElements: true,
  }),
);
const elements = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  elements.push(node);
  (node.children || []).forEach(visit);
}
visit(snapshot.axElement);
if (!elements.some((node) => node.label === 'Loading calendar')) {
  throw new Error('Calendar request must still be loading before each race selection.');
}
const matches = elements.filter((node) => node.identifier === ELEMENT_ID && node.enabled);
if (matches.length !== 1) {
  throw new Error(`Expected one enabled ${ELEMENT_ID}, found ${matches.length}.`);
}
const frame = matches[0].frame;
if (
  !frame ||
  !Number.isFinite(frame.X) ||
  !Number.isFinite(frame.Y) ||
  !Number.isFinite(frame.Width) ||
  !Number.isFinite(frame.Height) ||
  frame.Width <= 0 ||
  frame.Height <= 0
) {
  throw new Error(`Invalid accessible bounds for ${ELEMENT_ID}.`);
}
post('touch', { x: frame.X + frame.Width / 2, y: frame.Y + frame.Height / 2 });
output.calendarRaceTaps = (output.calendarRaceTaps || []).concat(ELEMENT_ID);
