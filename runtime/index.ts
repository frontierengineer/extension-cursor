import type {
  RuntimeProvider,
  RuntimeRunInput,
  RuntimeRunResult,
  TranscriptEvent,
  TranscriptStopReason,
  TokenUsage,
} from '../../types';

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn, execSync, ChildProcess } from 'child_process';

// The Cursor runtime. Drives Cursor's headless CLI agent for ONE dispatched turn
// and relays its NDJSON event stream as Frontier's provider-agnostic
// TranscriptEvents — the same shape Claude Code / OpenCode emit, so everything
// above the runtime stays provider-agnostic. One runtime covers every model
// Cursor exposes (Anthropic, OpenAI, Gemini, xAI, Cursor's own Composer, …). It
// works IN PLACE on the slot's existing checkout (the workspace provider owns the
// directory + VCS); this runtime is handed a directory, a model, and a prompt.
//
// HOW IT DRIVES CURSOR (verified against Cursor's CLI docs, June 2026):
//   • The CLI is installed by `curl https://cursor.com/install -fsS | bash` into
//     ~/.local/bin (persistent home, survives restarts). The on-disk binary is
//     `cursor-agent` with an `agent` alias — we look for either name.
//       https://cursor.com/docs/cli/installation
//   • One non-interactive turn:
//       cursor-agent -p "<prompt>" \
//         --output-format stream-json \
//         [--model <m>] [--resume <session-id>] --force
//     run with cwd = the slot directory. `-p/--print` is the headless flag;
//     `--force` (a.k.a. --yolo) auto-approves tool/command execution so the turn
//     runs unattended; `--output-format stream-json` emits NDJSON events.
//       https://cursor.com/docs/cli/using   https://cursor.com/docs/cli/headless
//   • stream-json events (one JSON object per line, all carry `session_id`):
//       { type:'system', subtype:'init', session_id, model, cwd, permissionMode,
//         apiKeySource }                                  (turn start)
//       { type:'user', message:{ role, content }, session_id }
//       { type:'assistant', message:{ role:'assistant',
//         content:[{ type:'text', text }|{ type:'thinking', thinking }] },
//         session_id, timestamp_ms?, model_call_id? }     (assistant output;
//         with --stream-partial-output these arrive as deltas)
//       { type:'tool_call', subtype:'started'|'completed', call_id, tool_call,
//         session_id }                                    (tool lifecycle)
//       { type:'result', subtype, duration_ms, is_error, result, session_id,
//         request_id }                                    (terminal)
//       https://cursor.com/docs/cli/reference/output-format
//   • Resume: `--resume <session-id>` replays a prior chat; the session id is the
//     `session_id` printed in the system init event — we persist it as the durable
//     providerSessionId so the next turn resumes on the SAME machine.
//       https://cursor.com/docs/cli/using
//   • Auth: the user logs in on the machine (`cursor-agent login`) or sets
//     CURSOR_API_KEY; credentials are the user's own act — Frontier injects none.
//     We only READ login state for the Machines view.
//       https://cursor.com/docs/cli/reference/authentication
//   • MCP: Cursor reads `.cursor/mcp.json` (project) and `~/.cursor/mcp.json`
//     (global). We write the frontier gateway (+ any user servers) to the SLOT's
//     `.cursor/mcp.json` before the turn and pass `--approve-mcps` so the agent
//     can call them unattended. See wireMcp + the MCP NOTE there.
//       https://cursor.com/docs/cli/mcp
//
// USAGE LIMITATION (honest): the Cursor CLI's stream-json `result` event reports
// duration + success but does NOT surface token counts or cost (no usage event in
// the documented schema, June 2026). So this runtime reports ZERO_USAGE — the turn
// still runs and streams correctly; only the per-turn token/cost meter is blank.
// If a future CLI build adds usage to the result/assistant events, map it in
// handleEvent's `result` case (where the terminal event is folded into the relay)
// and thread it onto RelayState so run() reports it instead of ZERO_USAGE.

// The contract's all-zero usage. The Cursor CLI does not report token usage, so
// every turn returns this (see USAGE LIMITATION above).
const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

// ── binary resolution + install ─────────────────────────────────────────────
//
// Cursor's CLI is NOT baked into the image — this runtime OWNS its binary and
// provisions it ON THE MACHINE the first time it's needed, into the machine's
// PERSISTENT home (~/.local) so it survives restarts. The official installer is a
// curl|bash script (https://cursor.com/install) that drops the binary in
// ~/.local/bin; an existing/system install is always preferred. Single-flight so
// concurrent turns/probes never double-install; a no-op the moment a binary is
// found.

