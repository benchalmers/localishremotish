# Architecture

This monorepo contains two Node.js applications that run on different machines and communicate over an SSH reverse-forwarded socket:

- **localish** runs on the Windows desktop. It opens desktop browser tabs, serves the explorer UI, and handles browser-facing HTTP requests.
- **remoteish** runs on the remote Linux host. It issues commands to localish and performs all filesystem operations against the remote working directory.

The filesystem never gets mounted or copied wholesale onto the desktop. For exploration, localish asks remoteish to perform individual operations and returns their results to the browser.

## Repository layout

```text
apps/
  localish/
    src/                 HTTP server, session/RPC manager, browser launcher, Markdown renderer
    public/              Explorer HTML, CSS, and browser-side JavaScript
    test/                Localish and Markdown tests
  remoteish/
    src/                 CLI, socket transport, and confined remote filesystem operations
    test/                Filesystem and socket-transport tests
scripts/
  ssh-forward.ps1        Creates the SSH reverse socket and starts the remote login shell
package.json             npm workspaces and root commands
```

The root npm workspace keeps both applications installable and testable together. The applications communicate through HTTP over the forwarded socket; they do not import each other's code. Localish uses `markdown-it` and `sanitize-html` to render safe Markdown previews, while remoteish uses `ignore` to apply `.gitignore` rules during search.

## Machine and connection topology

```text
Windows desktop                                      Remote Linux host
┌─────────────────────────────┐                     ┌─────────────────────────┐
│ Browser                     │                     │ remoteish CLI           │
│   │ HTTP on loopback         │                     │   │ HTTP client          │
│   ▼                          │                     │   ▼                     │
│ localish :8080 ◀─────────────┼──── SSH tunnel ─────┼── Unix socket           │
│                              │  reverse forward    │  LOCALISH_REMOTE_SOCKET│
└─────────────────────────────┘                     └─────────────────────────┘
```

By default localish listens on `127.0.0.1:8080`, not on a public interface. `scripts/ssh-forward.ps1` runs OpenSSH with a remote stream-local forward equivalent to:

```text
-R /tmp/fwd_….sock:127.0.0.1:8080
```

OpenSSH creates the Unix-domain socket on the **remote** host. `LOCALISH_REMOTE_SOCKET` points remoteish at that socket. When remoteish connects to it, SSH carries the connection back to the Windows SSH client, which connects to localish's loopback HTTP listener. Thus remoteish initiates requests; localish does not need to open a connection to the remote host, and no separate remote TCP port is exposed.

The PowerShell helper first checks localish's `/healthz` endpoint. If it is not healthy, the helper starts the Node.js server hidden in the background and waits up to 30 seconds for it to become ready; stdout/stderr are written under `%LOCALAPPDATA%\localish` (or `%TEMP%\localish`). It then generates a unique socket path, exports it in the remote login shell, and keeps the SSH session attached to that shell. If the remote process receives `EACCES` opening the socket, remoteish attempts one `sudo chown` of the socket to its own UID/GID and retries. This may prompt for the remote account's password.

## `remoteish browser <url>` flow

1. The remote CLI validates that the argument is an absolute HTTP(S) URL.
2. It sends `POST /internal/browser` to localish through `LOCALISH_REMOTE_SOCKET`.
3. Localish validates the URL again and launches it with the desktop's default browser (Windows uses `rundll32.exe`).
4. The CLI prints success and exits; this command does not create a persistent remote session.

## `remoteish explore` flow

`explore` captures the remote process's current working directory as its root, starts a localish session, then stays alive to service browser requests.

```text
remoteish CLI           localish server / SessionManager        Desktop browser
     │                             │                                  │
     ├─ POST /internal/explore ───▶│ create random session ID         │
     │   { remoteRoot }             ├─ open /explore/<session> ──────▶│
     │◀─ { sessionId, url } ────────┤                                  ├─ GET /info
     ├─ GET /internal/sessions/<id>/events (SSE)                       │
     │                             │◀─ GET /list, /read, etc. ─────────┤
     │◀─ SSE task { id, operation }─┤ enqueue operation               │
     ├─ POST /responses { id,result}▶│ resolve matching request         │
     │                             ├─ HTTP result ────────────────────▶│
     │                             │                                  │
     └─ Ctrl+C: POST /close ───────▶│ end session and pending work     │
```

