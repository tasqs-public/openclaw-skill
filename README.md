# Tasqs skill for OpenClaw

Manage your [Tasqs](https://tasqs.com) to-do list from your OpenClaw agent: add, complete, reschedule, search and delete tasks; see what's due today, what's overdue, and today's Shortlist.

This is the source of the `tasqs` skill on [ClawHub](https://clawhub.ai). Install it with:

```
openclaw skills install tasqs
```

## Setup

1. API access is part of the Tasqs **Power User** plan.
2. In Tasqs, open **Profile → API Access → Create token**. Tick **Allow writes** so the agent can add and change tasks (leave it unticked for a read-only connection). Copy the token — it is shown once.
3. Give it to OpenClaw as `TASQS_API_TOKEN`, in `~/.openclaw/openclaw.json`:
   ```json5
   { skills: { entries: { tasqs: { enabled: true, env: { TASQS_API_TOKEN: "tqs_…" } } } } }
   ```
   or export it in the environment the agent runs in. (Variables set in `openclaw.json` reach the host process; if you run skills sandboxed, set it in the sandbox's environment too.)
4. Ask your agent "what's on my Tasqs list today?" — or check directly: `node scripts/tasqs.mjs lists`.

Full guide: https://tasqs.com/guides/manage-tasks-from-ai-assistant.php#openclaw

## What's in the box

```
SKILL.md            instructions the agent reads (commands, rules, setup)
scripts/tasqs.mjs   a ~250-line command-line client for the Tasqs public API v1
test/run.mjs        the test suite (fake API, no token needed)
```

The script is deliberately easy to audit:

- It contacts exactly one host, `https://tasqs.com`, hard-coded.
- It reads exactly one environment variable, `TASQS_API_TOKEN`, and sends it only as the `Authorization` header to that host. It never prints it.
- No dependencies (Node 18+ built-in `fetch`), no `eval`, no downloads, no files written.

Deleting a task moves it to the Trash, where it can be restored for 30 days. The agent is instructed to confirm before deleting and never to guess a task id.

## Commands

Run `node scripts/tasqs.mjs` with no arguments for the full list. Highlights:

| | |
|---|---|
| `today` · `overdue` · `open` · `shortlist` · `next` | what's on the list |
| `list --list "Work" --tag errands --priority high` | filtered views |
| `search "dentist"` · `get <id>` | find and inspect |
| `add "Call the dentist" --due 2026-10-14 --list Personal --priority high --tags health` | create (`--repeat weekly --until …` for recurring) |
| `edit <id> --due 2026-10-20` · `done <id>` · `reopen <id>` · `delete <id>` · `restore <id>` | change |
| `lists` · `tags` · `newlist "Errands"` | vocabulary |

Add `--json` to any command for the raw API response. The API itself is documented at https://tasqs.com/api-documentation.php.

## Development

```
node test/run.mjs                 # 50 checks against a fake API
TASQS_API_TOKEN=tqs_… node scripts/tasqs.mjs today   # against your real account
```

Publishing (maintainers): `clawhub login`, then `clawhub skill publish . --slug tasqs --version X.Y.Z --changelog "…"`.

## License

MIT © Indigo Holdings, Inc.