const LOCAL_PREFIX = process.env.FRONTIER_CURSOR_PREFIX || path.join(os.homedir(), '.local');
// The installer's URL — pinned to the official endpoint; override per-machine.
const CURSOR_INSTALL_URL = process.env.FRONTIER_CURSOR_INSTALL_URL || 'https://cursor.com/install';
// Upper bound on the install (override per-machine). A hung curl|bash — a dead
// endpoint, a stalled network, a prompt on stdin we'll never answer — must NOT pin
// readiness on 'installing' forever or block a lazy first-use turn indefinitely: we
// kill it past the deadline and record an actionable error so a later attempt can
// retry. Generous (cold network + a download are slow).
const INSTALL_TIMEOUT_MS = Number(process.env.FRONTIER_CURSOR_INSTALL_TIMEOUT_MS) || 5 * 60_000;
// Hard cap on install ATTEMPTS so a box where the install can never succeed (no
// network, no curl) stops re-running a doomed install on every turn. Single-flight
// already collapses concurrent callers into one install; this bounds *sequential*
// retries. Once the budget is spent and the last attempt failed, ensure*() returns
// null immediately (readiness stays 'error') until resetCursorInstall() reopens it —
// prepare() resets once per connect, so a reconnect/restart retries with a clean budget.
const INSTALL_MAX_ATTEMPTS = Number(process.env.FRONTIER_CURSOR_INSTALL_MAX_ATTEMPTS) || 3;

