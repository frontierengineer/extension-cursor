# Cursor

A runtime provider that drives **Cursor's headless CLI agent**, so any model
Cursor exposes (Anthropic, OpenAI, Gemini, xAI, and Cursor's own Composer models)
can be used inside Frontier's constant UI — without ever opening the Cursor editor.

Realm: `worker` only (an agent runtime is one of the things a worker bundle
registers). It runs **on the daemon**, loaded from the bundle the host serves at
`/extensions/cursor/worker.bundle.js`.

## What it does

- Spawns Cursor's CLI once per turn, non-interactively:

  ```
  cursor-agent -p "<prompt>" --output-format stream-json [--model <m>] \
    [--resume <session-id>] --force [--approve-mcps]
  ```

  run with `cwd` = the slot directory, and relays its **NDJSON event stream** as
  Frontier's provider-agnostic **`TranscriptEvent`s** (the same format Claude Code
  and OpenCode emit), so everything above the runtime stays provider-agnostic.
- Provisions the CLI on first use into the machine's persistent home
  (`curl https://cursor.com/install -fsS | bash` → `~/.local/bin`), surfaces the
  install/login state to the Machines view (`prepare()` + `auth()`), and resumes a
  session across reservations via the `session_id` Cursor prints in its system
  event (`--resume`).
- Works **in place** on the slot's existing checkout — nothing is staged in or published out.

## Options it declares

The manifest declares one runtime option, **`model`** — a Cursor model id for
every turn (e.g. `claude-4-5-sonnet`, `claude-opus-4-8`, `gpt-5`, `gpt-5-codex`,
`gemini-3-pro`, `composer-2`, `grok-4-3`). Leave it blank to use Cursor's own
default. Run `cursor-agent models` on the machine to list what your account can use.

## Auth

The user authenticates Cursor on the machine — `cursor-agent login` (browser OAuth)
or `export CURSOR_API_KEY=…`. Frontier **injects no credentials**; `auth()` only
*reports* login state to the Machines view.

## MCP

Cursor auto-discovers MCP servers from `.cursor/mcp.json`. Before each turn the
runtime writes the frontier tool gateway (plus any user-configured servers) into the
slot's `.cursor/mcp.json` and passes `--approve-mcps` so the agent can call them
unattended. See the **MCP NOTE** in `worker/index.ts`: the gateway authenticates by
per-turn header, and whether a given Cursor build forwards custom headers on a remote
MCP server is version-dependent — if it doesn't, those tools simply aren't callable
that turn (the turn still runs).

## Known limitation: token usage

Cursor's CLI `result` event reports duration + success but **not token counts or
cost** (no usage field in the documented stream-json schema, June 2026). So this
runtime reports zero usage — the turn streams and completes correctly; only the
per-turn token/cost meter is blank. If a future CLI build adds usage to the
result/assistant events, map it in `worker/index.ts` and the meter lights up with
no other change.

## Sources

- CLI install: https://cursor.com/docs/cli/installation
- Headless / non-interactive: https://cursor.com/docs/cli/headless · https://cursor.com/docs/cli/using
- Output format (stream-json events): https://cursor.com/docs/cli/reference/output-format
- Auth: https://cursor.com/docs/cli/reference/authentication
- MCP: https://cursor.com/docs/cli/mcp
- Models: https://cursor.com/docs/models
