import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const SMALL_RESPONSE_LIMIT = 1024 * 1024;

export class LocalishRequestError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LocalishRequestError';
    this.status = status;
  }
}

function getSocketPath() {
  const socketPath = process.env.LOCALISH_REMOTE_SOCKET;
  if (!socketPath) {
    throw new LocalishRequestError(
      'LOCALISH_REMOTE_SOCKET is not set. Connect through scripts/ssh-forward.ps1 (or configure the SSH reverse socket) first.',
      400,
    );
  }
  return socketPath;
}

export function requestLocalish({
  method = 'GET',
  path,
  body,
  signal,
  timeoutMs = 15_000,
  maxResponseBytes = SMALL_RESPONSE_LIMIT,
} = {}) {
  const socketPath = getSocketPath();
  const bodyBuffer = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = bodyBuffer
    ? { 'content-type': 'application/json; charset=utf-8', 'content-length': bodyBuffer.byteLength }
    : {};

  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path,
      method,
      headers,
      agent: false,
      signal,
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    if (timeoutMs > 0) {
      request.setTimeout(timeoutMs, () => {
        request.destroy(new LocalishRequestError('Timed out waiting for localish.', 504));
      });
    }

    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.byteLength;
        if (size > maxResponseBytes) {
          response.destroy(new LocalishRequestError('Response from localish was too large.', 502));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new LocalishRequestError('Localish closed the response early.', 502)));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          reject(new LocalishRequestError('Localish returned an invalid response.', 502));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new LocalishRequestError(payload.error ?? `Localish returned HTTP ${response.statusCode}.`, response.statusCode));
          return;
        }
        resolve(payload);
      });
    });
    request.on('error', fail);
    if (bodyBuffer) request.write(bodyBuffer);
    request.end();
  });
}

export function subscribeToLocalishEvents(sessionId, onTask, signal) {
  const socketPath = getSocketPath();
  const eventPath = `/internal/sessions/${encodeURIComponent(sessionId)}/events`;

  return new Promise((resolve, reject) => {
    let completed = false;
    let abortHandler;
    const request = http.request({
      socketPath,
      path: eventPath,
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      agent: false,
      signal,
    });

    const finish = (error) => {
      if (completed) return;
      completed = true;
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      if (error) reject(error);
      else resolve();
    };

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let message = `Localish event stream returned HTTP ${response.statusCode}.`;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString('utf8')).error ?? message;
          } catch {
            // Keep the HTTP status message.
          }
          finish(new LocalishRequestError(message, response.statusCode));
        });
        response.on('error', finish);
        response.on('aborted', () => finish(new LocalishRequestError('Localish closed the event response early.', 502)));
        return;
      }

      const decoder = new StringDecoder('utf8');
      let buffer = '';
      const consumeFrames = () => {
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            const task = JSON.parse(data);
            Promise.resolve(onTask(task)).catch((error) => {
              console.error(`Could not handle a localish request: ${error.message}`);
            });
          } catch {
            console.error('Localish sent an invalid event.');
          }
        }
      };

      response.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        consumeFrames();
      });
      response.on('end', () => finish());
      response.on('error', finish);
      response.on('aborted', () => finish(new LocalishRequestError('Localish event stream was interrupted.', 502)));
    });
    request.on('error', (error) => {
      if (signal?.aborted) finish();
      else finish(error);
    });
    request.end();

    abortHandler = () => {
      request.destroy();
      finish();
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
  });
}