// The installer ships the binary as `cursor-agent`, exposed via an `agent` alias.
// We look for BOTH names so an install by either path/version resolves.
function findCursorBinaryReal(): string | null {
  const home = os.homedir();
  const names = ['cursor-agent', 'agent'];
  const dirs = [
    path.join(LOCAL_PREFIX, 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    '/usr/local/bin',
  ];
  const explicit = process.env.FRONTIER_CURSOR_BIN || '';
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...dirs.flatMap((d) => names.map((n) => path.join(d, n))),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  // Fall back to PATH (resolve a symlink to the real binary).
  for (const n of names) {
    try {
      const which = execSync(`which ${n} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (which && fs.existsSync(which)) {
        try { return fs.realpathSync(which); } catch { return which; }
      }
    } catch { /* not on PATH */ }
  }
  return null;
}
// Binary-lookup SEAM: the real lookup by default; overridable in tests so the
// install state machine + readiness can be driven without an on-disk binary.
let findCursorBinaryHook: () => string | null = findCursorBinaryReal;
function cursorBinary(): string | null { return findCursorBinaryHook(); }
// Test seam: override whether a cursor binary is found (and restore it).
export function __setCursorBinaryForTests(fn: (() => string | null) | null): void {
  findCursorBinaryHook = fn || findCursorBinaryReal;
}

let cursorInstall: Promise<string | null> | null = null;
let cursorInstallError: string | null = null;
let cursorInstallAttempts = 0;

// Forget the failure + attempt budget so a later ensureCursorBinary() retries
// cleanly. EXPORTED for tests; in prod it's driven by prepareCursor().
export function resetCursorInstall(): void {
  cursorInstallError = null;
  cursorInstallAttempts = 0;
}

// The spawn used to start the install — a SEAM so tests drive the state machine
// with a fake child (no real curl, no network). Production runs the official
// curl|bash installer with HOME/PREFIX pointed at the persistent home.
type InstallSpawn = () => {
  stdout?: { on(ev: 'data', cb: (c: Buffer | string) => void): void } | null;
  stderr?: { on(ev: 'data', cb: (c: Buffer | string) => void): void } | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(ev: 'error', cb: (e: NodeJS.ErrnoException) => void): void;
  on(ev: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};
function realInstallSpawn(): ReturnType<InstallSpawn> {
  // `curl <url> -fsS | bash` — run via `sh -c` so the pipe is honored. The
  // installer writes into ~/.local/bin; we pass HOME explicitly so it lands in
  // the persistent home even if the daemon's env is sparse.
  const cmd = `curl ${CURSOR_INSTALL_URL} -fsS | bash`;
  return spawn('sh', ['-c', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: os.homedir() },
  });
}
let installSpawn: InstallSpawn = realInstallSpawn;
// Test seam: override the install spawn (and restore it). Never used in prod.
export function __setInstallSpawnForTests(fn: InstallSpawn | null): void {
  installSpawn = fn || realInstallSpawn;
}

// Turn an installer failure into an ACTIONABLE, single-line reason for the
// readiness signal — never a cryptic "spawn curl ENOENT" or a bare exit code.
// Pure (no I/O), so it's unit-tested directly. `kind`:
//   'enoent'  → curl/sh isn't on PATH (the worker needs curl to provision)
//   'timeout' → we killed a hung installer past the deadline (network stall)
//   'exit'    → the installer ran but failed (carries its exit code)
//   'spawn'   → spawn errored for another reason (carries the raw message)
export function cursorInstallFailureMessage(
  kind: 'enoent' | 'timeout' | 'exit' | 'spawn',
  opts: { timeoutMs?: number; code?: number | null; detail?: string },
): string {
  switch (kind) {
    case 'enoent':
      return `curl was not found on this machine — install curl so the runtime can fetch the Cursor CLI from ${CURSOR_INSTALL_URL}`;
    case 'timeout':
      return `Cursor CLI install timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s (network stall?) — will retry on next use`;
    case 'exit':
      return `Cursor CLI install (${CURSOR_INSTALL_URL}) exited ${opts.code}`;
    case 'spawn':
    default:
      return `Cursor CLI install failed: ${opts.detail || 'unknown error'}`;
  }
}

// Provision the Cursor CLI into the machine's persistent home. No-op (returns the
// path) if already present. Single-flight: concurrent callers join one install.
// BOUNDED: once INSTALL_MAX_ATTEMPTS have failed, it returns null immediately
// without spawning again (until resetCursorInstall reopens the budget) so a box
// where the install can't succeed never loops forever. Resolves the binary path on
// success, null on failure (with cursorInstallError set).
export function ensureCursorBinary(): Promise<string | null> {
  const existing = cursorBinary();
  if (existing) { cursorInstallError = null; return Promise.resolve(existing); }
  if (cursorInstall) return cursorInstall;
  if (cursorInstallAttempts >= INSTALL_MAX_ATTEMPTS) {
    return Promise.resolve(null);
  }
  cursorInstallAttempts += 1;
  console.log(`[cursor] CLI not found — installing from ${CURSOR_INSTALL_URL} into ${LOCAL_PREFIX} (attempt ${cursorInstallAttempts}/${INSTALL_MAX_ATTEMPTS})`);
  cursorInstallError = null; // a new attempt supersedes any prior failure
  cursorInstall = new Promise<string | null>((resolve) => {
    const child = installSpawn();
    // Bound one install: kill a hung installer past the deadline so readiness flips
    // to 'error' (and a later turn can retry) instead of hanging on 'installing'.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const fail = (msg: string) => { clearTimeout(timer); cursorInstallError = msg; cursorInstall = null; resolve(null); };
    child.stdout?.on('data', (c) => console.log(`[cursor-install] ${String(c).trim()}`));
    child.stderr?.on('data', (c) => console.error(`[cursor-install] ${String(c).trim()}`));
    child.on('error', (e: NodeJS.ErrnoException) => {
      const kind = e?.code === 'ENOENT' ? 'enoent' : 'spawn';
      fail(cursorInstallFailureMessage(kind, { detail: e?.message || String(e) }));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) { fail(cursorInstallFailureMessage('timeout', { timeoutMs: INSTALL_TIMEOUT_MS })); return; }
      // A clean exit must ALSO leave the binary resolvable — otherwise the install
      // "succeeded" but we still can't run it, which would loop on the lazy path.
      if (code === 0) {
        const bin = cursorBinary();
        if (bin) { cursorInstall = null; cursorInstallError = null; resolve(bin); }
        else { fail('Cursor CLI install reported success but the binary is still not resolvable (is ~/.local/bin populated?)'); }
      } else {
        fail(cursorInstallFailureMessage('exit', { code }));
      }
    });
  });
  return cursorInstall;
}

// The eager prepare() the daemon fires the moment a machine connects (see
// RuntimeImpl.prepare): front-run the SAME ensureCursorBinary() the first run()
// would lazily call, so a missing CLI or a broken network is installed/surfaced UP
// FRONT instead of mid-turn. Single-flight + a no-op when already installed
// (shares the lazy latch), so firing it never double-installs. Resolves once the
// binary is present; REJECTS on install failure so the daemon logs a real reason —
// the durable 'error' a user sees still comes from cursorReadiness().
async function prepareCursor(): Promise<void> {
  if (cursorBinary()) return; // an existing/system binary already satisfies us
  resetCursorInstall();
  const bin = await ensureCursorBinary();
  if (!bin) throw new Error(cursorInstallError || 'Cursor CLI install failed');
}

// The install half of the readiness signal (the login half is auth() below),
// derived synchronously from the same module state ensureCursorBinary() maintains —
// never spawns or touches the network. 'ready' once a binary is resolvable;
// 'installing' while a provision is in flight; 'error' when the last attempt failed
// (and none is running); 'checking' before anything has run.
export function cursorReadiness(): { readiness: 'checking' | 'installing' | 'ready' | 'error'; detail?: string } {
  if (cursorBinary()) return { readiness: 'ready', detail: 'installed' };
  if (cursorInstall) return { readiness: 'installing', detail: 'installing Cursor CLI…' };
  if (cursorInstallError) return { readiness: 'error', detail: `install failed: ${cursorInstallError}` };
  return { readiness: 'checking', detail: 'not installed yet' };
}

export function register(runtimeProvider: RuntimeProvider): void {
  const runtime = runtimeProvider.version(1);

  runtime.register({
    label: 'Cursor',

    // Eagerly provision the Cursor CLI on this machine the moment it connects, in
    // the background — so a missing binary or a broken network is surfaced (and
    // fixed) up front rather than mid-turn. Shares ensureCursorBinary()'s
    // single-flight latch with the lazy run() path. See prepareCursor.
    prepare: prepareCursor,

    // Report whether Cursor is usable on THIS machine (the Machines-view signal).
    // Cheap + side-effect-free: we never spawn the CLI, install, or touch the
    // network just to probe (this runs every heartbeat). The verdict has two
    // halves — `readiness` is the INSTALL state (read synchronously from the
    // prepare()/ensure latch via cursorReadiness) and `auth` is the LOGIN state.
    // Not yet installed → readiness carries checking/installing/error and we leave
    // the login verdict 'unknown' (can't know it without the binary). A
    // CURSOR_API_KEY in the environment, or a stored login under ~/.cursor/ or
    // ~/.config/cursor/, means 'ok'; neither means the user must
    // `cursor-agent login` on the machine. We only READ; Frontier injects no
    // credentials. Never throws.
    async auth() {
      try {
        const ready = cursorReadiness();
        if (ready.readiness !== 'ready') {
          return { auth: 'unknown' as const, readiness: ready.readiness, detail: ready.detail };
        }
        if (process.env.CURSOR_API_KEY) {
          return { auth: 'ok' as const, readiness: 'ready' as const, detail: 'CURSOR_API_KEY in environment' };
        }
        const home = os.homedir();
        const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        // Cursor's CLI stores its login under the user's home; the exact file has
        // shifted across versions, so we accept any of the known credential
        // locations rather than pinning one. Presence (non-empty) ⇒ logged in.
        const candidates = [
          path.join(home, '.cursor', 'cli-config.json'),
          path.join(home, '.cursor', 'auth.json'),
          path.join(home, '.cursor', 'credentials.json'),
          path.join(configHome, 'cursor', 'auth.json'),
          path.join(configHome, 'cursor-agent', 'auth.json'),
        ];
        for (const c of candidates) {
          try { if (fs.existsSync(c) && fs.statSync(c).size > 2) return { auth: 'ok' as const, readiness: 'ready' as const, detail: 'logged in' }; }
          catch { /* keep looking */ }
        }
        return { auth: 'logged_out' as const, readiness: 'ready' as const, detail: 'run `cursor-agent login` on this machine, or set CURSOR_API_KEY' };
      } catch (err: any) {
        return { auth: 'unknown' as const, detail: err?.message || 'probe failed' };
      }
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      const sid = input.sessionId; // the durable session this turn streams under
      input.emit({ type: 'turn_start', sessionId: sid, userPrompt: input.userPrompt, ts: Date.now() });

      // Resolve (provisioning on first use) the CLI binary.
      const bin = await ensureCursorBinary();
      if (!bin) {
        const message = `Cursor CLI is not available on this machine and auto-install failed${cursorInstallError ? ` (${cursorInstallError})` : ''} — install it with \`curl ${CURSOR_INSTALL_URL} -fsS | bash\``;
        input.emit({ type: 'error', sessionId: sid, code: 'runtime_error', message, recoverable: false, ts: Date.now() });
        input.emit({ type: 'done', sessionId: sid, stopReason: 'error', usage: ZERO_USAGE });
        return { stopReason: 'error', usage: ZERO_USAGE, providerSessionId: input.sessionId || undefined, error: message };
      }

      // Write the frontier MCP gateway (+ any user servers) to the slot's
      // `.cursor/mcp.json` so the agent can call this extension's tools. Best-
      // effort: a write failure costs the tools, never the turn. See wireMcp.
      const wroteMcp = await wireMcp(input);

      // The full system prompt for this turn (+ optional persona preamble). The
      // CLI has no dedicated system-prompt flag in its documented headless surface,
      // so we PREPEND it to the user prompt as a delimited preamble. (If a future
      // CLI build adds --system / --append-system-prompt, switch to it here.)
      const preamble = [input.personaPrompt, input.systemPrompt].filter(Boolean).join('\n\n');
      const prompt = preamble
        ? `<system>\n${preamble}\n</system>\n\n${input.userPrompt}`
        : input.userPrompt;

      // Build the argv. `-p` = headless/non-interactive; stream-json = NDJSON
      // events; --force auto-approves tool/command execution so the turn runs
      // unattended (the slot is the isolation boundary); --approve-mcps
      // auto-approves MCP tools when we wired any. `--resume <id>` is appended
      // per-attempt below (NOT here) so the stale-resume retry can drop it. We
      // pass the prompt as a flag value, not on stdin.
      const baseArgs = ['-p', prompt, '--output-format', 'stream-json', '--force'];
      if (input.model) { baseArgs.push('--model', input.model); }
      if (wroteMcp) { baseArgs.push('--approve-mcps'); }
      const wantsResume = !!(input.resume && input.sessionId);

      // Relay state: accumulate the final assistant text, track the provider
      // session id (printed in the system init event), and capture any terminal
      // error from the result event. Re-made per attempt (see runAttempt).
      const makeRelay = (): RelayState => ({
        responseText: '',
        providerSessionId: input.sessionId || undefined,
        error: null,
        stopReason: 'end_turn',
        textIdByCall: new Map(),
        seq: 0,
      });

      // Run ONE cursor-agent invocation end to end: spawn, wire abort, drive the
      // stream. `useResume` decides whether `--resume <id>` is appended. Returns
      // the populated relay on a completed (success OR terminal-error) run, or a
      // finished RuntimeRunResult when the turn is already settled (a SYNCHRONOUS
      // spawn failure, a cancel, or a transport/process error caught from drive) —
      // in which case run() returns it verbatim and does not retry.
      const runAttempt = async (
        useResume: boolean,
      ): Promise<{ relay: RelayState } | { result: RuntimeRunResult }> => {
        const args = useResume ? [...baseArgs, '--resume', input.sessionId] : baseArgs;
        const relay = makeRelay();

        // spawn() can throw SYNCHRONOUSLY (EACCES/ENOEXEC/ETXTBSY) before the
        // 'error' event exists. If it does, settle the turn HERE with the standard
        // error+done pair (mirroring the !bin branch above) instead of letting the
        // throw escape run() with no transcript events — which would hang the UI
        // turn forever.
        let child: ChildProcess;
        try {
          child = spawn(bin, args, {
            cwd: input.workspaceDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              ...(input.env || {}),
              // Cursor's CLI uses CURSOR_API_KEY for headless auth when present; we
              // never set it ourselves (the user owns credentials), but we forward
              // the turn's env verbatim above so a user-provided key flows through.
            },
          });
        } catch (err: any) {
          const message = err?.message ? String(err.message) : String(err);
          input.emit({ type: 'error', sessionId: sid, code: 'runtime_error', message: `cursor: failed to launch the CLI: ${message}`, recoverable: false, ts: Date.now() });
          input.emit({ type: 'done', sessionId: sid, stopReason: 'error', usage: ZERO_USAGE });
          return { result: { stopReason: 'error', usage: ZERO_USAGE, providerSessionId: input.sessionId || undefined, error: `cursor: failed to launch the CLI: ${message}` } };
        }

        // Forward the dispatch's abort to the child so generation actually stops.
        let onAbort: (() => void) | null = null;
        if (input.signal) {
          onAbort = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
          if (input.signal.aborted) onAbort();
          else input.signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          await drive(child, sid, input, relay);
        } catch (err: any) {
          const cancelled = input.signal?.aborted || err?.name === 'AbortError';
          const message = err?.message ? String(err.message) : String(err);
          if (!cancelled) {
            input.emit({ type: 'error', sessionId: sid, code: 'runtime_error', message: `cursor: ${message}`, recoverable: false, ts: Date.now() });
          }
          input.emit({ type: 'done', sessionId: sid, stopReason: cancelled ? 'cancelled' : 'error', usage: ZERO_USAGE });
          return {
            result: {
              stopReason: cancelled ? 'cancelled' : 'error',
              usage: ZERO_USAGE,
              providerSessionId: relay.providerSessionId,
              responseText: relay.responseText || undefined,
              error: cancelled ? undefined : `cursor: ${message}`,
            },
          };
        } finally {
          if (onAbort && input.signal) input.signal.removeEventListener('abort', onAbort);
        }
        return { relay };
      };

      // First attempt (with --resume when asked). If it failed with a terminal
      // stale/unknown-session error AND we were resuming, retry ONCE without
      // --resume — a fresh native session — so a stale providerSessionId (a
      // pruned/cross-machine/format-changed id) doesn't lose the whole turn. The
      // retry is SINGLE and bounded (no loop); its events stream under the same
      // durable session and its new session_id is captured as before.
      let outcome = await runAttempt(wantsResume);
      if (
        'relay' in outcome &&
        wantsResume &&
        !input.signal?.aborted &&
        outcome.relay.stopReason === 'error' &&
        isStaleResumeError(outcome.relay.error)
      ) {
        console.error(`[cursor] --resume ${input.sessionId} failed as stale/unknown ("${outcome.relay.error}") — retrying once without --resume (fresh session)`);
        outcome = await runAttempt(false);
      }
      if ('result' in outcome) return outcome.result;
      const relay = outcome.relay;

      if (input.signal?.aborted) {
        input.emit({ type: 'done', sessionId: sid, stopReason: 'cancelled', usage: ZERO_USAGE });
        return { stopReason: 'cancelled', usage: ZERO_USAGE, providerSessionId: relay.providerSessionId, responseText: relay.responseText || undefined, error: 'cancelled' };
      }

      input.emit({ type: 'usage', sessionId: sid, usage: ZERO_USAGE });
      input.emit({ type: 'done', sessionId: sid, stopReason: relay.stopReason, usage: ZERO_USAGE });
      return {
        stopReason: relay.stopReason,
        usage: ZERO_USAGE,
        providerSessionId: relay.providerSessionId,
        responseText: relay.responseText || undefined,
        error: relay.error || undefined,
      };
    },

    // Like claude-code/opencode, the Cursor runtime works in place on the slot's
    // existing checkout — it runs the CLI with cwd = the slot directory, so there
    // is nothing to stage in or publish out.
    //
    // No history: the Cursor CLI keeps its own session store, but its on-disk
    // format is not a documented/stable read surface (June 2026), so this runtime
    // does not expose the cold/history plane. Resume still works via
    // providerSessionId (the live plane is fully relayed); only browsing prior
    // Cursor transcripts as Frontier history is unavailable. If Cursor documents a
    // session-store format or a `cursor-agent export <id>` command, implement
    // RuntimeHistory here against it.
  });
}

