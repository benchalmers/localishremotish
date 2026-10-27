import { spawn } from 'node:child_process';

export function validateBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) {
    throw new Error('A valid URL is required.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The URL must be an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be opened.');
  }
  return url.href;
}

export function openBrowser(value, platform = process.platform) {
  const url = validateBrowserUrl(value);
  let command;
  let args;

  if (platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
