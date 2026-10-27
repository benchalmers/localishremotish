#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { RemoteFileSystem, FileOperationError } from './filesystem.js';
import { LocalishRequestError, requestLocalish, subscribeToLocalishEvents } from './transport.js';

function usage() {
  console.log(`Usage:
  remoteish browser <url>   Open an HTTP(S) URL in the local desktop browser
  remoteish explore         Browse this remote working directory in the local browser

LOCALISH_REMOTE_SOCKET must be set (the SSH helper sets it for you).`);
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Please provide an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be opened.');
  }
  return url.href;
}

async function browserCommand(value) {
  const url = parseHttpUrl(value);
  await requestLocalish({ method: 'POST', path: '/internal/browser', body: { url } });
  console.log(`Opened ${url} on the local desktop.`);
}

async function handleRemoteTask(sessionId, fileSystem, task) {
  if (!task || typeof task.id !== 'string' || !task.operation || typeof task.operation !== 'object') return;

  let result;
  try {
    const { op, path, name, data, overwrite } = task.operation;
    switch (op) {
      case 'list':
        result = await fileSystem.list(path ?? '');
        break;
      case 'read':
        result = await fileSystem.readText(path);
        break;
      case 'search':
        result = await fileSystem.search(task.operation.query, task.operation.caseSensitive === true);
        break;
      case 'download':
        result = await fileSystem.download(path);
        break;
      case 'upload':
        result = await fileSystem.upload(path ?? '', name, data, overwrite === true);
        break;
      default:
        throw new FileOperationError(400, 'Unknown remote filesystem operation.');
    }
    await requestLocalish({
      method: 'POST',
      path: `/internal/sessions/${encodeURIComponent(sessionId)}/responses`,
      body: { requestId: task.id, ok: true, result },
      timeoutMs: 30_000,
    });
  } catch (error) {
    try {
      await requestLocalish({
        method: 'POST',
        path: `/internal/sessions/${encodeURIComponent(sessionId)}/responses`,
        body: {
          requestId: task.id,
          ok: false,
          status: Number.isInteger(error?.status) ? error.status : 500,
          error: error?.message ?? 'Remote filesystem operation failed.',
        },
        timeoutMs: 30_000,
      });
    } catch (replyError) {
      console.error(`Could not return a result to localish: ${replyError.message}`);
    }
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function exploreCommand() {
  const fileSystem = await RemoteFileSystem.open(process.cwd());
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let sessionId;
  try {
    const session = await requestLocalish({
      method: 'POST',
      path: '/internal/explore',
      body: { remoteRoot: fileSystem.root },
      signal: controller.signal,
    });
    sessionId = session.sessionId;
    console.log(`Exploring ${fileSystem.root}`);
    console.log('The browser is open on the local desktop. Press Ctrl+C to end this session.');

    while (!controller.signal.aborted) {
      try {
        await subscribeToLocalishEvents(
          sessionId,
          (task) => handleRemoteTask(sessionId, fileSystem, task),
          controller.signal,
        );
        if (!controller.signal.aborted) console.warn('Localish event stream ended; reconnecting...');
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(`Lost the localish connection: ${error.message}`);
      }
      await delay(1000, controller.signal);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (sessionId) {
      await requestLocalish({
        method: 'POST',
        path: `/internal/sessions/${encodeURIComponent(sessionId)}/close`,
        body: {},
        timeoutMs: 2_000,
      }).catch(() => {});
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (command === 'browser' && args.length === 1) {
    await browserCommand(args[0]);
    return;
  }
  if (command === 'explore' && args.length === 0) {
    await exploreCommand();
    return;
  }
  usage();
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const prefix = error instanceof LocalishRequestError ? 'Could not reach localish' : 'remoteish failed';
    console.error(`${prefix}: ${error.message}`);
    process.exitCode = 1;
  });
}
