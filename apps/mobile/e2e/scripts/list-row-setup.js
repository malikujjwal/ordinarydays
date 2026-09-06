const API = API_BASE_URL || 'http://127.0.0.1:13000';
const kind = typeof ROW_KIND === 'undefined' ? 'mixed' : ROW_KIND;
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
}
function call(path, method, body, version) {
  const response = http.request(`${API}/v1/${path}`, {
    method: method.toUpperCase(),
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': `req_rows_${uuid()}`,
      'X-Client-Timezone': 'America/New_York',
      'X-Client-Version': 'ios/maestro',
      'Idempotency-Key': uuid(),
      ...(version ? { 'If-Match': version } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(response.body);
  return JSON.parse(response.body).data;
}
const template = kind === 'mixed' ? 'checklist' : kind;
const list = call('lists', 'post', { title: 'Compact row test', templateKey: template });
output.rowListId = list.listId;
const mixed = kind === 'mixed';
if (mixed) {
  call(
    `lists/${list.listId}`,
    'patch',
    {
      featureConfig: {
        progress: { enabled: true, kind: 'text' },
        place: { enabled: true },
        subItems: {
          enabled: true,
          sectionLabel: 'Ingredients',
          singularLabel: 'Ingredient',
        },
      },
    },
    list.updatedAt,
  );
}
output.rowHasPlace = mixed || kind === 'places-to-visit';
output.rowCheckable = list.itemStateMode.mode === 'checkbox';
output.rowStage = list.itemStateMode.labels ? list.itemStateMode.labels.done : '';
output.rowTitle =
  kind === 'places-to-visit'
    ? 'Brooklyn Botanic Garden and the quiet paths through its Japanese hill and pond garden'
    : 'Lemon chicken rice';
output.rowAddress =
  '990 Washington Avenue, between Eastern Parkway and Empire Boulevard, Brooklyn, New York 11225';
const features = {};
if (output.rowHasPlace) features.place = { label: 'Market', address: output.rowAddress };
if (mixed || kind === 'books-to-read')
  features.progress = { kind: 'text', value: 'Page 143' };
if (kind === 'watch-later')
  features.progress = { kind: 'episode', season: 2, episode: 4 };
if (mixed || kind === 'meal-ideas')
  features.subItems = { entries: [{ id: 'sub_1', title: 'Lemon', rank: 'a0' }] };
const item = call(`lists/${list.listId}/items`, 'post', {
  title: output.rowTitle,
  note: 'Bright lemon, herbs, and an easy pan sauce.',
  features,
});
output.rowItemId = item.itemId;
const missing = call(`lists/${list.listId}/items`, 'post', {
  title: 'An item without supporting details',
});
output.rowMissingId = missing.itemId;
