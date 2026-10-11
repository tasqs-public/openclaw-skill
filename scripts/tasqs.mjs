#!/usr/bin/env node
// tasqs.mjs — a small command-line client for the Tasqs public API v1.
//
// This file is deliberately boring, so anyone can read it in a minute:
//   • It talks to exactly ONE host, https://tasqs.com, hard-coded below.
//   • It reads exactly ONE environment variable, TASQS_API_TOKEN, and sends
//     it only as the Authorization header to that host. It never prints it.
//   • No dependencies (Node 18+ built-in fetch), no eval, no downloads, no
//     files written. Output goes to stdout; errors to stderr with exit 1.
//
// Usage: node tasqs.mjs <command> [args] [--json]
// Run with no arguments for the command list. API reference:
// https://tasqs.com/api-documentation.php

const API_BASE = 'https://tasqs.com/v1';
const TOKEN_ENV = 'TASQS_API_TOKEN';

const HELP = `tasqs — your Tasqs to-do list from the command line

Read
  today                         tasks due today (open)
  overdue                       open tasks past their due date
  open [--page N]               all open tasks (25 per page)
  list [filters]                tasks with filters: --list NAME --tag NAME
                                --status open|completed|all --priority low|medium|high
                                --due today|overdue|open --due-before YYYY-MM-DD --page N
  search "words"                open tasks whose title contains the words (client-side match)
  get ID                        one task in full (description, subtasks, recurrence)
  shortlist                     today's Shortlist (the up-to-five tasks chosen for today)
  next                          the first open task on today's Shortlist, or nothing
  lists                         your lists (names are what --list expects)
  tags                          your tags

Write (needs a token created with "Allow writes")
  add "Title" [--due YYYY-MM-DD] [--list NAME] [--priority low|medium|high]
              [--tags a,b] [--desc "text"] [--repeat daily|weekly|biweekly|monthly|yearly]
              [--until YYYY-MM-DD]
  edit ID [--title "..."] [--due YYYY-MM-DD | --no-due] [--list NAME]
          [--priority P] [--tags a,b] [--desc "text" | --no-desc]
  done ID                       mark complete (a recurring task spawns its next occurrence)
  reopen ID                     un-complete
  delete ID                     move to the Trash (recoverable for 30 days)
  restore ID                    bring a task back from the Trash
  untag ID --tags a,b           remove tags from a task (the tags themselves stay)
  newlist "Name" [--color #RRGGBB]

Add --json to any command for the raw API response.
IDs are 32-character hex strings as shown in the output — never guess one.`;

// ── argument parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith('no-') || next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

const ID_RE = /^[0-9a-f]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireId(id, what = 'task') {
  if (!id || !ID_RE.test(id)) throw new UsageError(`A ${what} id is required: a 32-character hex string from the output of a read command (never guessed).`);
  return id;
}
function requireDate(v, flag) {
  if (!DATE_RE.test(String(v))) throw new UsageError(`--${flag} must be YYYY-MM-DD (got "${v}").`);
  return String(v);
}
function splitTags(v) {
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

class UsageError extends Error {}

// ── HTTP ──────────────────────────────────────────────────────────────────
async function api(fetchImpl, token, method, path, body, query) {
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const code = json?.error?.code || `http_${res.status}`;
    const msg = json?.error?.message || text.slice(0, 200) || res.statusText;
    const retry = res.headers.get('retry-after');
    throw new ApiError(res.status, code, msg, retry);
  }
  return json;
}

