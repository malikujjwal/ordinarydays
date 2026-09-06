// Read-only layout assertion through the same Maestro 2.10 XCTest driver used by calendar races.
const response = http.post(`${IOS_DRIVER_URL}/viewHierarchy`, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appIds: ['app.ordinarydays.ios.local'],
    excludeKeyboardElements: true,
  }),
});
if (response.status !== 200) throw new Error(`Hierarchy read failed: ${response.status}`);
const snapshot = JSON.parse(response.body);
const elements = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  elements.push(node);
  (node.children || []).forEach(visit);
}
visit(snapshot.axElement);
const section = elements.find((node) => node.identifier === 'section-prep');
const counter = elements.find((node) => node.label === '0 of 1 done');
const heading = elements.find((node) => node.label?.toLowerCase() === 'preparation');
if (
  !section?.frame ||
  !counter?.frame ||
  !heading?.frame ||
  section.frame.Width <= 0 ||
  counter.frame.Width <= 0 ||
  heading.frame.Width <= 0 ||
  heading.frame.Height <= 0
)
  throw new Error(
    'Preparation heading and full progress label must have visible accessible bounds.',
  );
if (
  heading.frame.X < section.frame.X ||
  heading.frame.X + heading.frame.Width > section.frame.X + section.frame.Width ||
  counter.frame.X < section.frame.X ||
  counter.frame.X + counter.frame.Width > section.frame.X + section.frame.Width
)
  throw new Error('Preparation heading or count extends outside its section.');
output.preparationCountBounds = counter.frame;
output.preparationHeadingBounds = heading.frame;