// ── stream-json relay ────────────────────────────────────────────────────────

interface RelayState {
  responseText: string;
  providerSessionId?: string;
  error: string | null;
  stopReason: TranscriptStopReason;
  // call_id → the transcript text id we assigned, so a tool's text groups stably.
  textIdByCall: Map<string, string>;
  // Monotonic counter for synthesizing stable ids for assistant text/thinking
  // blocks the CLI doesn't id itself.
  seq: number;
}

// Drive the child's stdout as an NDJSON stream, mapping each event to
// TranscriptEvents. Resolves when the process exits cleanly (or after the result
// event); rejects on a transport/process error. The CLI emits one JSON object per
// line; we buffer partial lines across chunks.
function drive(
  child: ChildProcess,
  sessionId: string,
  input: RuntimeRunInput,
  relay: RelayState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buf = '';
    let stderr = '';
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; } // skip non-JSON noise
        handleEvent(ev, sessionId, input, relay);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr += c;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); // bound it
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') done(new Error('the Cursor CLI binary disappeared between resolve and spawn'));
      else done(e instanceof Error ? e : new Error(String(e)));
    });
    child.on('exit', (code, signal) => {
      // Flush any trailing line without a newline.
      const tail = buf.trim();
      if (tail) {
        try { handleEvent(JSON.parse(tail), sessionId, input, relay); } catch { /* ignore */ }
      }
      if (input.signal?.aborted || signal === 'SIGTERM' || signal === 'SIGKILL') {
        relay.stopReason = 'cancelled';
        done();
        return;
      }
      // A non-zero exit with no result event is a hard failure — surface stderr.
      if (code !== 0 && !relay.error) {
        relay.error = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `Cursor CLI exited ${code}`;
        relay.stopReason = 'error';
      }
      done();
    });
  });
}

