import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
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