### Browser-to-filesystem RPC

The browser talks only to localish's HTTP API under `/api/explore/<sessionId>/...`. The session ID is a random 24-byte capability encoded as 48 hexadecimal characters. Localish creates an in-memory `SessionManager` entry for it and opens the matching browser URL.

For each browser file request, localish:

1. creates a request ID and queues an operation for that session;
2. sends the operation as a JSON event over the remoteish-initiated Server-Sent Events (SSE) connection;
3. waits for a response posted to `/internal/sessions/<id>/responses` with that request ID; and
4. maps the result or error back to the waiting browser HTTP request.

Remoteish consumes SSE events, runs the requested operation, and posts the correlated response through the same SSH socket. Supported operations are `list`, `read`, `search`, `download`, and `upload`. Pending requests are re-sent if the event stream disconnects; individual RPCs time out after two minutes. SSE heartbeat comments keep an otherwise idle SSH connection alive. The session is closed when the CLI exits normally and expires after prolonged inactivity.

### File operations and transfer format

`apps/remoteish/src/filesystem.js` is the only component that reads or writes remote files. The browser sends paths relative to the captured root; remoteish rejects parent traversal, refuses symlinks and special files, and does not offer navigation above that root.

- **List:** remoteish returns directory/file metadata and whether a file can be previewed.
- **Read:** remoteish returns UTF-8 text for supported text/source/config and Markdown files. Previews are capped at 2 MiB.
- **Search:** remoteish walks the captured root recursively, matching file and directory names plus contents of supported text files. Search is case-insensitive by default; the UI can request case-sensitive matching. Root and nested `.gitignore` rules are applied, including nested negation rules. `.git` metadata, symlinks, and special files are skipped.
- **Upload:** the browser sends raw bytes to localish. Localish encodes them as base64 in the RPC event; remoteish validates the name and path, decodes the bytes, then writes a temporary file and atomically places it in the selected directory. Transfers are capped at 20 MiB. Existing files are not replaced unless the browser UI first confirms and explicitly requests overwrite.
- **Download:** remoteish returns base64 data and metadata over the RPC response. Localish decodes it and streams the original bytes to the browser as an attachment. Downloads share the 20 MiB cap.

### Markdown rendering

Markdown conversion happens on localish after it receives a remote text preview. `apps/localish/src/markdown.js` uses markdown-it with raw HTML disabled and sanitizes the generated HTML before returning it to the browser. The UI inserts only this sanitized result; ordinary text files use `textContent` instead. Markdown headings, lists, tables, quotes, links, and code blocks receive dedicated styles. Embedded remote images are represented by their alt text rather than fetched, avoiding implicit requests from the desktop browser.

## Security and limits

- localish binds to loopback by default, and browser-facing API requests reject cross-site or unexpected-origin requests.
- Explore URLs contain unguessable session capabilities. The reverse socket itself grants access to localish, so the SSH account and desktop user must be trusted.
- Remote paths are confined to the root chosen by `remoteish explore`; parent traversal, symlinks, and special files are blocked.
- File previews are limited to 2 MiB; uploads and downloads are limited to 20 MiB each. Searches read at most 2 MiB per text file and 100 MiB total, inspect at most 20,000 files and 50,000 directories (up to 100 levels deep), and return at most 200 results; the UI reports when results are partial or large/binary content was skipped.
- URL opening is restricted to HTTP and HTTPS. Markdown raw HTML is disabled and the rendered output is sanitized.

## Runtime entry points

- `npm run localish` starts the Windows desktop service.
- `npm run remoteish -- browser https://example.com` opens a URL through the reverse socket.
- `npm run remoteish -- explore` explores the current working directory (the monorepo root when invoked from the monorepo root). For other directories, link the remoteish workspace with `npm link` and run `remoteish explore` from the desired directory.
- `npm test` runs the monorepo tests.