// Map one stream-json event to TranscriptEvents + fold it into the relay state.
function handleEvent(ev: any, sessionId: string, input: RuntimeRunInput, relay: RelayState): void {
  const type: string = ev?.type || '';
  // Every event carries session_id; the system init event is where the durable id
  // first appears, but we keep the latest seen for safety.
  if (typeof ev?.session_id === 'string' && ev.session_id) relay.providerSessionId = ev.session_id;

  switch (type) {
    case 'system':
      // { subtype:'init', session_id, model, cwd, permissionMode, apiKeySource }.
      // Nothing to emit (turn_start already fired in run()); the session_id was
      // captured above for resume.
      return;

    case 'user':
      // The CLI echoes the prompt back as a user event — not a transcript line of
      // ours (run() owns turn_start with the user prompt). Ignore.
      return;

    case 'assistant': {
      // { message:{ role:'assistant', content:[ … ] }, session_id, timestamp_ms?,
      // model_call_id? }. Content blocks are text / thinking. With
      // --stream-partial-output these arrive as deltas; we don't request partials,
      // so each assistant event is a complete message between tool calls — emit its
      // blocks as final (partial:false) lines.
      const content = ev?.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        const text: string =
          typeof block?.text === 'string' ? block.text
          : typeof block?.thinking === 'string' ? block.thinking
          : '';
        const kind = block?.type === 'thinking' || (typeof block?.thinking === 'string') ? 'thinking' : 'text';
        if (!text) continue;
        const id = `a-${relay.seq++}`;
        if (kind === 'thinking') {
          input.emit({ type: 'thinking', sessionId, id, delta: text, partial: false, text, ts: Date.now() });
        } else {
          relay.responseText = text; // last complete assistant text is the turn's answer
          input.emit({ type: 'text', sessionId, id, delta: text, partial: false, text, ts: Date.now() });
        }
      }
      // Some builds put the message text directly on a `content` string rather than
      // a block array — handle that too.
      if (!blocks.length && typeof content === 'string' && content) {
        const id = `a-${relay.seq++}`;
        relay.responseText = content;
        input.emit({ type: 'text', sessionId, id, delta: content, partial: false, text: content, ts: Date.now() });
      }
      return;
    }

    case 'tool_call': {
      // { subtype:'started'|'completed', call_id, tool_call, session_id }.
      // tool_call carries the tool name + args (started) and result (completed).
      // ASSUMPTION: the CLI's call_id is stable across the started/completed pair so
      // a tool_result correlates to its tool_call; when absent we synthesize a unique
      // id (no correlation, but the events still render).
      const callId: string = String(ev?.call_id || `tool-${relay.seq++}`);
      const tc = ev?.tool_call || {};
      const subtype: string = ev?.subtype || '';
      if (subtype === 'completed' || tc?.result !== undefined) {
        const result = tc?.result ?? tc?.output ?? '';
        const isError = !!(tc?.is_error || tc?.error);
        input.emit({ type: 'tool_result', sessionId, callId, output: isError ? (tc?.error ?? result) : result, isError, durationMs: Number(tc?.duration_ms) || 0, ts: Date.now() });
      } else {
        const name: string = String(tc?.name || tc?.tool || ev?.name || 'tool');
        const args = tc?.args ?? tc?.arguments ?? tc?.input ?? {};
        input.emit({ type: 'tool_call', sessionId, callId, name, input: args, partial: false, ts: Date.now() });
      }
      return;
    }

    case 'result': {
      // { subtype, duration_ms, is_error, result, session_id, request_id } — the
      // terminal event. subtype 'success' ⇒ end_turn; anything error-ish ⇒ error.
      if (ev?.is_error) {
        relay.stopReason = 'error';
        const msg = typeof ev?.result === 'string' && ev.result ? ev.result : (ev?.subtype || 'cursor run errored');
        relay.error = relay.error || String(msg);
        input.emit({ type: 'error', sessionId, code: String(ev?.subtype || 'error'), message: String(msg), recoverable: false, ts: Date.now() });
      } else {
        relay.stopReason = mapResultSubtype(ev?.subtype);
        // The result text is the authoritative final answer when present.
        if (typeof ev?.result === 'string' && ev.result) relay.responseText = ev.result;
      }
      return;
    }

    default:
      // thinking / status / request / unknown structural events — no transcript
      // line of their own; ignore. (If a future build emits a usage event, map it
      // in the `result` case above and thread it through the relay.)
      return;
  }
}

