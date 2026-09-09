const response = http.post('http://127.0.0.1:22087/viewHierarchy', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appIds: ['app.ordinarydays.ios.local'],
    excludeKeyboardElements: true,
  }),
});
if (response.status !== 200) throw new Error(response.body);
const nodes = [];
function visit(node) {
  if (!node) return;
  nodes.push(node);
  (node.children || []).forEach(visit);
}
visit(JSON.parse(response.body).axElement);
const screen = nodes.find((node) => node.elementType === 2)?.frame;
const body = nodes.find((node) => node.identifier === 'item-sheet-body')?.frame;
const note = nodes.find((node) => node.identifier === 'item-sheet-note')?.frame;
function validFrame(frame) {
  return (
    frame &&
    ['X', 'Y', 'Width', 'Height'].every((key) => Number.isFinite(frame[key])) &&
    frame.Width > 0 &&
    frame.Height > 0
  );
}
if (![screen, body, note].every(validFrame))
  throw new Error('Missing usable Item details viewport or Note frame');
// Use the visible intersection: a large-text multiline field can be taller than its
// scroll viewport, so waiting for the entire element to be visible would overscroll it.
const top = Math.max(body.Y, note.Y, screen.Y);
const bottom = Math.min(
  body.Y + body.Height,
  note.Y + note.Height,
  screen.Y + screen.Height,
);
const left = Math.max(body.X, note.X, screen.X);
const right = Math.min(body.X + body.Width, note.X + note.Width, screen.X + screen.Width);
output.itemNoteReachable = bottom - top >= 44 && right - left >= 44;
output.itemNotePoint = `${Math.round((((left + right) / 2 - screen.X) / screen.Width) * 100)}%,${Math.round((((top + bottom) / 2 - screen.Y) / screen.Height) * 100)}%`;
output.itemNoteValue = nodes.find((node) => node.identifier === 'item-sheet-note').value;
// Budget gestures from measured distance rather than a delay or performance threshold.
if (!output.itemScrollGestures)
  output.itemScrollGestures = Math.max(
    1,
    Math.ceil((note.Y + note.Height - body.Y) / (body.Height / 2)) + 1,
  );
console.log(JSON.stringify({ body, note, reachable: output.itemNoteReachable }));
