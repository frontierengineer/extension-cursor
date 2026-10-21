// Tests for the Cursor runtime's AUTO-INSTALL behaviour — the user's ask: a
// missing runtime should be installed by the provider, not pushed back on the
// user; failure must surface an ACTIONABLE reason (readiness 'error'), never a
// cryptic "spawn curl ENOENT", a bare exit code, or a forever-'installing' hang.
//
// Two layers:
//   1. cursorInstallFailureMessage — the PURE message builder (no I/O).
//   2. ensureCursorBinary / cursorReadiness — the install STATE MACHINE, driven
//      through the module's test seams (a fake child + a controllable binary-
//      probe), so no real curl, network, or Cursor CLI is touched.
//
// Importing the module has no side effects (register() is called by the host, not
// at import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  cursorInstallFailureMessage,
  ensureCursorBinary,
  cursorReadiness,
  resetCursorInstall,
  isStaleResumeError,
  __setInstallSpawnForTests,
  __setCursorBinaryForTests,
} from './index';

const BIN = '/home/me/.local/bin/cursor-agent';

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (s?: any) => boolean; killed: boolean;
  };
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.killed = false;
  ee.kill = (_s?: any) => { ee.killed = true; return true; };
  return ee;
}

function restoreSeams() {
  __setInstallSpawnForTests(null);
  __setCursorBinaryForTests(null);
  resetCursorInstall();
}

// ── 1) pure message builder ──────────────────────────────────────────────────

test('enoent → actionable "install curl" message', () => {
  const msg = cursorInstallFailureMessage('enoent', {});
  assert.match(msg, /curl was not found/i);
  assert.match(msg, /install curl/i);
  assert.doesNotMatch(msg, /ENOENT/, 'must not leak the cryptic spawn error code');
});

test('timeout → seconds + "will retry" message', () => {
  const msg = cursorInstallFailureMessage('timeout', { timeoutMs: 300_000 });
  assert.match(msg, /timed out after 300s/);
  assert.match(msg, /retry/i);
});

test('exit → carries the installer exit code', () => {
  assert.match(cursorInstallFailureMessage('exit', { code: 1 }), /exited 1/);
});

test('spawn → carries the underlying detail, never "undefined"', () => {
  assert.match(cursorInstallFailureMessage('spawn', { detail: 'EACCES' }), /EACCES/);
  assert.doesNotMatch(cursorInstallFailureMessage('spawn', {}), /undefined/);
});

test('all messages are single-line', () => {
  for (const m of [
    cursorInstallFailureMessage('enoent', {}),
    cursorInstallFailureMessage('timeout', { timeoutMs: 1000 }),
    cursorInstallFailureMessage('exit', { code: 7 }),
    cursorInstallFailureMessage('spawn', { detail: 'x' }),
  ]) assert.ok(m.length > 0 && !m.includes('\n'), `single-line: ${JSON.stringify(m)}`);
});

// ── 2) install state machine (through the seams) ─────────────────────────────

test('happy path: a missing binary is installed, then readiness is ready', async (t) => {
  t.after(restoreSeams);
  let bin: string | null = null;            // not installed yet…
  __setCursorBinaryForTests(() => bin);
  const child = fakeChild();
  __setInstallSpawnForTests(() => child as any);
  resetCursorInstall();

  const p = ensureCursorBinary();
  assert.equal(cursorReadiness().readiness, 'installing');
  // installer exits 0 AND the binary is now resolvable → resolves the path, ready.
  bin = BIN;
  child.emit('exit', 0, null);
  assert.equal(await p, BIN);
  assert.equal(cursorReadiness().readiness, 'ready');
});

test('curl missing (ENOENT) → resolves null with an actionable readiness error', async (t) => {
  t.after(restoreSeams);
  __setCursorBinaryForTests(() => null);
  const child = fakeChild();
  __setInstallSpawnForTests(() => child as any);
  resetCursorInstall();

  const p = ensureCursorBinary();
  child.emit('error', Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }));
  assert.equal(await p, null);
  const r = cursorReadiness();
  assert.equal(r.readiness, 'error');
  assert.match(String(r.detail), /install curl/i);
});

test('a clean exit that leaves the binary unresolvable is treated as failure', async (t) => {
  t.after(restoreSeams);
  __setCursorBinaryForTests(() => null);   // stays missing even after exit 0
  const child = fakeChild();
  __setInstallSpawnForTests(() => child as any);
  resetCursorInstall();

  const p = ensureCursorBinary();
  child.emit('exit', 0, null);
  assert.equal(await p, null);
  const r = cursorReadiness();
  assert.equal(r.readiness, 'error');
  assert.match(String(r.detail), /not resolvable/i);
});

test('attempt budget: stops spawning after the cap, then a reset reopens it', async (t) => {
  t.after(restoreSeams);
  __setCursorBinaryForTests(() => null);
  let spawns = 0;
  __setInstallSpawnForTests(() => { spawns += 1; const c = fakeChild(); queueMicrotask(() => c.emit('exit', 1, null)); return c as any; });
  resetCursorInstall();

  // Default cap is 3 — drive three failing attempts.
  for (let i = 0; i < 3; i++) assert.equal(await ensureCursorBinary(), null);
  assert.equal(spawns, 3, 'three attempts spawned the installer');
  // 4th call must NOT spawn again (budget spent).
  assert.equal(await ensureCursorBinary(), null);
  assert.equal(spawns, 3, 'budget spent → no further installer spawns');
  // A reset (what prepare() does on reconnect) reopens the budget.
  resetCursorInstall();
  assert.equal(await ensureCursorBinary(), null);
  assert.equal(spawns, 4, 'reset reopened the budget → installer spawned again');
});

// ── 3) stale --resume detection (drives the single bounded retry) ────────────

test('stale-resume detection: unknown/invalid session phrasings match', () => {
  for (const m of [
    'session not found',
    'Unknown session id abc123',
    'invalid session',
    'no such conversation',
    'chat does not exist',
    'the resume target could not be found',
    'session abc has expired',
    'this conversation no longer exists',
  ]) assert.equal(isStaleResumeError(m), true, `should match: ${m}`);
});

test('stale-resume detection: genuine model/tool failures do NOT match (no false retry)', () => {
  for (const m of [
    '',
    null,
    undefined,
    'rate limit exceeded',
    'model refused to respond',
    'tool execution failed: exit code 1',
    'network error contacting provider',
    'session started successfully', // mentions session but nothing missing
    'file not found: /tmp/x',       // missing, but not about the session
  ]) assert.equal(isStaleResumeError(m as any), false, `should NOT match: ${JSON.stringify(m)}`);
});
