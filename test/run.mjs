// test/run.mjs — exercises every command of scripts/tasqs.mjs against a fake
// Tasqs API (no network, no token needed). Also proves the two safety
// properties the skill advertises: it only ever calls https://tasqs.com, and
// the token travels only in the Authorization header.
//
//   node test/run.mjs

import assert from 'node:assert/strict';
import { run, explain, ApiError, UsageError, API_BASE } from '../scripts/tasqs.mjs';

const TOKEN = 'tqs_testtoken_0123456789abcdef';
const ID1 = 'a'.repeat(32), ID2 = 'b'.repeat(32);
const task = (over = {}) => ({ id: ID1, title: 'Renew passport', description: null, status: 'open', priority: 'high', due_date: '2026-10-07',
  list: { id: 3, name: 'Personal', color: '#2E90FA' }, tags: [{ id: 1, name: 'admin', color: '#64748B' }], attachment: null, recurring: null,
  created_at: '2026-09-01T10:00:00+00:00', updated_at: '2026-09-01T10:00:00+00:00', completed_at: null, ...over });

const calls = [];
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A fake tasqs.com. Records every request so the tests can assert the wire shape.
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url); const m = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: u.toString(), method: m, headers: init.headers, body });
  assert.equal(u.origin, 'https://tasqs.com', 'the script must only contact tasqs.com');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  const p = u.pathname.replace('/v1', '');
  if (TOKEN_STATE.reject) return json(401, { error: { code: 'invalid_token', message: 'Unknown token.' } });
  if (m !== 'GET' && TOKEN_STATE.readOnly) return json(403, { error: { code: 'insufficient_scope', message: 'This token lacks tasks:write.' } });

  if (m === 'GET' && p === '/tasks') {
    const due = u.searchParams.get('due');
    const data = due === 'today' ? [task({ due_date: '2026-10-09' })] : due === 'overdue' ? [task()] : [task(), task({ id: ID2, title: 'Buy filters', due_date: null, priority: 'low', tags: [] })];
    return json(200, { data, pagination: { page: Number(u.searchParams.get('page') || 1), per_page: 25, total: 60, total_pages: 3 } });
  }
  if (m === 'GET' && p === `/tasks/${ID1}`) return json(200, { ...task({ description: 'Bring two photos.\nOld passport too.' }), subtasks: [{ title: 'Photos', status: 'completed' }, { title: 'Form', status: 'open' }] });
  if (m === 'GET' && p === `/tasks/${ID2}`) return json(404, { error: { code: 'not_found', message: 'Task not found.' } });
  if (m === 'GET' && p === '/shortlist') return json(200, { date: '2026-10-09', count: 2, remaining: 1, top: task(), items: [{ position: 1, task: task() }, { position: 2, task: task({ id: ID2, title: 'Buy filters', status: 'completed' }) }] });
  if (m === 'GET' && p === '/shortlist/top') return json(200, { data: TOKEN_STATE.emptyTop ? null : task() });
  if (m === 'GET' && p === '/lists') return json(200, { data: [{ id: 3, name: 'Personal', color: '#2E90FA', icon: 'list', open_tasks: 4 }, { id: 4, name: 'Work', color: '#F04438', icon: 'briefcase', open_tasks: 0 }] });
  if (m === 'GET' && p === '/tags') return json(200, { data: [{ id: 1, name: 'admin', color: '#64748B' }, { id: 2, name: 'errands', color: '#12B76A' }] });
  if (m === 'POST' && p === '/tasks') {
    if (body.list === 'Nope') return json(404, { error: { code: 'list_not_found', message: 'No list named "Nope". Your lists: Personal, Work.' } });
    if (TOKEN_STATE.capped) return json(403, { error: { code: 'limit_reached', message: 'Task limit reached for your plan.' } });
    return json(201, { task: task({ id: ID2, title: body.title, due_date: body.due_date ?? null, priority: body.priority || 'medium', tags: (body.tags || []).map((n, i) => ({ id: i, name: n })), recurring: body.recurrence ? { cadence: body.recurrence, end: body.recurrence_end ?? null } : null }), ...(body.tags?.includes('overcap') ? { tags_skipped: ['overcap'] } : {}) });
  }
  if (m === 'PATCH' && p === `/tasks/${ID1}`) return json(200, { task: task({ due_date: 'due_date' in body ? body.due_date : task().due_date, title: body.title || task().title }) });
  if (m === 'POST' && p === `/tasks/${ID1}/complete`) return json(200, { task: task({ status: 'completed', completed_at: '2026-10-09T15:00:00+00:00' }), next_occurrence: TOKEN_STATE.recurring ? task({ id: ID2, due_date: '2026-10-16' }) : null });
  if (m === 'POST' && p === `/tasks/${ID1}/reopen`) return json(200, { task: task() });
  if (m === 'DELETE' && p === `/tasks/${ID1}`) return json(200, { id: ID1, status: 'trashed', restore: `POST /v1/tasks/${ID1}/restore`, purges_after_days: 30 });
  if (m === 'POST' && p === `/tasks/${ID1}/restore`) return json(200, { task: task(), restored_to_list: 'Restored Tasks' });
  if (m === 'POST' && p === `/tasks/${ID1}/tags:remove`) return json(200, { task: task({ tags: [] }), removed: body.tags });
  if (m === 'POST' && p === '/lists') return body.name === 'Personal' ? json(409, { error: { code: 'list_name_taken', message: 'A list named "Personal" already exists.' } }) : json(201, { data: { id: 9, name: body.name, color: body.color || '#F04438', icon: 'list', open_tasks: 0 } });
  if (p === '/ratelimited') return json(429, { error: { code: 'rate_limited', message: 'Too many requests.' } }, { 'retry-after': '12' });
  return json(404, { error: { code: 'not_found', message: `no fake route for ${m} ${p}` } });
};
const TOKEN_STATE = { reject: false, readOnly: false, capped: false, recurring: false, emptyTop: false };

