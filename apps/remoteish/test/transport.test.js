import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestLocalish, subscribeToLocalishEvents } from '../src/transport.js';

function socketName() {
  if (process.platform === 'win32') {
    return `${String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92)}localish-test-${randomUUID()}`;
  }
  return path.join(os.tmpdir(), `l-${randomUUID()}.sock`);
}

test('remoteish uses HTTP requests and an SSE stream over its configured socket', async (t) => {
  const socketPath = socketName();
  const originalSocket = process.env.LOCALISH_REMOTE_SOCKET;
  const server = createServer(async (request, response) => {
    if (request.url === '/internal/test') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      return;
    }
    if (request.url === '/internal/sessions/session/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(': connected\n\n');
      response.end(`data: ${JSON.stringify({ id: 'task-1', operation: { op: 'list' } })}\n\n`);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (originalSocket === undefined) delete process.env.LOCALISH_REMOTE_SOCKET;
    else process.env.LOCALISH_REMOTE_SOCKET = originalSocket;
    if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`Local sockets are unavailable in this environment (${error.code}).`);
    return;
  }

  process.env.LOCALISH_REMOTE_SOCKET = socketPath;
  t.after(async () => {
    if (originalSocket === undefined) delete process.env.LOCALISH_REMOTE_SOCKET;
    else process.env.LOCALISH_REMOTE_SOCKET = originalSocket;
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== 'win32') await unlink(socketPath).catch(() => {});
  });

  const response = await requestLocalish({
    method: 'POST',
    path: '/internal/test',
    body: { hello: 'remoteish' },
  });
  assert.deepEqual(response, { method: 'POST', body: { hello: 'remoteish' } });

  const received = [];
  await subscribeToLocalishEvents('session', (task) => received.push(task));
  assert.deepEqual(received, [{ id: 'task-1', operation: { op: 'list' } }]);
});

// Starts a socket server that remoteish may not access, plus a fake `sudo`
// (first on PATH) running the given script body. Returns null when skipped.
async function setupDeniedSocket(t, sudoBehaviour) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    t.skip('Socket file permissions are not available on this platform.');
    return null;
  }
  if (process.getuid() === 0) {
    t.skip('Running as root; cannot simulate a socket permission failure.');
    return null;
  }

  const socketPath = socketName();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`Local sockets are unavailable in this environment (${error.code}).`);
    return null;
  }

  await chmod(socketPath, 0o000);
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'remoteish-sudo-'));
  const markerFile = path.join(binDir, 'sudo-calls');
  const script = `#!/bin/sh\necho "$@" >> ${JSON.stringify(markerFile)}\n${sudoBehaviour}\n`;
  await writeFile(path.join(binDir, 'sudo'), script, { mode: 0o755 });

  const originalSocket = process.env.LOCALISH_REMOTE_SOCKET;
  const originalPath = process.env.PATH;
  process.env.LOCALISH_REMOTE_SOCKET = socketPath;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  t.after(async () => {
    if (originalSocket === undefined) delete process.env.LOCALISH_REMOTE_SOCKET;
    else process.env.LOCALISH_REMOTE_SOCKET = originalSocket;
    process.env.PATH = originalPath;
    await new Promise((resolve) => server.close(resolve));
    await chmod(socketPath, 0o600).catch(() => {});
    await unlink(socketPath).catch(() => {});
    await rm(binDir, { recursive: true, force: true });
  });
  return { socketPath, markerFile };
}

test('remoteish chowns the socket with sudo when permissions deny access', async (t) => {
  // The fake sudo emulates a successful chown by restoring access to the socket.
  const fixture = await setupDeniedSocket(t, 'shift 2\nexec chmod 777 "$1"');
  if (!fixture) return;

  const response = await requestLocalish({ method: 'POST', path: '/internal/test', body: { hello: 'remoteish' } });
  assert.deepEqual(response, { ok: true });

  const calls = (await readFile(fixture.markerFile, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `chown ${process.getuid()}:${process.getgid()} ${fixture.socketPath}`);
});

test('remoteish reports a clear error when sudo chown cannot fix the socket', async (t) => {
  const fixture = await setupDeniedSocket(t, 'exit 1');
  if (!fixture) return;

  await assert.rejects(
    requestLocalish({ method: 'GET', path: '/internal/test' }),
    (error) => {
      assert.match(error.message, /sudo chown/);
      return true;
    },
  );

  const calls = (await readFile(fixture.markerFile, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
});
