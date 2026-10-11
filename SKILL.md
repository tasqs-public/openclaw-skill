---
name: tasqs
description: Manage the user's Tasqs to-do list - add, complete, reschedule, search tasks; see today, overdue and the Shortlist. Use when they mention tasks or Tasqs.
homepage: https://tasqs.com
metadata:
  openclaw:
    emoji: "✅"
    requires:
      env: [TASQS_API_TOKEN]
      bins: [node]
    primaryEnv: TASQS_API_TOKEN
    envVars:
      TASQS_API_TOKEN:
        description: A Tasqs personal API token (tqs_…). Create one at Profile → API Access on tasqs.com (Power plan). Tick "Allow writes" so the agent can add and change tasks; leave it unticked for a read-only connection.
        required: true
        url: https://tasqs.com/profile.php#api-access
---

# Tasqs

Tasqs (https://tasqs.com) is a task manager built to help people finish, shrink, or let go of what's on their list. This skill lets you read and change the user's own tasks through the Tasqs public API. It only ever contacts `https://tasqs.com`.

## When to use this skill

Anything about the user's tasks or to-do list: "what's on my plate today", "add a task to call the dentist Friday", "what's overdue", "mark the passport one done", "move the budget review to next Monday", "what should I do next". If the user has not set up a token yet, the script says so with a link — relay that message.

## How to run it

Every action is one command:

```
node {baseDir}/scripts/tasqs.mjs <command> [arguments]
```

Run with no arguments to see the full command list. The output is plain text, one task per line, ending in `id=<32 hex characters>`. Add `--json` for the raw API response when you need a field the text doesn't show.

### Read

| What the user wants | Command |
|---|---|
| Today's tasks | `today` |
| What's overdue | `overdue` |
| Everything open | `open` (25 per page; `--page 2` for more) |
| Tasks in a list / with a tag / by priority | `list --list "Work"`, `list --tag errands`, `list --priority high` (combine freely; `--status completed` or `all`) |
| Find a task by words | `search "dentist"` |
| Full detail (description, subtasks) | `get <id>` |
| Today's Shortlist (the up-to-five chosen for today) | `shortlist` |
| "What should I do next?" | `next` |
| The user's lists / tags | `lists` / `tags` |

### Write (the token must have "Allow writes")

| What the user wants | Command |
|---|---|
| Add a task | `add "Call the dentist" --due 2026-10-14 --list "Personal" --priority high --tags health,calls` |
| Add a repeating task | `add "Water the plants" --due 2026-10-12 --repeat weekly` (`--until YYYY-MM-DD` to stop) |
| Reschedule / change | `edit <id> --due 2026-10-20` · `--no-due` · `--title "…"` · `--list "…"` · `--priority low` · `--desc "…"` |
| Complete / un-complete | `done <id>` / `reopen <id>` |
| Delete | `delete <id>` (goes to the Trash; `restore <id>` brings it back within 30 days) |
| Remove tags from a task | `untag <id> --tags old,stale` |
| Create a list | `newlist "Errands"` |

## Rules — follow these every time

1. **Never guess an id.** Ids are opaque 32-character hex strings. Always get one from a read command (`today`, `search`, `list`…) in this conversation before `edit`, `done`, `delete`, `reopen` or `get`. If several tasks could match, show them and ask which.
2. **Dates are `YYYY-MM-DD`.** Work out "Friday" or "next week" from today's date in the user's timezone, then pass the exact date. The user's timezone is handled by Tasqs; you never need to convert.
3. **Confirm before deleting.** Say which task (by title) you are about to delete and get a yes first. `done`, `add` and `edit` do not need confirmation unless the request was ambiguous. Deletion is recoverable for 30 days, so if you deleted the wrong one, run `restore <id>` immediately.
4. **Lists and tags are matched by name.** If the API says a list doesn't exist, run `lists` and use an exact name, or ask the user — don't invent one. Tags are created automatically when adding.
5. **Report what actually happened, from the command's output.** Quote the task title back ("Done: Renew passport"). Never say a task was added, completed or deleted unless the command printed that. If the command printed an error, relay it in plain words — the error text is written for the user.
6. **Read-only tokens.** If a write fails with "token is read-only", tell the user to create a new token with "Allow writes" ticked at https://tasqs.com/profile.php#api-access and update `TASQS_API_TOKEN`. Don't retry.
7. **Keep the token out of the conversation.** Never print, echo or repeat `TASQS_API_TOKEN`.
8. **Rate limits.** If a command reports rate limiting, wait the number of seconds it says and try once more, then stop and tell the user.

## Good patterns

- "What's on my plate?" → run `today` and `overdue`; summarise both, overdue first.
- "Add X on Friday" → compute the date, `add "X" --due …`, confirm with the printed line.
- "I finished the passport thing" → `search "passport"`, pick the open match (ask if more than one), `done <id>`.
- "Push everything overdue to tomorrow" → `overdue`, then one `edit <id> --due <tomorrow>` per task, then summarise.
- "What should I do next?" → `next`; if the Shortlist is empty, fall back to `today`.
- Keep answers short. The user wants their list handled, not a report.

## Setup (tell the user if the token is missing)

1. Tasqs **Power** plan is required for API access.
2. In Tasqs: **Profile → API Access → Create token**. Tick **Allow writes** unless they want read-only. Copy the token (it is shown once).
3. Give it to OpenClaw as `TASQS_API_TOKEN` — in `~/.openclaw/openclaw.json`:
   ```json5
   { skills: { entries: { tasqs: { enabled: true, env: { TASQS_API_TOKEN: "tqs_…" } } } } }
   ```
   or export it in the environment the agent runs in.
4. Run `node {baseDir}/scripts/tasqs.mjs lists` — if it prints the user's lists, everything is connected.

Setup guide with screenshots: https://tasqs.com/guides/manage-tasks-from-ai-assistant.php#openclaw · API reference: https://tasqs.com/api-documentation.php

## What this skill will not do

It cannot read other people's tasks, change account settings, or reach anything other than `https://tasqs.com`. Subtasks and attachments are read-only here (manage them in the Tasqs app). The AI features inside Tasqs (Hand to AI, Friday Amnesty voice, phone calls) are not exposed through the API.