let n = 0, fail = 0;
const ok = (cond, label) => { n++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) fail++; };
const go = (argv, env = { TASQS_API_TOKEN: TOKEN }) => run(argv, { fetch: fakeFetch, env });
const fails = async (argv, cls, env) => { try { await go(argv, env); return null; } catch (e) { return e instanceof cls ? e : (() => { throw e; })(); } };

// ── setup / help ──
ok((await go([])).includes('tasqs — your Tasqs'), 'no args → help text');
const noTok = await fails(['today'], UsageError, {});
ok(noTok && noTok.message.includes('TASQS_API_TOKEN is not set') && noTok.message.includes('profile.php#api-access'), 'missing token → setup message with the link, no request made');
ok(calls.length === 0, 'no request was made without a token');

// ── reads ──
let out = await go(['today']);
ok(out.includes('[ ] 2026-10-09  high   Renew passport  (Personal)  #admin  id=' + ID1), 'today: one task per line with list, tags and id');
ok(calls.at(-1).url === `${API_BASE}/tasks?due=today&status=open&per_page=100`, 'today → GET /v1/tasks?due=today&status=open');
out = await go(['overdue']); ok(out.includes('2026-10-07') && calls.at(-1).url.includes('due=overdue'), 'overdue → due=overdue');
out = await go(['open', '--page', '2']);
ok(out.includes('Buy filters') && out.includes('no date') && out.includes('(page 2 of 3, 60 tasks') && calls.at(-1).url.includes('page=2'), 'open: pagination note + no-date tasks');
out = await go(['list', '--list', 'Work', '--tag', 'admin', '--priority', 'high', '--status', 'all', '--due-before', '2026-12-31']);
ok(calls.at(-1).url === `${API_BASE}/tasks?status=all&list=Work&tag=admin&priority=high&per_page=50&due_before=2026-12-31`, 'list: every filter forwarded as the v1 query params');
ok((await fails(['list', '--due-before', 'tomorrow'], UsageError)) !== null, 'list: --due-before validated as YYYY-MM-DD before any request');
out = await go(['search', 'filters']); ok(out.includes('Buy filters') && !out.includes('passport'), 'search: client-side title match');
out = await go(['search', 'zzz']); ok(out.includes('No open task mentions "zzz"'), 'search: no match message');
out = await go(['get', ID1]);
ok(out.includes('Bring two photos.') && out.includes('    Old passport too.') && out.includes('[x] Photos') && out.includes('[ ] Form'), 'get: description (indented, multi-line) and subtasks');
ok((await fails(['get', 'abc'], UsageError))?.message.includes('never guessed'), 'get: a non-32-hex id is refused locally');
out = await go(['shortlist']); ok(out.startsWith('1. [ ] ') && out.includes('2. [x] ') && out.endsWith('1 of 2 still open.'), 'shortlist: numbered positions + remaining count');
out = await go(['next']); ok(out.startsWith('Next up: ') && out.includes('Renew passport'), 'next: the top task');
TOKEN_STATE.emptyTop = true; out = await go(['next']); ok(out === "Nothing open on today's Shortlist.", 'next: empty Shortlist'); TOKEN_STATE.emptyTop = false;
out = await go(['lists']); ok(out.includes('Personal  (4 open)  list_id=3') && out.includes('Work  (0 open)'), 'lists: names with open counts');
out = await go(['tags']); ok(out === '#admin  #errands', 'tags');
out = await go(['today', '--json']); ok(JSON.parse(out).pagination.total === 60, '--json returns the raw API response');

