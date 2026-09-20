<p align="center">
  <img src="docs/header.png" alt="triage" width="100%">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#what-feeds-it">Sources</a> ·
  <a href="#watches">Watches</a> ·
  <a href="#development">Development</a> ·
  <a href="https://usetriage.sh">Website</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/usetriage"><img src="https://img.shields.io/npm/v/usetriage?color=fcfdff&labelColor=000" alt="npm"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-fcfdff?labelColor=000" alt="node ≥ 22.5">
  <a href="https://github.com/usetriage/triage/commits/main"><img src="https://img.shields.io/github/last-commit/usetriage/triage?color=fcfdff&labelColor=000" alt="last commit"></a>
</p>

**triage** is a ranked work inbox for engineers that dispatches straight into your local Claude Code.
Review requests, mentions, threads waiting on you, and things you told it to look for arrive as one
queue, scored deterministically, each with a Dispatch button that opens a Claude session with the
context already loaded.

It runs on your machine, uses your existing Claude Code login, and never holds a credential.

<p align="center">
  <img src="docs/inbox.png" alt="The triage inbox: work grouped into Blocking, Your cycle and FYI, each a dense ledger row with its reason, source and score — the top row ready to re-enter as a Claude session" width="100%">
</p>

## Features

- **One inbox.** GitHub, Slack, Linear and your own watches, ranked by the same rules. No LLM in the scoring path.
- **Dispatch.** Any item opens a Claude Code session in the right project folder with a brief attached.
- **Watches.** One paragraph of instructions, the integrations it may use, a schedule. It files work items or writes a digest.
- **Briefs.** Queue an item and a playbook writes a markdown brief before you look at it.
- **Sessions and terminals.** Full Claude Code chats and real PTY terminals in the same workspace, same auth.
- **Receipts.** Every automated run is a session you can open. "Found nothing" is provably "looked and found nothing".
- **Workspaces.** Work and personal stay apart: separate inbox, watches, connectors and Claude login per workspace.

<table>
  <tr>
    <td width="50%"><img src="docs/session.png" alt="A dispatched item running as a Claude session, with the edit diff and test run in the transcript"></td>
    <td width="50%"><img src="docs/terminal.png" alt="A terminal tab in the same workspace, verifying the change with npm test"></td>
  </tr>
  <tr>
    <td align="center"><sub>Dispatch opens a Claude session with the item's brief.</sub></td>
    <td align="center"><sub>Verify in a real terminal, same workspace, same auth.</sub></td>
  </tr>
</table>

## Install

```sh
npm i -g usetriage
triage
```

Then open [http://triage.localhost:5178](http://triage.localhost:5178). Safari users, use [http://localhost:5178](http://localhost:5178).

| Requirement | Why |
| --- | --- |
| Node ≥ 22.5 | uses `node:sqlite`, no native deps |
| [Claude Code](https://claude.com/claude-code), logged in | sessions and watch runs use your login, not an API key |
| `gh` logged in | GitHub source · optional |
| claude.ai Slack or Linear connector | Slack and Linear sources · optional |

The `triage` command manages a background server and is safe to run any time.

```sh
triage             # start if not running, print the URL
triage stop        # stop it (ends live sessions)
triage restart     # how an upgrade takes effect
triage status      # version, pid, port, live sessions
triage logs        # tail the server log
```

> Early software. Expect rough edges and breaking changes between minor versions.

## What's new in 0.8

- Type **`/`** in the composer for the commands and skills this folder actually has — Claude Code's own, yours, the project's, and every plugin's.
- The `/` list narrows as you type, and a name that **resolves lights up** in the box, so a typo doesn't slip through to the model as prose.
- A **changes drawer** per session: git snapshots around every turn, so you can see what each one touched.
- Diff **hunks inline** in the transcript, at the tool call that made them.
- Sessions **know what triage is** — shared context and their own identity ride in the system prompt.
- `get_work_item` and `get_session_context` let a chat look up the item it was dispatched for.

## What feeds it

| Source | How | What arrives |
| --- | --- | --- |
| GitHub | your local `gh` login | review requests, your PRs by state, mentions |
| Slack | claude.ai connector, read-only | unread DMs, mentions, anything a watch finds |
| Linear | claude.ai connector, read-only | issues a watch finds |
| Web | Claude Code's own search and fetch | pages a watch finds |
| You | the composer, the palette, or MCP | anything, by hand or by paste |

Every item has a canonical id, so the same PR asked about in Slack and requested on GitHub is one row, not two.

## Watches

A watch is what you would tell a colleague: where to look, what counts, how often.

- **Instructions** in plain English. The run finds teams, channels and labels itself.
- **Integrations** it may use. This is the fence: the run only gets those tools, read-only.
- **Output**: work items, one per match, or a single rolling digest with a markdown report.
- **Schedule**, plus a model if you want to pin one.

Creating one is two steps. Fill in the details, then preview: the watch runs once as a dry run, the
transcript streams in, and you see exactly what it would have filed. Nothing is saved until you create it.

Every run is a session. Each watch has a page with its health, cost in dollars, and every run's transcript.

## Ingestion API

Any Claude Code routine or script can be a watch runner. The bundled stdio MCP shim exposes the inbox as tools:

```sh
claude mcp add triage -- triage-mcp
```

`list_work_items`, `create_work_item`, `edit_work_item`, `upsert_work_item`, `resolve_work_item`. Upserts are idempotent and
never overwrite your own state, so an external scanner cannot create duplicates or undo a "done".

## Privacy

Everything runs locally. Data lives in SQLite under `~/.triage/`. The server binds to localhost.
This package holds no Slack, GitHub or Linear credentials: sources go through your `gh` login and your
claude.ai connectors. Watch runs and briefs spend your Claude tokens; the app shows you what each one cost.

## Development

```sh
git clone https://github.com/usetriage/triage && cd triage
npm install
npm run dev          # server on :5188, Vite on :5189 — open the Vite URL
```

The server is not run under a file watcher on purpose: restarting it kills live Claude subprocesses.
Restart it by hand after changing `server/`. `npm run typecheck` covers both halves; `npm run smoke` is
the end-to-end check against a running server.

| Path | What lives there |
| --- | --- |
| `shared/protocol.ts` | the WebSocket contract, imported by both sides |
| `core/` | store interfaces and SQLite adapter, scoring, watches, sources |
| `server/` | HTTP and WebSocket server, the `triage` and `triage-mcp` bins |
| `web/` | Vite + React UI |

## Links

- Website: [usetriage.sh](https://usetriage.sh)
- Issues: [github.com/usetriage/triage/issues](https://github.com/usetriage/triage/issues)
- npm: [usetriage](https://www.npmjs.com/package/usetriage)
