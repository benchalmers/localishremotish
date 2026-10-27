import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, validateBrowserUrl } from './browser.js';
import { renderMarkdown } from './markdown.js';
import { HttpError, SessionManager } from './session-manager.js';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = path.resolve(MODULE_DIRECTORY, '../public');
// Keep the HTTP and RPC caps in sync with remoteish/src/filesystem.js.
const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
const JSON_BODY_LIMIT = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4 + 1024 * 1024;
const STATIC_FILES = new Map([
  ['/app.js', { filename: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { filename: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function setSecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-frame-options', 'DENY');
}

async function readBody(request, maxBytes) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.resume();
    throw new HttpError(413, 'Request body is too large.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, maxBytes = 64 * 1024) {
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function sessionRoute(pathname, action) {
  const match = pathname.match(/^\/api\/explore\/([a-f0-9]{48})\/([a-z]+)$/u);
  return match && match[2] === action ? match[1] : null;
}

function internalSessionRoute(pathname, action) {
  const match = pathname.match(/^\/internal\/sessions\/([a-f0-9]{48})\/([a-z]+)$/u);
  return match && match[2] === action ? match[1] : null;
}

function safeDispositionFilename(filename) {
  return encodeURIComponent(filename).replaceAll("'", '%27').replaceAll('(', '%28').replaceAll(')', '%29').replaceAll('*', '%2A');
}

function jsonErrorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
}

function assertBrowserOrigin(request, server, configuredPort) {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : configuredPort;
  const allowedOrigins = new Set([
    new URL(`http://127.0.0.1:${port}`).origin,
    new URL(`http://localhost:${port}`).origin,
  ]);
  let normalizedOrigin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new HttpError(403, 'Invalid request origin.');
  }
  if (!allowedOrigins.has(normalizedOrigin)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
}

export function createLocalishServer({
  host = process.env.LOCALISH_HOST ?? '127.0.0.1',
  port = Number(process.env.LOCALISH_PORT ?? 8080),
  open = openBrowser,
  logger = console,
  rpcTimeoutMs = 120_000,
} = {}) {
  const sessions = new SessionManager({ rpcTimeoutMs });
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localish.invalid');
    const pathname = url.pathname;

    try {
      if (method === 'GET' && (pathname === '/' || /^\/explore\/[a-f0-9]{48}$/u.test(pathname))) {
        const html = await readFile(path.join(PUBLIC_DIRECTORY, 'index.html'));
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.byteLength,
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(html);
        return;
      }

      const staticFile = STATIC_FILES.get(pathname);
      if (method === 'GET' && staticFile) {
        const content = await readFile(path.join(PUBLIC_DIRECTORY, staticFile.filename));
        response.writeHead(200, {
          'content-type': staticFile.contentType,
          'content-length': content.byteLength,
          'cache-control': 'no-store',
        });
        response.end(content);
        return;
      }

      if (pathname.startsWith('/internal/') || pathname.startsWith('/api/')) {
        assertBrowserOrigin(request, server, port);
      }

      if (method === 'POST' && pathname === '/internal/browser') {
        const body = await readJson(request);
        let browserUrl;
        try {
          browserUrl = validateBrowserUrl(body?.url);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        await open(browserUrl);
        sendJson(response, 200, { opened: true, url: browserUrl });
        return;
      }

      if (method === 'POST' && pathname === '/internal/explore') {
        const body = await readJson(request);
        const session = sessions.create(body?.remoteRoot);
        const address = server.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        const browserUrl = `http://127.0.0.1:${actualPort}/explore/${session.id}`;
        try {
          await open(browserUrl);
        } catch (error) {
          sessions.close(session.id);
          throw new HttpError(502, `Could not open the desktop browser: ${error.message}`);
        }
        sendJson(response, 201, { sessionId: session.id, url: browserUrl });
        return;
      }

      const eventSession = method === 'GET' ? internalSessionRoute(pathname, 'events') : null;
      if (eventSession) {
        sessions.attachEventStream(eventSession, response);
        return;
      }

      const responseSession = method === 'POST' ? internalSessionRoute(pathname, 'responses') : null;
      if (responseSession) {
        const body = await readJson(request, JSON_BODY_LIMIT);
        const accepted = sessions.resolveRequest(responseSession, body);
        sendJson(response, accepted ? 202 : 404, accepted ? { accepted: true } : { error: 'Request is no longer pending.' });
        return;
      }

      const closeSession = method === 'POST' ? internalSessionRoute(pathname, 'close') : null;
      if (closeSession) {
        const closed = sessions.close(closeSession);
        sendJson(response, closed ? 200 : 404, closed ? { closed: true } : { error: 'Explore session not found.' });
        return;
      }

      const infoSession = method === 'GET' ? sessionRoute(pathname, 'info') : null;
      if (infoSession) {
        sendJson(response, 200, sessions.getInfo(infoSession));
        return;
      }

      const listSession = method === 'GET' ? sessionRoute(pathname, 'list') : null;
      if (listSession) {
        const result = await sessions.enqueue(listSession, { op: 'list', path: url.searchParams.get('path') ?? '' });
        sendJson(response, 200, result);
        return;
      }

      const readSession = method === 'GET' ? sessionRoute(pathname, 'read') : null;
      if (readSession) {
        const result = await sessions.enqueue(readSession, { op: 'read', path: url.searchParams.get('path') ?? '' });
        const isMarkdown = /\.(?:md|markdown|mdown|mkd)$/iu.test(result.name);
        sendJson(response, 200, {
          ...result,
          ...(isMarkdown ? { markdownHtml: renderMarkdown(result.text) } : {}),
        });
        return;
      }

      const downloadSession = method === 'GET' ? sessionRoute(pathname, 'download') : null;
      if (downloadSession) {
        const result = await sessions.enqueue(downloadSession, { op: 'download', path: url.searchParams.get('path') ?? '' });
        const content = Buffer.from(result.data, 'base64');
        response.writeHead(200, {
          'content-type': result.mimeType ?? 'application/octet-stream',
          'content-length': content.byteLength,
          'content-disposition': `attachment; filename*=UTF-8''${safeDispositionFilename(result.name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(content);
        return;
      }

      const uploadSession = method === 'POST' ? sessionRoute(pathname, 'upload') : null;
      if (uploadSession) {
        const filename = url.searchParams.get('name');
        const directory = url.searchParams.get('path') ?? '';
        if (typeof filename !== 'string' || filename.length === 0) throw new HttpError(400, 'A file name is required.');
        const content = await readBody(request, MAX_TRANSFER_BYTES);
        const overwrite = request.headers['x-overwrite'] === 'true';
        const result = await sessions.enqueue(uploadSession, {
          op: 'upload',
          path: directory,
          name: filename,
          data: content.toString('base64'),
          overwrite,
        });
        sendJson(response, 201, result);
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = jsonErrorStatus(error);
      if (status >= 500) logger.error?.(`Localish request failed: ${error.message}`);
      sendJson(response, status, { error: error.message ?? 'Internal server error.' });
    }
  });

  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  const cleanup = setInterval(() => sessions.pruneExpired(), 60 * 1000);
  cleanup.unref?.();

  return {
    server,
    sessions,
    async listen() {
      if (server.listening) return server.address();
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async close() {
      clearInterval(cleanup);
      sessions.closeAll();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
