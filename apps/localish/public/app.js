const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const sessionId = window.location.pathname.match(/^\/explore\/([a-f0-9]{48})$/u)?.[1] ?? null;
const apiRoot = sessionId ? `/api/explore/${sessionId}` : null;
const elements = {
  rootLabel: document.querySelector('#root-label'),
  status: document.querySelector('#status'),
  breadcrumbs: document.querySelector('#breadcrumbs'),
  refresh: document.querySelector('#refresh-button'),
  up: document.querySelector('#up-button'),
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#search-input'),
  searchButton: document.querySelector('#search-button'),
  clearSearch: document.querySelector('#clear-search-button'),
  caseSensitive: document.querySelector('#case-sensitive'),
  list: document.querySelector('#file-list'),
  dropZone: document.querySelector('#drop-zone'),
  chooseFiles: document.querySelector('#choose-files-button'),
  fileInput: document.querySelector('#file-input'),
  viewer: document.querySelector('#viewer'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerContent: document.querySelector('#viewer-content'),
  closeViewer: document.querySelector('#close-viewer-button'),
};

const state = { path: '', entries: [], remoteRoot: '', search: null };
let searchGeneration = 0;

function setStatus(message, kind = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

async function expectJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

function apiUrl(action, query = '') {
  return `${apiRoot}/${action}${query}`;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'Folder';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function makeButton(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  elements.breadcrumbs.hidden = false;
  const segments = state.path ? state.path.split('/') : [];
  const root = makeButton(state.remoteRoot || 'Remote root', 'breadcrumb', () => navigate(''));
  elements.breadcrumbs.append(root);

  let accumulated = '';
  segments.forEach((segment) => {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.textContent = '/';
    elements.breadcrumbs.append(separator);
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    elements.breadcrumbs.append(makeButton(segment, 'breadcrumb', () => navigate(accumulated)));
  });

  elements.up.hidden = !state.path;
  elements.up.disabled = !apiRoot;
}

function renderEntries() {
  if (state.search) {
    renderSearchResults();
    return;
  }
  elements.list.replaceChildren();
  if (state.entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.textContent = 'This directory is empty.';
    elements.list.append(empty);
    return;
  }

  for (const entry of state.entries) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const main = document.createElement('div');
    main.className = 'file-main';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = entry.type === 'directory' ? '▰' : '▤';
    const detail = document.createElement('div');
    detail.className = 'file-detail';

    if (entry.type === 'directory') {
      detail.append(makeButton(entry.name, 'file-name directory', () => navigate(joinPath(state.path, entry.name))));
    } else {
      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = entry.name;
      detail.append(name);
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const modified = new Date(entry.modifiedAt);
    meta.textContent = `${formatBytes(entry.size)} · ${Number.isNaN(modified.valueOf()) ? '' : modified.toLocaleString()}`;
    detail.append(meta);
    main.append(icon, detail);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (entry.type === 'file' && entry.canOpen) {
      actions.append(makeButton('Open', 'file-action', () => openTextFile(joinPath(state.path, entry.name))));
    }
    if (entry.type === 'file') {
      actions.append(makeButton('Download', 'file-action', () => downloadFile(joinPath(state.path, entry.name), entry.name)));
    }
    row.append(main, actions);
    elements.list.append(row);
  }
}

function renderSearchResults() {
  elements.list.replaceChildren();
  if (state.search.results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.textContent = `No matches found for “${state.search.query}”.`;
    elements.list.append(empty);
    return;
  }

  for (const result of state.search.results) {
    const row = document.createElement('div');
    row.className = 'file-row search-result-row';
    const main = document.createElement('div');
    main.className = 'file-main';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = result.type === 'directory' ? '▰' : '▤';

    const detail = document.createElement('div');
    detail.className = 'file-detail';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = result.path;
    detail.append(name);

    if (result.nameMatch) {
      const nameMatch = document.createElement('div');
      nameMatch.className = 'search-match-label';
      nameMatch.textContent = 'File name match';
      detail.append(nameMatch);
    }
    for (const match of result.matches) {
      const matchRow = document.createElement('div');
      matchRow.className = 'search-match';
      const line = document.createElement('span');
      line.className = 'search-line-number';
      line.textContent = `Line ${match.lineNumber}`;
      const snippet = document.createElement('span');
      snippet.className = 'search-snippet';
      snippet.textContent = match.snippet;
      matchRow.append(line, snippet);
      detail.append(matchRow);
    }
    main.append(icon, detail);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (result.type === 'directory') {
      actions.append(makeButton('Open folder', 'file-action', () => navigate(result.path)));
    } else {
      if (result.canOpen) {
        actions.append(makeButton('Open', 'file-action', () => openTextFile(result.path)));
      }
      actions.append(makeButton('Download', 'file-action', () => downloadFile(result.path, result.name)));
    }
    row.append(main, actions);
    elements.list.append(row);
  }
}

function joinPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

async function clearSearch() {
  searchGeneration += 1;
  state.search = null;
  elements.searchInput.value = '';
  elements.searchButton.disabled = !apiRoot;
  await loadDirectory();
}

async function runSearch(event) {
  event?.preventDefault();
  if (!apiRoot) return;
  const query = elements.searchInput.value.trim();
  if (!query) {
    await clearSearch();
    setStatus('Enter a name or text fragment to search.', 'error');
    elements.searchInput.focus();
    return;
  }

  const generation = ++searchGeneration;
  const caseSensitive = elements.caseSensitive.checked;
  elements.searchButton.disabled = true;
  elements.viewer.hidden = true;
  setStatus(`Searching recursively for “${query}”…`);
  try {
    const searchQuery = `?q=${encodeURIComponent(query)}&caseSensitive=${caseSensitive}`;
    const result = await expectJson(await fetch(apiUrl('search', searchQuery)));
    if (generation !== searchGeneration) return;
    state.search = result;
    renderEntries();

    const matchCount = result.results.length;
    const summary = [`${matchCount} matching item${matchCount === 1 ? '' : 's'} for “${result.query}”`];
    summary.push(result.caseSensitive ? 'case-sensitive' : 'case-insensitive');
    if (result.truncated) summary.push('results are partial; narrow your search');
    if (result.largeFilesSkipped) summary.push(`${result.largeFilesSkipped} large text file(s) skipped`);
    if (result.binaryFilesSkipped) summary.push(`${result.binaryFilesSkipped} binary file(s) skipped`);
    setStatus(`${summary.join(' · ')}.`, matchCount ? 'success' : 'info');
  } catch (error) {
    if (generation === searchGeneration) setStatus(error.message, 'error');
  } finally {
    if (generation === searchGeneration) elements.searchButton.disabled = false;
  }
}

async function loadDirectory() {
  if (!apiRoot) return;
  setStatus(`Loading ${state.path || 'the remote root'}…`);
  try {
    const query = `?path=${encodeURIComponent(state.path)}`;
    const result = await expectJson(await fetch(apiUrl('list', query)));
    state.entries = result.entries;
    renderBreadcrumbs();
    renderEntries();
    setStatus(`${state.entries.length} item${state.entries.length === 1 ? '' : 's'} in ${state.path || 'the remote root'}.`);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function navigate(path) {
  searchGeneration += 1;
  state.search = null;
  elements.searchInput.value = '';
  elements.searchButton.disabled = !apiRoot;
  state.path = path;
  elements.viewer.hidden = true;
  await loadDirectory();
}

async function openTextFile(path) {
  setStatus(`Opening ${path}…`);
  try {
    const result = await expectJson(await fetch(apiUrl('read', `?path=${encodeURIComponent(path)}`)));
    elements.viewerTitle.textContent = result.name;
    elements.viewerContent.replaceChildren();
    if (typeof result.markdownHtml === 'string') {
      elements.viewerContent.classList.add('markdown-body');
      elements.viewerContent.innerHTML = result.markdownHtml;
      setStatus(`Opened ${path} as formatted Markdown.`, 'success');
    } else {
      elements.viewerContent.classList.remove('markdown-body');
      const text = document.createElement('pre');
      text.className = 'plain-text';
      text.textContent = result.text;
      elements.viewerContent.append(text);
      setStatus(`Opened ${path}.`, 'success');
    }
    elements.viewer.hidden = false;
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function downloadFile(path, filename) {
  setStatus(`Downloading ${filename}…`);
  try {
    const response = await fetch(apiUrl('download', `?path=${encodeURIComponent(path)}`));
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error ?? `Download failed (${response.status}).`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    setStatus(`Downloaded ${filename}.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function uploadFile(file) {
  if (!apiRoot || !file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus(`${file.name} is larger than the 20 MiB transfer limit.`, 'error');
    return;
  }
  const alreadyExists = state.entries.some((entry) => entry.name === file.name);
  const overwrite = alreadyExists && window.confirm(`“${file.name}” already exists. Replace it?`);
  if (alreadyExists && !overwrite) {
    setStatus(`Skipped ${file.name}; the existing file was kept.`);
    return;
  }

  setStatus(`Uploading ${file.name}…`);
  try {
    const query = `?path=${encodeURIComponent(state.path)}&name=${encodeURIComponent(file.name)}`;
    const response = await fetch(apiUrl('upload', query), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-overwrite': String(overwrite) },
      body: file,
    });
    await expectJson(response);
    setStatus(`Uploaded ${file.name}.`, 'success');
    if (state.search) await runSearch();
    else await loadDirectory();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function setSessionControls(enabled) {
  elements.refresh.disabled = !enabled;
  elements.searchInput.disabled = !enabled;
  elements.searchButton.disabled = !enabled;
  elements.clearSearch.disabled = !enabled;
  elements.caseSensitive.disabled = !enabled;
  elements.chooseFiles.disabled = !enabled;
  elements.fileInput.disabled = !enabled;
}

if (!sessionId) {
  elements.rootLabel.textContent = 'No active remote session';
  elements.list.replaceChildren();
  setStatus('Start `remoteish explore` in the remote directory you want to browse.');
} else {
  setSessionControls(true);
  elements.refresh.addEventListener('click', () => state.search ? runSearch() : loadDirectory());
  elements.searchForm.addEventListener('submit', runSearch);
  elements.clearSearch.addEventListener('click', () => clearSearch());
  elements.up.addEventListener('click', () => {
    const segments = state.path.split('/').filter(Boolean);
    segments.pop();
    navigate(segments.join('/'));
  });
  elements.closeViewer.addEventListener('click', () => { elements.viewer.hidden = true; });
  elements.chooseFiles.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', async () => {
    for (const file of elements.fileInput.files ?? []) await uploadFile(file);
    elements.fileInput.value = '';
  });
  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragging');
  });
  elements.dropZone.addEventListener('dragleave', (event) => {
    if (!elements.dropZone.contains(event.relatedTarget)) elements.dropZone.classList.remove('dragging');
  });
  elements.dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragging');
    for (const file of event.dataTransfer?.files ?? []) await uploadFile(file);
  });

  fetch(apiUrl('info'))
    .then(expectJson)
    .then(async (info) => {
      state.remoteRoot = info.remoteRoot;
      elements.rootLabel.textContent = info.remoteRoot;
      await loadDirectory();
    })
    .catch((error) => {
      setStatus(error.message, 'error');
      elements.rootLabel.textContent = 'Remote session unavailable';
    });
}