// Best-effort detection of a terminal error that means the `--resume <id>` target
// is unknown/invalid (pruned, from another machine, or a session-format change) —
// as opposed to a genuine model/tool failure that a fresh session wouldn't fix. The
// CLI's error wording isn't a documented stable surface (June 2026), so we match the
// common phrasings loosely. A false positive only costs one extra (resume-less)
// attempt; a false negative just means we don't retry — neither is catastrophic.
export function isStaleResumeError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // Must reference the session/chat/conversation AND be about it missing/invalid.
  const mentionsSession = /\b(session|chat|conversation|thread|resume)\b/.test(m);
  const looksMissing = /\b(not\s*(be\s*)?found|unknown|invalid|no\s*such|does\s*not\s*exist|doesn'?t\s*exist|expired|missing|could\s*not\s*(be\s*)?find|couldn'?t\s*(be\s*)?find|no\s*longer)\b/.test(m);
  return mentionsSession && looksMissing;
}

// Map the result event's subtype to a stop reason.
function mapResultSubtype(subtype: unknown): TranscriptStopReason {
  switch (String(subtype || '')) {
    case 'success': return 'end_turn';
    case 'max_turns':
    case 'error_max_turns': return 'max_tokens';
    case 'cancelled':
    case 'aborted': return 'cancelled';
    default:
      // An unrecognized non-error subtype is treated as a normal end.
      return 'end_turn';
  }
}

