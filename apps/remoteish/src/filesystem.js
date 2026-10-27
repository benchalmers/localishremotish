import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import ignore from 'ignore';
import path from 'node:path';

export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_SEARCH_QUERY_LENGTH = 200;

const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_DIRECTORIES = 50_000;
const MAX_SEARCH_DEPTH = 100;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = MAX_TEXT_BYTES;
const MAX_SEARCH_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES_PER_FILE = 3;
const MAX_SEARCH_SNIPPET_LENGTH = 280;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.mdown', '.mkd', '.log', '.json', '.jsonc', '.csv',
  '.tsv', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat',
  '.cmd', '.conf', '.ini', '.toml', '.sql', '.diff', '.patch', '.rst', '.adoc',
]);
const TEXT_FILENAMES = new Set([
  '.env', '.gitignore', '.gitattributes', '.editorconfig', 'dockerfile', 'makefile',
  'readme', 'license', 'notice', 'changelog', 'authors', 'copying', 'contributing',
]);
const MIME_TYPES = new Map([
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.zip', 'application/zip'],
]);

export class FileOperationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FileOperationError';
    this.status = status;
  }
}

function mapFsError(error) {
  if (error instanceof FileOperationError) return error;

  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FileOperationError(404, 'File or directory not found.');
    case 'EACCES':
    case 'EPERM':
      return new FileOperationError(403, 'Permission denied.');
    case 'EEXIST':
      return new FileOperationError(409, 'A file with that name already exists.');
    case 'ENAMETOOLONG':
      return new FileOperationError(400, 'The file name is too long.');
    case 'EFBIG':
      return new FileOperationError(413, 'The file is too large.');
    default:
      return new FileOperationError(500, 'Filesystem operation failed.');
  }
}

function parseRelativePath(value) {
  if (typeof value !== 'string') {
    throw new FileOperationError(400, 'A relative path is required.');
  }
  if (value === '') return [];
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new FileOperationError(400, 'Invalid relative path.');
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new FileOperationError(400, 'Invalid relative path.');
  }
  return segments;
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function mimeTypeFor(filename) {
  return MIME_TYPES.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream';
}

function isTextFilename(filename) {
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()) || TEXT_FILENAMES.has(path.basename(filename).toLowerCase());
}

function relativeToIgnoreScope(scopeBase, targetPath) {
  if (scopeBase === '') return targetPath;
  if (targetPath === scopeBase) return '';
  return targetPath.startsWith(`${scopeBase}/`) ? targetPath.slice(scopeBase.length + 1) : null;
}

function isGitIgnored(relativePath, isDirectory, scopes) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    const scopedPath = relativeToIgnoreScope(scope.base, relativePath);
    if (scopedPath === null || scopedPath === '') continue;
    const target = isDirectory ? `${scopedPath}/` : scopedPath;
    const result = scope.matcher.checkIgnore(target);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

