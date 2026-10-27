# remoteish + localish

A small Node.js monorepo for opening remote Linux URLs on a local Windows desktop and browsing/transferring files from a remote working directory.

## Requirements

- Node.js 20.19 or later
- OpenSSH on the Windows desktop and an SSH account on the remote Linux host
- The remote SSH server must permit remote stream-local (Unix-domain socket) forwarding

Runtime dependencies are `markdown-it` and `sanitize-html` for safe Markdown rendering, and `ignore` for `.gitignore`-compatible recursive search.

## Start localish on Windows

From the repository root, install the workspaces once and start the desktop service:

```powershell
npm install
npm run localish
```

By default, localish listens only on `127.0.0.1:8080`. Keep this process running. The browser UI and file service are local-only; the remote host reaches the service through the SSH reverse socket.

## Connect the remote shell

In a second PowerShell window, run:

```powershell
.\scripts\ssh-forward.ps1 user@your-linux-host
```

The helper creates a unique socket under `/tmp` on the remote host, forwards that socket to localish, and exports `LOCALISH_REMOTE_SOCKET` in the remote login shell. If the remote SSH server has stream-local forwarding disabled, its administrator must enable it (for example, `AllowStreamLocalForwarding yes`).

## Use remoteish on Linux

Check out this monorepo on the remote host and install its workspaces once. In the forwarded shell:

```sh
npm install
npm run remoteish -- browser https://example.com
npm run remoteish -- explore
```

`browser` opens the supplied HTTP(S) URL on the Windows desktop. `explore` opens the remote shell's **current working directory** in the desktop browser and keeps a small event stream open while you browse. When invoked via `npm run remoteish` from the monorepo root, that root is the directory being explored. Use Ctrl+C to close the session. Within the page you can navigate into subdirectories and back up to the selected root, recursively search file names and supported text contents (case-insensitive by default, with a case-sensitive option, honoring nested `.gitignore` files), preview common text/source/config files and formatted Markdown, download files, and drag files onto the upload area (20 MiB per transfer). Uploading a name that already exists asks before replacing it.

To run `remoteish` from arbitrary remote directories, install its command once with `npm link` from `apps/remoteish`, then `cd` to the directory you want and run `remoteish explore`. No separate remote port needs to be exposed.

## Configuration

- `LOCALISH_HOST` / `LOCALISH_PORT`: localish bind address and port. If changed, pass the same host/port to `scripts/ssh-forward.ps1`.
- `LOCALISH_REMOTE_SOCKET`: set automatically in the forwarded remote shell by the PowerShell helper. It can also be set manually to the remote Unix socket path.

If remoteish cannot access the forwarded socket because of file permissions (for example, when the socket ends up owned by another user), it runs `sudo chown <uid>:<gid> <socket>` once and retries. `sudo` may prompt for the remote account's password; if the chown fails, the original permission error is reported.

The explorer refuses parent traversal and does not expose symlinks or special files. File previews are limited to 2 MiB; upload/download transfers are limited to 20 MiB. Session URLs use random capabilities and localish binds to loopback by default. Treat the remote account and local desktop user as trusted; the reverse socket grants access to localish while the SSH session is active.

## Development

```sh
npm test
```