// ── writes ──
out = await go(['add', 'Call', 'the', 'dentist', '--due', '2026-10-14', '--list', 'Personal', '--priority', 'high', '--tags', 'health, calls', '--repeat', 'weekly', '--until', '2026-12-01']);
ok(calls.at(-1).method === 'POST' && calls.at(-1).headers['Content-Type'] === 'application/json', 'add → POST /v1/tasks as JSON');
assert.deepEqual(calls.at(-1).body, { title: 'Call the dentist', due_date: '2026-10-14', list: 'Personal', priority: 'high', tags: ['health', 'calls'], recurrence: 'weekly', recurrence_end: '2026-12-01' });
ok(true, 'add: body carries title (joined words), due_date, list, priority, tags (split+trimmed), recurrence, recurrence_end');
ok(out.startsWith('Added: [ ] 2026-10-14  high   Call the dentist') && out.includes('repeats weekly'), 'add: confirmation line from the returned task');
out = await go(['add', 'X', '--tags', 'overcap']); ok(out.includes('not tagged — tag limit reached: overcap'), 'add: tags_skipped surfaced, never silent');
ok((await fails(['add'], UsageError))?.message.includes('needs a title'), 'add: no title → usage error, no request');
ok((await fails(['add', 'X', '--due', '10/14'], UsageError)) !== null, 'add: bad date refused locally');
let e = await fails(['add', 'X', '--list', 'Nope'], ApiError); ok(e && explain(e).includes('No list named "Nope"') && explain(e).includes('run `lists`'), 'add: unknown list → API message + hint to run lists');
TOKEN_STATE.capped = true; e = await fails(['add', 'X'], ApiError); ok(e && explain(e).includes('Task limit reached') && explain(e).includes('nothing was created'), 'add: plan cap explained'); TOKEN_STATE.capped = false;

out = await go(['edit', ID1, '--due', '2026-10-20']); ok(calls.at(-1).method === 'PATCH' && calls.at(-1).body.due_date === '2026-10-20' && out.startsWith('Updated: '), 'edit: PATCH with only the changed field');
await go(['edit', ID1, '--no-due']); ok(calls.at(-1).body.due_date === null, 'edit --no-due → due_date: null (clear)');
await go(['edit', ID1, '--no-desc', '--title', 'New']); ok(calls.at(-1).body.description === null && calls.at(-1).body.title === 'New', 'edit --no-desc clears, --title sets');
ok((await fails(['edit', ID1], UsageError))?.message.includes('at least one change'), 'edit with nothing to change → usage error');

out = await go(['done', ID1]); ok(out.startsWith('Completed: [x]') && !out.includes('Next occurrence'), 'done: completed line, no spawn for a one-off');
TOKEN_STATE.recurring = true; out = await go(['done', ID1]); ok(out.includes('Next occurrence: [ ] 2026-10-16'), 'done: recurring → next occurrence shown'); TOKEN_STATE.recurring = false;
out = await go(['reopen', ID1]); ok(out.startsWith('Reopened: [ ]'), 'reopen');
out = await go(['delete', ID1]); ok(calls.at(-1).method === 'DELETE' && out.includes('Trash') && out.includes(`restore ${ID1}`), 'delete: Trash + the exact restore command');
out = await go(['restore', ID1]); ok(out.startsWith('Restored: ') && out.includes('(in list "Restored Tasks")'), 'restore: notes the landing list');
out = await go(['untag', ID1, '--tags', 'admin']); ok(calls.at(-1).url.endsWith('/tags:remove') && calls.at(-1).body.tags[0] === 'admin' && !out.includes('#admin'), 'untag → tags:remove');
out = await go(['newlist', 'Errands', '--color', '#12B76A']); ok(calls.at(-1).body.name === 'Errands' && out === 'Created list: Errands  list_id=9', 'newlist');
e = await fails(['newlist', 'Personal'], ApiError); ok(e && explain(e).includes('already exists'), 'newlist: duplicate name explained');

// ── auth / scope / rate-limit explanations ──
TOKEN_STATE.readOnly = true; e = await fails(['add', 'X'], ApiError);
ok(e && e.code === 'insufficient_scope' && explain(e).includes('read-only') && explain(e).includes('Allow writes'), 'read-only token → "Allow writes" instruction');
ok((await go(['today'])).includes('passport'), 'read-only token still reads'); TOKEN_STATE.readOnly = false;
TOKEN_STATE.reject = true; e = await fails(['today'], ApiError); ok(e && explain(e).includes('rejected the API token'), 'invalid token explained'); TOKEN_STATE.reject = false;
e = new ApiError(429, 'rate_limited', 'Too many requests.', '12'); ok(explain(e).includes('wait 12 seconds'), 'rate limit → Retry-After surfaced');
e = new ApiError(403, 'plan_required', 'Power plan required.'); ok(explain(e).includes('Power plan'), 'plan gate explained');
e = new ApiError(404, 'not_found', 'Task not found.'); ok(explain(e).includes('No task with that id'), 'not found explained');
e = await fails(['get', ID2], ApiError); ok(e && e.status === 404, 'get: 404 from the API is an ApiError');

// ── the safety properties ──
ok(calls.every(c => c.url.startsWith('https://tasqs.com/v1/')), `every one of the ${calls.length} requests went to https://tasqs.com/v1/`);
ok(calls.every(c => !c.url.includes(TOKEN) && JSON.stringify(c.body ?? null).indexOf(TOKEN) === -1), 'the token never appears in a URL or body — Authorization header only');
ok(!(await go(['today'])).includes(TOKEN) && !(await go(['today', '--json'])).includes(TOKEN), 'the token never appears in output');
ok(API_BASE === 'https://tasqs.com/v1', 'API base is the hard-coded production host');

console.log(`\n${n} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
