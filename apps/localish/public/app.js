const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const sessionId = window.location.pathname.match(/^\/explore\/([a-f0-9]{48})$/u)?.[1] ?? null;
const apiRoot = sessionId ? `/api/explore/${sessionId}` : null;
const elements = {
  rootLabel: document.querySelector('#root-label'),
  status: document.querySelector('#status'),
  breadcrumbs: document.querySelector('#breadcrumbs'),
  refresh: document.querySelector('#refresh-button'),
  up: document.querySelector('#up-button'),
  list: document.querySelector('#file-list'),
  dropZone: document.querySelector('#drop-zone'),
  chooseFiles: document.querySelector('#choose-files-button'),
  fileInput: document.querySelector('#file-input'),
  viewer: document.querySelector('#viewer'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerContent: document.querySelector('#viewer-content'),
  closeViewer: document.querySelector('#close-viewer-button'),
};

const state = { path: '', entries: [], remoteRoot: '' };

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

function joinPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
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
  state.path = path;
  elements.viewer.hidden = true;
  await loadDirectory();
}

async function openTextFile(path) {
  setStatus(`Opening ${path}…`);
  try {
    const result = await expectJson(await fetch(apiUrl('read', `?path=${encodeURIComponent(path)}`)));
    elements.viewerTitle.textContent = result.name;
    elements.viewerContent.textContent = result.text;
    elements.viewer.hidden = false;
    setStatus(`Opened ${path}. Markdown is shown as source text.`, 'success');
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
    await loadDirectory();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function setSessionControls(enabled) {
  elements.refresh.disabled = !enabled;
  elements.chooseFiles.disabled = !enabled;
  elements.fileInput.disabled = !enabled;
}

if (!sessionId) {
  elements.rootLabel.textContent = 'No active remote session';
  elements.list.replaceChildren();
  setStatus('Start `remoteish explore` in the remote directory you want to browse.');
} else {
  setSessionControls(true);
  elements.refresh.addEventListener('click', loadDirectory);
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
