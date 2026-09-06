// Native accessibility geometry from Maestro's own XCTest driver, in logical points.
const response = http.post('http://127.0.0.1:22087/viewHierarchy', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appIds: ['app.ordinarydays.ios.local'],
    excludeKeyboardElements: true,
  }),
});
if (response.status !== 200) throw new Error(`Hierarchy failed: ${response.status}`);
const nodes = [];
function visit(node) {
  if (!node || typeof node !== 'object') return;
  nodes.push(node);
  (node.children || []).forEach(visit);
}
visit(JSON.parse(response.body).axElement);
function validFrame(frame) {
  return (
    frame &&
    ['X', 'Y', 'Width', 'Height'].every((key) => Number.isFinite(frame[key])) &&
    frame.Width > 0 &&
    frame.Height > 0
  );
}
// XCUIElementTypeApplication is numeric 2 in the driver's observed wire schema.
const screen = nodes.find(
  (node) => node.elementType === 2 && node.label === 'Ordinary Days (local)',
)?.frame;
if (!validFrame(screen)) throw new Error('Missing valid application viewport frame');
const suffixes = ['body'];
if (output.rowCheckable) suffixes.unshift('checkbox');
if (output.rowHasPlace) suffixes.push('location');
const controls = suffixes.map((suffix) => {
  const node = nodes.find(
    (entry) => entry.identifier === `list-item-${output.rowItemId}-${suffix}`,
  );
  if (!validFrame(node?.frame))
    throw new Error(`Missing valid ${suffix} accessible frame`);
  if (node.frame.Width < 44 || node.frame.Height < 44)
    throw new Error(`${suffix} target smaller than 44pt`);
  if (
    node.frame.X < screen.X ||
    node.frame.X + node.frame.Width > screen.X + screen.Width
  )
    throw new Error(`${suffix} overflows screen`);
  return { suffix, label: node.label, frame: node.frame };
});
const grip = nodes.find(
  (node) => node.identifier === `list-reorder-handle-${output.rowItemId}`,
);
if (!validFrame(grip?.frame)) throw new Error('Missing valid reorder grip frame');
controls.push({ suffix: 'reorder', label: grip.label, frame: grip.frame });
for (let at = 1; at < controls.length; at += 1) {
  const before = controls[at - 1].frame;
  const after = controls[at].frame;
  if (after.X - before.X - before.Width < 8)
    throw new Error('Adjacent row targets need 8pt separation');
}
console.log(JSON.stringify({ rowAccessibility: controls }));

const viewport = nodes.find((node) => node.identifier === 'list-detail-body')?.frame;
const content = nodes.find(
  (node) =>
    node.identifier === 'list-detail-items' || node.identifier === 'list-state-items',
)?.frame;
if (!validFrame(viewport) || !validFrame(content))
  throw new Error('Missing finite List scroll geometry');
// Each gesture begins at the viewport midpoint: budget enough half-viewports to traverse
// the measured content. This bounds user scrolling without a time-based retry policy.
output.rowScrollGestures = Math.ceil(content.Height / (viewport.Height / 2)) + 1;