// ── MCP wiring ───────────────────────────────────────────────────────────────
//
// Cursor's CLI auto-discovers MCP servers from `.cursor/mcp.json` in the project
// root (and `~/.cursor/mcp.json` globally). We write the frontier gateway (+ any
// user-configured servers) to the SLOT's `.cursor/mcp.json` before the turn, then
// pass --approve-mcps so the agent can call them unattended.
//
// MCP NOTE / LIMITATION: Cursor's documented mcp.json schema is the standard MCP
// shape — a "command/args/env" (stdio) server or a "url" (remote/SSE) server. The
// frontier gateway is an HTTP endpoint with per-turn auth HEADERS
// (input.mcpEndpoint.auth). Whether THIS Cursor build forwards custom headers on a
// remote MCP server is version-dependent and not guaranteed by the public schema
// (June 2026); we write url+headers (the widely-used shape) best-effort. If a given
// build ignores the headers, the gateway's per-session auth won't be satisfied and
// those tools simply won't be callable — the turn still runs. Returns true when we
// wrote at least one server (so run() adds --approve-mcps).
async function wireMcp(input: RuntimeRunInput): Promise<boolean> {
  const servers: Record<string, unknown> = {};

  if (input.mcpEndpoint?.url) {
    servers.frontier = {
      url: input.mcpEndpoint.url,
      ...(input.mcpEndpoint.auth ? { headers: input.mcpEndpoint.auth } : {}),
    };
  }

  if (!Object.keys(servers).length) return false;

  const dir = path.join(input.workspaceDir, '.cursor');
  const file = path.join(dir, 'mcp.json');
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Merge with any existing mcp.json so we don't clobber the user's own servers
    // (we only own the 'frontier' key).
    let existing: any = {};
    try {
      const prev = await fsp.readFile(file, 'utf-8');
      existing = JSON.parse(prev);
    } catch { /* no/invalid existing file — start fresh */ }
    // Drop any prior 'frontier' key BEFORE merging so a stale gateway URL/headers
    // from a previous turn can never linger: the 'frontier' server is ours to own
    // and must reflect ONLY this turn's mcpEndpoint (re-stamped each turn, exactly
    // as opencode re-POSTs the 'frontier' registration to refresh its auth header).
    // When this turn has no mcpEndpoint, `servers` carries no 'frontier' key and the
    // deletion leaves it gone rather than accumulating as committable cruft. The
    // 'frontier' key we set overwrites any prior one; everything else is preserved.
    const prevServers = { ...(existing?.mcpServers || {}) };
    delete prevServers.frontier;
    const merged = {
      ...existing,
      mcpServers: { ...prevServers, ...servers },
    };
    // Write ATOMICALLY: a temp file in the SAME dir + rename, so a concurrent
    // reader (the cursor-agent we're about to spawn) never sees a half-written,
    // truncated mcp.json — rename is atomic within a filesystem.
    const tmp = path.join(dir, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
    try {
      await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
      await fsp.rename(tmp, file);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* temp already gone */ }
      throw err;
    }
    return true;
  } catch (err: any) {
    console.error(`[cursor] could not write ${file}: ${err?.message || err}`);
    return false;
  }
}