function findLineMatches(content, query, caseSensitive) {
  const matches = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = content.split(/\r\n?|\n/u);

  for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES_PER_FILE; index += 1) {
    const line = lines[index];
    const searchableLine = caseSensitive ? line : line.toLowerCase();
    const matchAt = searchableLine.indexOf(needle);
    if (matchAt === -1) continue;

    const availableContext = Math.max(0, MAX_SEARCH_SNIPPET_LENGTH - query.length);
    const start = Math.max(0, matchAt - Math.floor(availableContext / 2));
    const end = Math.min(line.length, start + MAX_SEARCH_SNIPPET_LENGTH);
    matches.push({
      lineNumber: index + 1,
      snippet: `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
    });
  }

  return matches;
}

async function readIgnoreScope(directory, base) {
  const filename = path.join(directory, '.gitignore');
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  if (stat.size > MAX_IGNORE_FILE_BYTES) {
    throw new FileOperationError(413, `The .gitignore at ${base || '.'} is too large to process safely.`);
  }

  let text;
  try {
    text = await fs.readFile(filename, 'utf8');
  } catch (error) {
    throw mapFsError(error);
  }

  try {
    const matcher = ignore().add(text.split(/\r\n?|\n/u));
    return { base, matcher };
  } catch {
    throw new FileOperationError(400, `Could not parse the .gitignore at ${base || '.'}.`);
  }
}

async function replaceExistingFile(temporaryPath, target, directory) {
  try {
    await fs.rename(temporaryPath, target);
  } catch (error) {
    if (process.platform !== 'win32' || !['EACCES', 'EEXIST', 'EPERM'].includes(error?.code)) throw error;

    // Windows can reject replacement when another process briefly holds the old
    // destination. Move it aside, then swap in the completed temporary file.
    const backupPath = path.join(directory, `.localish-backup-${randomUUID()}.tmp`);
    try {
      await fs.rename(target, backupPath);
    } catch (backupError) {
      if (backupError?.code === 'ENOENT') {
        await fs.rename(temporaryPath, target);
        return;
      }
      throw error;
    }
    try {
      await fs.rename(temporaryPath, target);
    } catch (replaceError) {
      await fs.rename(backupPath, target).catch(() => {});
      throw replaceError;
    }
    await fs.unlink(backupPath).catch(() => {});
  }
}

function validateFilename(filename) {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    throw new FileOperationError(400, 'Invalid file name.');
  }
  if (Buffer.byteLength(filename, 'utf8') > 240) {
    throw new FileOperationError(400, 'The file name is too long.');
  }
}

export class RemoteFileSystem {
  #root;

  constructor(root) {
    this.#root = root;
  }

  static async open(root = process.cwd()) {
    try {
      const canonicalRoot = await fs.realpath(path.resolve(root));
      const stat = await fs.stat(canonicalRoot);
      if (!stat.isDirectory()) throw new FileOperationError(400, 'The remote root is not a directory.');
      return new RemoteFileSystem(canonicalRoot);
    } catch (error) {
      throw mapFsError(error);
    }
  }

  get root() {
    return this.#root;
  }

  #absolutePath(relativePath) {
    const segments = parseRelativePath(relativePath);
    const target = path.resolve(this.#root, ...segments);
    if (!isWithinRoot(this.#root, target)) {
      throw new FileOperationError(400, 'Path is outside the remote root.');
    }
    return { target, segments };
  }

  async #existingPath(relativePath, expectedType) {
    const { target, segments } = this.#absolutePath(relativePath);
    let current = this.#root;
    let stat = await fs.lstat(this.#root);

    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new FileOperationError(403, 'Symbolic links are not accessible.');
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new FileOperationError(404, 'File or directory not found.');
      }
    }

    const realPath = await fs.realpath(target);
    if (!isWithinRoot(this.#root, realPath)) {
      throw new FileOperationError(403, 'Path is outside the remote root.');
    }
    if (expectedType === 'directory' && !stat.isDirectory()) {
      throw new FileOperationError(400, 'The requested path is not a directory.');
    }
    if (expectedType === 'file' && !stat.isFile()) {
      throw new FileOperationError(400, 'The requested path is not a regular file.');
    }
    return { target, stat };
  }

  async list(relativePath = '') {
    try {
      const { target } = await this.#existingPath(relativePath, 'directory');
      const children = await fs.readdir(target, { withFileTypes: true });
      const entries = await Promise.all(children.map(async (child) => {
        // Backslashes are path separators on Windows; omit names the path validator
        // cannot safely address there. Hide in-progress transfer artifacts, too.
        if (
          child.name.includes('\\') ||
          child.name.startsWith('.localish-upload-') ||
          child.name.startsWith('.localish-backup-')
        ) return null;
        try {
          const childPath = path.join(target, child.name);
          const stat = await fs.lstat(childPath);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return null;
          const type = stat.isDirectory() ? 'directory' : 'file';
          return {
            name: child.name,
            type,
            size: type === 'file' ? stat.size : null,
            modifiedAt: stat.mtime.toISOString(),
            canOpen: type === 'file' && stat.size <= MAX_TEXT_BYTES && isTextFilename(child.name),
          };
        } catch (error) {
          if (error?.code === 'ENOENT') return null;
          throw error;
        }
      }));

      entries.sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      return { path: relativePath, entries: entries.filter(Boolean) };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  async search(query, caseSensitive = false) {
    if (typeof query !== 'string' || typeof caseSensitive !== 'boolean') {
      throw new FileOperationError(400, 'A search query and valid case-sensitivity option are required.');
    }
    const normalizedQuery = query.trim();
    if (
      !normalizedQuery ||
      normalizedQuery.length > MAX_SEARCH_QUERY_LENGTH ||
      normalizedQuery.split('').some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      throw new FileOperationError(400, `Search must contain 1–${MAX_SEARCH_QUERY_LENGTH} printable characters.`);
    }

    const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase();
    const state = {
      results: [],
      filesScanned: 0,
      directoriesScanned: 0,
      textFilesScanned: 0,
      largeFilesSkipped: 0,
      binaryFilesSkipped: 0,
      bytesScanned: 0,
      truncated: false,
    };
    const matchesName = (name) => (caseSensitive ? name : name.toLowerCase()).includes(needle);

    const addResult = (result) => {
      state.results.push(result);
      if (state.results.length >= MAX_SEARCH_RESULTS) state.truncated = true;
    };

    const walk = async (directory, relativeDirectory, inheritedScopes, depth = 0) => {
      if (state.truncated) return;
      if (depth > MAX_SEARCH_DEPTH || state.directoriesScanned >= MAX_SEARCH_DIRECTORIES) {
        state.truncated = true;
        return;
      }
      state.directoriesScanned += 1;
      const directoryIgnore = await readIgnoreScope(directory, relativeDirectory);
      const scopes = directoryIgnore ? [...inheritedScopes, directoryIgnore] : inheritedScopes;
      const children = await fs.readdir(directory, { withFileTypes: true });

      for (const child of children) {
        if (state.truncated) return;
        if (
          child.name === '.git' ||
          child.name.includes('\\') ||
          child.name.startsWith('.localish-upload-') ||
          child.name.startsWith('.localish-backup-')
        ) continue;

        const childPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const absoluteChild = path.join(directory, child.name);
        let stat;
        try {
          stat = await fs.lstat(absoluteChild);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;

        const isDirectory = stat.isDirectory();
        if (isGitIgnored(childPath, isDirectory, scopes)) continue;
        const nameMatch = matchesName(child.name);

        if (isDirectory) {
          if (nameMatch) {
            addResult({
              path: childPath,
              name: child.name,
              type: 'directory',
              size: null,
              modifiedAt: stat.mtime.toISOString(),
              canOpen: false,
              nameMatch: true,
              matches: [],
            });
          }
          if (!state.truncated) await walk(absoluteChild, childPath, scopes, depth + 1);
          continue;
        }

        if (state.filesScanned >= MAX_SEARCH_FILES) {
          state.truncated = true;
          return;
        }
        state.filesScanned += 1;

        let lineMatches = [];
        if (isTextFilename(child.name)) {
          if (stat.size > MAX_SEARCH_FILE_BYTES) {
            state.largeFilesSkipped += 1;
          } else if (state.bytesScanned + stat.size > MAX_SEARCH_TOTAL_BYTES) {
            state.truncated = true;
            return;
          } else {
            let content;
            try {
              content = await fs.readFile(absoluteChild);
            } catch (error) {
              if (error?.code === 'ENOENT') continue;
              throw error;
            }
            if (content.byteLength > MAX_SEARCH_FILE_BYTES) {
              state.largeFilesSkipped += 1;
            } else if (state.bytesScanned + content.byteLength > MAX_SEARCH_TOTAL_BYTES) {
              state.truncated = true;
              return;
            } else {
              state.bytesScanned += content.byteLength;
              if (content.includes(0)) {
                state.binaryFilesSkipped += 1;
              } else {
                state.textFilesScanned += 1;
                lineMatches = findLineMatches(content.toString('utf8'), normalizedQuery, caseSensitive);
              }
            }
          }
        }

        if (nameMatch || lineMatches.length > 0) {
          addResult({
            path: childPath,
            name: child.name,
            type: 'file',
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            canOpen: stat.size <= MAX_TEXT_BYTES && isTextFilename(child.name),
            nameMatch,
            matches: lineMatches,
          });
        }
      }
    };

    try {
      await walk(this.#root, '', []);
      state.results.sort((left, right) => left.path.localeCompare(right.path));
      return { query: normalizedQuery, caseSensitive, ...state };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  async readText(relativePath) {
    try {
      const { target, stat } = await this.#existingPath(relativePath, 'file');
      if (!isTextFilename(path.basename(target))) {
        throw new FileOperationError(415, 'Only text and Markdown files can be opened.');
      }
      if (stat.size > MAX_TEXT_BYTES) {
        throw new FileOperationError(413, 'Text files larger than 2 MiB cannot be previewed.');
      }
      const content = await fs.readFile(target);
      if (content.byteLength > MAX_TEXT_BYTES) {
        throw new FileOperationError(413, 'Text files larger than 2 MiB cannot be previewed.');
      }
      return { name: path.basename(target), text: content.toString('utf8') };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  async download(relativePath) {
    try {
      const { target, stat } = await this.#existingPath(relativePath, 'file');
      if (stat.size > MAX_TRANSFER_BYTES) {
        throw new FileOperationError(413, 'Files larger than 20 MiB cannot be transferred.');
      }
      const content = await fs.readFile(target);
      if (content.byteLength > MAX_TRANSFER_BYTES) {
        throw new FileOperationError(413, 'Files larger than 20 MiB cannot be transferred.');
      }
      const name = path.basename(target);
      return {
        name,
        size: content.byteLength,
        mimeType: mimeTypeFor(name),
        data: content.toString('base64'),
      };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  async upload(relativeDirectory, filename, encodedData, overwrite = false) {
    validateFilename(filename);
    if (typeof encodedData !== 'string' || encodedData.length > Math.ceil(MAX_TRANSFER_BYTES / 3) * 4) {
      throw new FileOperationError(413, 'The uploaded file is too large.');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedData)) {
      throw new FileOperationError(400, 'Invalid file data.');
    }
    const content = Buffer.from(encodedData, 'base64');
    if (content.byteLength > MAX_TRANSFER_BYTES) {
      throw new FileOperationError(413, 'The uploaded file is too large.');
    }

    let temporaryPath;
    try {
      const { target: directory } = await this.#existingPath(relativeDirectory, 'directory');
      const target = path.join(directory, filename);
      let existing;
      try {
        existing = await fs.lstat(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (existing?.isSymbolicLink()) {
        throw new FileOperationError(403, 'Symbolic links cannot be overwritten.');
      }
      if (existing && !existing.isFile()) {
        throw new FileOperationError(409, 'A non-file item already uses that name.');
      }
      if (existing && !overwrite) {
        throw new FileOperationError(409, 'A file with that name already exists.');
      }

      temporaryPath = path.join(directory, `.localish-upload-${randomUUID()}.tmp`);
      await fs.writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
      if (overwrite) {
        await replaceExistingFile(temporaryPath, target, directory);
      } else {
        // link() gives the create-if-absent behavior of O_EXCL without exposing a
        // partially-written destination file to readers.
        await fs.link(temporaryPath, target);
        await fs.unlink(temporaryPath);
      }
      return { name: filename, size: content.byteLength };
    } catch (error) {
      throw mapFsError(error);
    } finally {
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
    }
  }
}