class ApiError extends Error {
  constructor(status, code, message, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

// What the agent should tell the user for each API error — plain, actionable.
function explain(err) {
  switch (err.code) {
    case 'invalid_token':
    case 'unauthorized':
      return `Tasqs rejected the API token (${err.message}). Check ${TOKEN_ENV}: create or re-copy a token at https://tasqs.com/profile.php#api-access`;
    case 'insufficient_scope':
      return `This token is read-only, so it can't change tasks. Create a new token with "Allow writes" ticked at https://tasqs.com/profile.php#api-access and update ${TOKEN_ENV}.`;
    case 'plan_required':
      return `API access is part of the Tasqs Power plan. Upgrade at https://tasqs.com/billing.php and try again.`;
    case 'limit_reached':
    case 'list_limit_reached':
      return `${err.message} (a plan limit — nothing was created)`;
    case 'list_name_taken':
      return `${err.message} (run \`lists\` to see the existing names)`;
    case 'rate_limited':
      return `Tasqs is rate-limiting this token${err.retryAfter ? ` — wait ${err.retryAfter} seconds` : ''}. ${err.message}`;
    case 'not_found':
      return `No task with that id on this account (ids are case-sensitive 32-character hex strings; re-run a read command to get a current one).`;
    case 'list_not_found':
    case 'tag_not_found':
      return `${err.message} (run \`lists\` or \`tags\` to see the exact names)`;
    case 'validation_failed':
    case 'invalid_parameter':
      return `Tasqs rejected the request: ${err.message}`;
    default:
      return `Tasqs API error ${err.status} ${err.code}: ${err.message}`;
  }
}

// ── formatting ────────────────────────────────────────────────────────────
function fmtTask(t) {
  const mark = t.status === 'completed' ? 'x' : ' ';
  const due = t.due_date || 'no date';
  const prio = (t.priority || 'medium').padEnd(6);
  const list = t.list?.name ? `  (${t.list.name})` : '';
  const tags = Array.isArray(t.tags) && t.tags.length ? '  #' + t.tags.map(x => x.name).join(' #') : '';
  const extra = [];
  if (t.recurring?.cadence) extra.push(`repeats ${t.recurring.cadence}`);
  if (t.attachment?.filename) extra.push(`attachment: ${t.attachment.filename}`);
  const ex = extra.length ? `  [${extra.join('; ')}]` : '';
  return `[${mark}] ${due}  ${prio} ${t.title}${list}${tags}${ex}  id=${t.id}`;
}

function fmtTaskDetail(t) {
  const lines = [fmtTask(t)];
  if (t.description) lines.push(`    ${String(t.description).replace(/\n/g, '\n    ')}`);
  if (Array.isArray(t.subtasks) && t.subtasks.length) {
    lines.push('    subtasks:');
    for (const s of t.subtasks) lines.push(`      [${s.is_complete || s.done || s.status === 'completed' ? 'x' : ' '}] ${s.title}`);
  }
  if (t.recurring) lines.push(`    repeats: ${t.recurring.cadence}${t.recurring.end ? ` until ${t.recurring.end}` : ''}`);
  if (t.completed_at) lines.push(`    completed: ${t.completed_at}`);
  return lines.join('\n');
}

// Tags the API skipped (over the plan's tag cap) — say so rather than silently dropping them.
function skippedNote(r) {
  return Array.isArray(r?.tags_skipped) && r.tags_skipped.length ? `\n(not tagged — tag limit reached: ${r.tags_skipped.join(', ')})` : '';
}

function fmtTasks(resp, emptyMsg) {
  const data = resp?.data || [];
  if (!data.length) return emptyMsg;
  const out = data.map(fmtTask);
  const p = resp.pagination;
  if (p && p.total_pages > 1) out.push(`(page ${p.page} of ${p.total_pages}, ${p.total} tasks — add --page N for more)`);
  return out.join('\n');
}

// ── commands ──────────────────────────────────────────────────────────────
async function run(argv, { fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) return HELP;

  const token = env.TASQS_API_TOKEN;   // the one environment variable this skill reads (declared in SKILL.md)
  if (!token) throw new UsageError(`${TOKEN_ENV} is not set. Create a token at https://tasqs.com/profile.php#api-access (Power plan; tick "Allow writes" to let the agent change tasks) and set it for this skill.`);

  const call = (method, path, body, query) => api(fetchImpl, token, method, path, body, query);
  const json = !!flags.json;
  const show = (resp, text) => json ? JSON.stringify(resp, null, 2) : text;

  switch (cmd) {
    case 'today': {
      const r = await call('GET', '/tasks', undefined, { due: 'today', status: 'open', per_page: 100 });
      return show(r, fmtTasks(r, 'Nothing due today.'));
    }
    case 'overdue': {
      const r = await call('GET', '/tasks', undefined, { due: 'overdue', status: 'open', per_page: 100 });
      return show(r, fmtTasks(r, 'Nothing overdue.'));
    }
    case 'open': {
      const r = await call('GET', '/tasks', undefined, { status: 'open', page: flags.page, per_page: 25 });
      return show(r, fmtTasks(r, 'No open tasks.'));
    }
    case 'list': {
      const q = { status: flags.status || 'open', list: flags.list, tag: flags.tag, priority: flags.priority, due: flags.due, page: flags.page, per_page: 50 };
      if (flags['due-before']) q.due_before = requireDate(flags['due-before'], 'due-before');
      const r = await call('GET', '/tasks', undefined, q);
      return show(r, fmtTasks(r, 'No tasks match.'));
    }
    case 'search': {
      const words = positional.slice(1).join(' ').trim().toLowerCase();
      if (!words) throw new UsageError('search needs words: search "dentist"');
      const r = await call('GET', '/tasks', undefined, { status: flags.status || 'open', per_page: 100, page: flags.page });
      const hits = (r.data || []).filter(t => String(t.title).toLowerCase().includes(words) || String(t.description || '').toLowerCase().includes(words));
      if (json) return JSON.stringify({ data: hits }, null, 2);
      return hits.length ? hits.map(fmtTask).join('\n') : `No open task mentions "${words}".`;
    }
    case 'get': {
      const r = await call('GET', `/tasks/${requireId(positional[1])}`);   // the task object itself, unwrapped
      return show(r, fmtTaskDetail(r));
    }
    case 'shortlist': {
      const r = await call('GET', '/shortlist');
      if (json) return JSON.stringify(r, null, 2);
      if (!r.items?.length) return `No Shortlist yet for ${r.date}. (The Shortlist is up to five tasks chosen for the day — pick them in Tasqs.)`;
      const lines = r.items.map(i => `${i.position}. ${fmtTask(i.task)}`);
      lines.push(`${r.remaining} of ${r.count} still open.`);
      return lines.join('\n');
    }
    case 'next': {
      const r = await call('GET', '/shortlist/top');
      if (json) return JSON.stringify(r, null, 2);
      return r.data ? `Next up: ${fmtTask(r.data)}` : 'Nothing open on today\'s Shortlist.';
    }
    case 'lists': {
      const r = await call('GET', '/lists');
      return show(r, (r.data || []).map(l => `${l.name}  (${l.open_tasks ?? l.open_count ?? '?'} open)  list_id=${l.id}`).join('\n') || 'No lists.');
    }
    case 'tags': {
      const r = await call('GET', '/tags');
      return show(r, (r.data || []).map(t => `#${t.name}`).join('  ') || 'No tags.');
    }

    // ── writes ──
    case 'add': {
      const title = positional.slice(1).join(' ').trim();
      if (!title) throw new UsageError('add needs a title: add "Call the dentist" --due 2026-10-14');
      const body = { title };
      if (flags.due) body.due_date = requireDate(flags.due, 'due');
      if (flags.list) body.list = String(flags.list);
      if (flags.priority) body.priority = String(flags.priority);
      if (flags.tags) body.tags = splitTags(flags.tags);
      if (flags.desc) body.description = String(flags.desc);
      if (flags.repeat) body.recurrence = String(flags.repeat);
      if (flags.until) body.recurrence_end = requireDate(flags.until, 'until');
      const r = await call('POST', '/tasks', body);
      return show(r, `Added: ${fmtTask(r.task)}` + skippedNote(r));
    }
    case 'edit': {
      const id = requireId(positional[1]);
      const body = {};
      if (flags.title) body.title = String(flags.title);
      if (flags.due) body.due_date = requireDate(flags.due, 'due');
      if (flags['no-due']) body.due_date = null;
      if (flags.list) body.list = String(flags.list);
      if (flags.priority) body.priority = String(flags.priority);
      if (flags.tags) body.tags = splitTags(flags.tags);
      if (flags.desc) body.description = String(flags.desc);
      if (flags['no-desc']) body.description = null;
      if (!Object.keys(body).length) throw new UsageError('edit needs at least one change (--title, --due/--no-due, --list, --priority, --tags, --desc/--no-desc).');
      const r = await call('PATCH', `/tasks/${id}`, body);
      return show(r, `Updated: ${fmtTask(r.task)}` + skippedNote(r));
    }
    case 'done': {
      const r = await call('POST', `/tasks/${requireId(positional[1])}/complete`);
      let text = `Completed: ${fmtTask(r.task)}`;
      if (r.next_occurrence) text += `\nNext occurrence: ${fmtTask(r.next_occurrence)}`;
      return show(r, text);
    }
    case 'reopen': {
      const r = await call('POST', `/tasks/${requireId(positional[1])}/reopen`);
      return show(r, `Reopened: ${fmtTask(r.task)}`);
    }
    case 'delete': {
      const id = requireId(positional[1]);
      const r = await call('DELETE', `/tasks/${id}`);
      return show(r, `Moved to the Trash (recoverable for 30 days with: restore ${id}).`);
    }
    case 'restore': {
      const r = await call('POST', `/tasks/${requireId(positional[1])}/restore`);
      return show(r, `Restored: ${fmtTask(r.task)}${r.restored_to_list ? ` (in list "${r.restored_to_list}")` : ''}`);
    }
    case 'untag': {
      const id = requireId(positional[1]);
      if (!flags.tags) throw new UsageError('untag needs --tags a,b');
      const r = await call('POST', `/tasks/${id}/tags:remove`, { tags: splitTags(flags.tags) });
      return show(r, `Updated: ${fmtTask(r.task)}`);
    }
    case 'newlist': {
      const name = positional.slice(1).join(' ').trim();
      if (!name) throw new UsageError('newlist needs a name: newlist "Errands"');
      const body = { name };
      if (flags.color) body.color = String(flags.color);
      const r = await call('POST', '/lists', body);
      return show(r, `Created list: ${r.data.name}  list_id=${r.data.id}`);
    }
    default:
      throw new UsageError(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

export { run, parseArgs, fmtTask, explain, ApiError, UsageError, API_BASE, TOKEN_ENV };

// ── CLI entry ─────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then(out => { process.stdout.write(out + '\n'); }).catch(err => {
    const msg = err instanceof ApiError ? explain(err) : err instanceof UsageError ? err.message : `Could not reach Tasqs: ${err.message}`;
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  });
}
