import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalishServer } from '../src/server.js';

async function nextSseEvent(reader, state) {
  for (;;) {
    const boundary = state.buffer.indexOf('\n\n');
    if (boundary !== -1) {
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) return JSON.parse(data);
      continue;
    }
    const { value, done } = await reader.read();
    assert.equal(done, false, 'SSE stream unexpectedly ended');
    state.buffer += new TextDecoder().decode(value, { stream: true });
  }
}

async function reply(baseUrl, sessionId, task, result) {
  const response = await fetch(`${baseUrl}/internal/sessions/${sessionId}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: task.id, ok: true, result }),
  });
  assert.equal(response.status, 202);
}

test('localish opens browser sessions and relays browser filesystem calls to remoteish', async (t) => {
  const opened = [];
  const app = createLocalishServer({
    host: '127.0.0.1',
    port: 0,
    open: async (url) => opened.push(url),
    logger: { error() {} },
    rpcTimeoutMs: 2_000,
  });
  await app.listen();
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let streamController;
  t.after(async () => {
    streamController?.abort();
    await app.close();
  });

  const createResponse = await fetch(`${baseUrl}/internal/explore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ remoteRoot: '/home/alice/project' }),
  });
  assert.equal(createResponse.status, 201);
  const session = await createResponse.json();
  assert.match(session.sessionId, /^[a-f0-9]{48}$/u);
  assert.equal(opened[0], session.url);
  assert.match(session.url, new RegExp(`/explore/${session.sessionId}$`, 'u'));

  const info = await fetch(`${baseUrl}/api/explore/${session.sessionId}/info`).then((response) => response.json());
  assert.equal(info.remoteRoot, '/home/alice/project');

  streamController = new AbortController();
  const eventResponse = await fetch(`${baseUrl}/internal/sessions/${session.sessionId}/events`, {
    signal: streamController.signal,
  });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const sseState = { buffer: '' };

  const listingPromise = fetch(`${baseUrl}/api/explore/${session.sessionId}/list?path=src`);
  const listTask = await nextSseEvent(reader, sseState);
  assert.deepEqual(listTask.operation, { op: 'list', path: 'src' });
  await reply(baseUrl, session.sessionId, listTask, {
    path: 'src',
    entries: [{ name: 'main.js', type: 'file', size: 10, modifiedAt: new Date(0).toISOString(), canOpen: false }],
  });
  const listingResponse = await listingPromise;
  assert.equal(listingResponse.status, 200);
  assert.equal((await listingResponse.json()).entries[0].name, 'main.js');

  const markdownPromise = fetch(`${baseUrl}/api/explore/${session.sessionId}/read?path=README.md`);
  const markdownTask = await nextSseEvent(reader, sseState);
  assert.deepEqual(markdownTask.operation, { op: 'read', path: 'README.md' });
  await reply(baseUrl, session.sessionId, markdownTask, {
    name: 'README.md',
    text: '# Hello\n\n**Formatted** Markdown.\n\n<script>alert(1)</script>',
  });
  const markdownResponse = await markdownPromise;
  assert.equal(markdownResponse.status, 200);
  const markdown = await markdownResponse.json();
  assert.match(markdown.markdownHtml, /<h1>Hello<\/h1>/u);
  assert.match(markdown.markdownHtml, /<strong>Formatted<\/strong>/u);
  assert.doesNotMatch(markdown.markdownHtml, /<script\b/u);

  const searchPromise = fetch(`${baseUrl}/api/explore/${session.sessionId}/search?q=needle&caseSensitive=false`);
  const searchTask = await nextSseEvent(reader, sseState);
  assert.deepEqual(searchTask.operation, { op: 'search', query: 'needle', caseSensitive: false });
  await reply(baseUrl, session.sessionId, searchTask, {
    query: 'needle',
    caseSensitive: false,
    results: [{ path: 'src/guide.md', name: 'guide.md', type: 'file', matches: [{ lineNumber: 3, snippet: 'A needle in context' }] }],
    filesScanned: 10,
    textFilesScanned: 4,
    largeFilesSkipped: 0,
    binaryFilesSkipped: 0,
    bytesScanned: 128,
    truncated: false,
  });
  const searchResponse = await searchPromise;
  assert.equal(searchResponse.status, 200);
  assert.equal((await searchResponse.json()).results[0].matches[0].lineNumber, 3);

  const uploadBytes = Buffer.from([0, 3, 128, 255]);
  const uploadPromise = fetch(`${baseUrl}/api/explore/${session.sessionId}/upload?path=src&name=asset.bin`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: uploadBytes,
  });
  const uploadTask = await nextSseEvent(reader, sseState);
  assert.equal(uploadTask.operation.op, 'upload');
  assert.equal(uploadTask.operation.data, uploadBytes.toString('base64'));
  assert.equal(uploadTask.operation.overwrite, false);
  await reply(baseUrl, session.sessionId, uploadTask, { name: 'asset.bin', size: uploadBytes.length });
  assert.equal((await uploadPromise).status, 201);

  const fileBytes = Buffer.from('download payload');
  const downloadPromise = fetch(`${baseUrl}/api/explore/${session.sessionId}/download?path=src%2Fasset.bin`);
  const downloadTask = await nextSseEvent(reader, sseState);
  assert.deepEqual(downloadTask.operation, { op: 'download', path: 'src/asset.bin' });
  await reply(baseUrl, session.sessionId, downloadTask, {
    name: 'asset.bin',
    mimeType: 'application/octet-stream',
    data: fileBytes.toString('base64'),
  });
  const downloadResponse = await downloadPromise;
  assert.equal(downloadResponse.status, 200);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), fileBytes);

  const openResponse = await fetch(`${baseUrl}/internal/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/docs' }),
  });
  assert.equal(openResponse.status, 200);
  assert.equal(opened[1], 'https://example.com/docs');
  const unsafeUrl = await fetch(`${baseUrl}/internal/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'javascript:alert(1)' }),
  });
  assert.equal(unsafeUrl.status, 400);
  const crossOrigin = await fetch(`${baseUrl}/internal/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ url: 'https://example.org' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(opened.length, 2);

  const closeResponse = await fetch(`${baseUrl}/internal/sessions/${session.sessionId}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(closeResponse.status, 200);
  streamController.abort();
});
