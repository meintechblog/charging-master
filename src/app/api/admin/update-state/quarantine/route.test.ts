// src/app/api/admin/update-state/quarantine/route.test.ts
// Vitest coverage for DELETE /api/admin/update-state/quarantine (Plan 13-03,
// PIPE-03 backend slice). Mocks node:fs/promises, @/lib/version, and
// UpdateStateStore so the route can be exercised purely in-memory without
// touching the real state.json or filesystem.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above all top-level statements; using
// vi.hoisted ensures the mock targets are initialized before the factory
// closures execute. Without this, vi.fn() references inside the factories
// hit a ReferenceError at module evaluation time.
const { rmFn, readdirFn, readFn, writeFn } = vi.hoisted(() => ({
  rmFn: vi.fn(),
  readdirFn: vi.fn(),
  readFn: vi.fn(),
  writeFn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: { rm: rmFn, readdir: readdirFn },
  rm: rmFn,
  readdir: readdirFn,
}));

// @/lib/version is build-generated; tests must stub it so the route's
// transitive import from UpdateStateStore does not fail to resolve.
vi.mock('@/lib/version', () => ({
  CURRENT_SHA: 'abc1234567890abc1234567890abc1234567890a',
  CURRENT_SHA_SHORT: 'abc1234',
}));

vi.mock('@/modules/self-update/update-state-store', () => ({
  UpdateStateStore: class {
    read = readFn;
    write = writeFn;
  },
}));

import { DELETE } from './route';

const QUARANTINE_PATH = `${process.cwd()}/.update-state/quarantine-20260515-221500`;

function makeBaseState(): Record<string, unknown> {
  return {
    currentSha: 'abc1234567890abc1234567890abc1234567890a',
    rollbackSha: 'def4567890abcdef4567890abcdef4567890abcd',
    lastCheckAt: 1_700_000_000_000,
    lastCheckEtag: '"etag-value"',
    lastCheckResult: null,
    updateStatus: 'idle',
    rollbackHappened: false,
    rollbackReason: null,
    targetSha: null,
    updateStartedAt: null,
    rollbackStage: null,
    lastQuarantine: {
      timestamp: 1_700_000_000_000,
      fileCount: 3,
      path: QUARANTINE_PATH,
    },
  };
}

function makeRequest(host: string): Request {
  return new Request('http://localhost/api/admin/update-state/quarantine', {
    method: 'DELETE',
    headers: { host },
  });
}

describe('DELETE /api/admin/update-state/quarantine', () => {
  beforeEach(() => {
    rmFn.mockReset();
    readdirFn.mockReset();
    writeFn.mockReset();
    readFn.mockReset();
    rmFn.mockResolvedValue(undefined);
    readdirFn.mockResolvedValue([]);
    readFn.mockReturnValue(makeBaseState());
  });

  it('allowed host (charging-master.local) → 200, rm called, state patched', async () => {
    readdirFn.mockResolvedValueOnce([
      { isFile: () => true },
      { isFile: () => true },
      { isFile: () => true },
      { isFile: () => false }, // subdir entry, should NOT count
    ]);

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removedPath: string; removedFileCount: number };
    expect(body).toEqual({
      ok: true,
      removedPath: QUARANTINE_PATH,
      removedFileCount: 3,
    });
    expect(rmFn).toHaveBeenCalledTimes(1);
    expect(rmFn).toHaveBeenCalledWith(QUARANTINE_PATH, { recursive: true, force: true });
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith({ lastQuarantine: null });
  });

  it('localhost host → 200 (same allowlist as charging-master.local)', async () => {
    const res = await DELETE(makeRequest('localhost'));
    expect(res.status).toBe(200);
    expect(rmFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith({ lastQuarantine: null });
  });

  it('allowed host with lastQuarantine=null → 200 idempotent no-op', async () => {
    const state = makeBaseState();
    state.lastQuarantine = null;
    readFn.mockReturnValueOnce(state);

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removedPath: null; removedFileCount: null };
    expect(body).toEqual({ ok: true, removedPath: null, removedFileCount: null });
    expect(rmFn).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('allowed host with no lastQuarantine field (legacy state) → 200 idempotent no-op', async () => {
    const state = makeBaseState();
    delete state.lastQuarantine;
    readFn.mockReturnValueOnce(state);

    const res = await DELETE(makeRequest('localhost'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removedPath: null; removedFileCount: null };
    expect(body).toEqual({ ok: true, removedPath: null, removedFileCount: null });
    expect(rmFn).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('non-allowed host (evil.example.com) → 403 forbidden', async () => {
    const res = await DELETE(makeRequest('evil.example.com'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'forbidden' });
    expect(readFn).not.toHaveBeenCalled();
    expect(rmFn).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('quarantine path outside .update-state/quarantine-* prefix → 500 path_not_in_state_dir', async () => {
    const state = makeBaseState();
    state.lastQuarantine = {
      timestamp: 1_700_000_000_000,
      fileCount: 1,
      path: '/etc/passwd',
    };
    readFn.mockReturnValueOnce(state);

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('path_not_in_state_dir');
    expect(body.message).toBe('/etc/passwd');
    expect(rmFn).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('rm failure → 500 rm_failed, writeFn NOT called', async () => {
    rmFn.mockRejectedValueOnce(new Error('EPERM'));

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('rm_failed');
    expect(body.message).toBe('EPERM');
    // state.json must still reflect the quarantine — partial cleanup is worse
    // than no cleanup.
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('state.write failure after successful rm → 500 state_write_failed', async () => {
    writeFn.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('state_write_failed');
    expect(body.message).toBe('disk full');
    // rm DID happen — the directory is gone. The 500 signals that state.json
    // still claims a quarantine exists; UI must NOT show success.
    expect(rmFn).toHaveBeenCalledTimes(1);
  });

  it('readdir failure does NOT block rm (file count is informational)', async () => {
    readdirFn.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await DELETE(makeRequest('charging-master.local'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removedPath: string; removedFileCount: number | null };
    expect(body.ok).toBe(true);
    expect(body.removedPath).toBe(QUARANTINE_PATH);
    expect(body.removedFileCount).toBeNull();
    expect(rmFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith({ lastQuarantine: null });
  });

  it('state.read failure → 500 state_read_failed', async () => {
    readFn.mockImplementationOnce(() => {
      throw new Error('corrupt JSON');
    });

    const res = await DELETE(makeRequest('localhost'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('state_read_failed');
    expect(body.message).toBe('corrupt JSON');
    expect(rmFn).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
  });
});
