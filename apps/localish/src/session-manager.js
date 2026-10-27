import { randomBytes, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class SessionManager {
  #sessions = new Map();
  #rpcTimeoutMs;
  #sessionTtlMs;

  constructor({ rpcTimeoutMs = 120_000, sessionTtlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.#rpcTimeoutMs = rpcTimeoutMs;
    this.#sessionTtlMs = sessionTtlMs;
  }

  create(remoteRoot) {
    if (typeof remoteRoot !== 'string' || remoteRoot.length === 0 || remoteRoot.length > 4096) {
      throw new HttpError(400, 'A valid remote root is required.');
    }
    this.pruneExpired();
    if (this.#sessions.size >= 100) throw new HttpError(503, 'Too many active explore sessions.');

    const id = randomBytes(24).toString('hex');
    this.#sessions.set(id, {
      id,
      remoteRoot,
      pending: new Map(),
      stream: null,
      lastActivity: Date.now(),
    });
    return { id, remoteRoot };
  }

  has(id) {
    return this.#sessions.has(id);
  }

  getInfo(id) {
    const session = this.#sessions.get(id);
    if (!session) throw new HttpError(404, 'Explore session not found.');
    session.lastActivity = Date.now();
    return { id: session.id, remoteRoot: session.remoteRoot };
  }

  enqueue(id, operation) {
    const session = this.#sessions.get(id);
    if (!session) return Promise.reject(new HttpError(404, 'Explore session not found.'));

    session.lastActivity = Date.now();
    const requestId = randomUUID();
    const task = { id: requestId, operation };

    return new Promise((resolve, reject) => {
      const record = {
        task,
        resolve,
        reject,
        sent: false,
        timer: setTimeout(() => {
          session.pending.delete(requestId);
          reject(new HttpError(504, 'The remote session did not respond in time.'));
        }, this.#rpcTimeoutMs),
      };
      record.timer.unref?.();
      session.pending.set(requestId, record);
      this.#flush(session);
    });
  }

  attachEventStream(id, response) {
    const session = this.#sessions.get(id);
    if (!session) throw new HttpError(404, 'Explore session not found.');

    session.stream?.end();
    session.stream = response;
    session.lastActivity = Date.now();
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref?.();
    response.on('close', () => {
      clearInterval(heartbeat);
      if (session.stream === response) {
        session.stream = null;
        for (const record of session.pending.values()) record.sent = false;
      }
    });
    this.#flush(session);
  }

  resolveRequest(id, payload) {
    const session = this.#sessions.get(id);
    if (!session) throw new HttpError(404, 'Explore session not found.');
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.ok !== 'boolean') {
      throw new HttpError(400, 'Invalid remote response.');
    }

    const record = session.pending.get(payload.requestId);
    if (!record) return false;
    session.pending.delete(payload.requestId);
    clearTimeout(record.timer);
    session.lastActivity = Date.now();

    if (payload.ok) {
      record.resolve(payload.result);
    } else {
      const status = Number.isInteger(payload.status) && payload.status >= 400 && payload.status <= 599
        ? payload.status
        : 500;
      const message = typeof payload.error === 'string' ? payload.error.slice(0, 500) : 'Remote filesystem operation failed.';
      record.reject(new HttpError(status, message));
    }
    return true;
  }

  close(id) {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    session.stream?.end();
    for (const record of session.pending.values()) {
      clearTimeout(record.timer);
      record.reject(new HttpError(410, 'Explore session was closed.'));
    }
    session.pending.clear();
    return true;
  }

  closeAll() {
    for (const id of this.#sessions.keys()) this.close(id);
  }

  pruneExpired(now = Date.now()) {
    for (const [id, session] of this.#sessions) {
      if (now - session.lastActivity > this.#sessionTtlMs) this.close(id);
    }
  }

  #flush(session) {
    const stream = session.stream;
    if (!stream || stream.destroyed || stream.writableEnded) return;

    for (const record of session.pending.values()) {
      if (record.sent) continue;
      try {
        stream.write(`data: ${JSON.stringify(record.task)}\n\n`);
        record.sent = true;
      } catch {
        session.stream = null;
        record.sent = false;
        return;
      }
    }
  }
}
