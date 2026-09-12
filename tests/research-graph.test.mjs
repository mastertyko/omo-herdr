import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchItems, researchLayout, findResearchItem, sourceUrl } from '../web/src/research-graph.js';

const search = { id: 'search', taskId: 'librarian', kind: 'search', query: 'API docs', state: 'completed', sources: [{ id: 'source', url: 'https://example.com/docs', title: 'API docs' }] };
const fetch = { id: 'fetch', taskId: 'librarian', kind: 'retrieval', state: 'fetched', requestedUrl: 'https://example.com/docs', sources: [] };
const snapshot = (...records) => ({ records });

test('matching URLs alone never convert a search result into a visited source', () => {
  const items = researchItems(snapshot(search, fetch), 'librarian');
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.source)?.record, undefined);
  assert.equal(items.find((i) => i.record === fetch)?.parentId, undefined);
});
test('explicit provenance enriches a source without moving it or changing selection', () => {
  const original = researchItems(snapshot(search), 'librarian');
  const selected = original.find((i) => i.source).id;
  const next = snapshot(search, { ...fetch, relatedSearchId: 'search' });
  const items = researchItems(next, 'librarian');
  assert.equal(items.length, 2);
  assert.equal(findResearchItem(next, 'librarian', selected).record.state, 'fetched');
  const positions = researchLayout(original);
  assert.deepEqual(researchLayout(items, positions).get(selected), positions.get(selected));
});
test('repeated fetches stay separate and foreign-agent fetches cannot enrich a result', () => {
  const items = researchItems(snapshot(search, { ...fetch, taskId: 'other', relatedSearchId: 'search' },
    { ...fetch, id: 'first', relatedSearchId: 'search' }, { ...fetch, id: 'second', relatedSearchId: 'search' }), 'librarian');
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((i) => i.id)).size, 3);
  assert.deepEqual(items.filter((i) => i.record?.kind === 'retrieval').map((i) => i.record.id), ['first', 'second']);
});
test('research slots stay fixed while new operations and sources arrive', () => {
  const initial = researchItems(snapshot(search), 'librarian');
  const positions = researchLayout(initial);
  const next = researchItems(snapshot({ ...search, sources: [...search.sources, { id: 'new', url: 'https://example.org' }] }, { ...search, id: 'second' }), 'librarian');
  const expanded = researchLayout(next, positions);
  for (const item of initial) assert.deepEqual(expanded.get(item.id), positions.get(item.id));
  const sourcePositions = next.filter((i) => i.kind === 'source').map((i) => expanded.get(i.id).y);
  assert.equal(new Set(sourcePositions).size, sourcePositions.length);
});
test('source actions reject executable, malformed and credential-bearing URLs', () => {
  for (const input of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://user:pass@example.com', 'not a URL']) assert.equal(sourceUrl(input), undefined);
  assert.equal(sourceUrl('https://example.com/docs'), 'https://example.com/docs');
});
