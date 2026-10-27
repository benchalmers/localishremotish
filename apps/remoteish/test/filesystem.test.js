import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RemoteFileSystem } from '../src/filesystem.js';

test('remote filesystem lists, previews, downloads, and uploads within its root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remoteish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'README.md'), '# Hello\n');
  await writeFile(path.join(root, 'notes', 'plain.txt'), 'plain text');
  await writeFile(path.join(root, 'notes', 'blob.bin'), Buffer.from([0, 1, 255]));

  const remote = await RemoteFileSystem.open(root);
  const listing = await remote.list('');
  assert.deepEqual(listing.entries.map(({ name, type }) => [name, type]), [
    ['notes', 'directory'],
    ['README.md', 'file'],
  ]);
  assert.equal(listing.entries[1].canOpen, true);
  assert.equal((await remote.list('notes')).entries.length, 2);
  assert.equal((await remote.readText('README.md')).text, '# Hello\n');

  const bytes = Buffer.from([0, 1, 255]);
  assert.equal((await remote.download('notes/blob.bin')).data, bytes.toString('base64'));
  await assert.rejects(remote.readText('notes/blob.bin'), (error) => error.status === 415);
  await assert.rejects(remote.list('../'), (error) => error.status === 400);
  await assert.rejects(remote.download('notes/../../README.md'), (error) => error.status === 400);

  const uploadedBytes = Buffer.from('uploaded over the tunnel');
  const uploaded = await remote.upload('notes', 'new.txt', uploadedBytes.toString('base64'));
  assert.equal(uploaded.name, 'new.txt');
  assert.deepEqual(await readFile(path.join(root, 'notes', 'new.txt')), uploadedBytes);
  await assert.rejects(
    remote.upload('notes', 'new.txt', Buffer.from('replacement').toString('base64')),
    (error) => error.status === 409,
  );
  await remote.upload('notes', 'new.txt', Buffer.from('replacement').toString('base64'), true);
  assert.equal(await readFile(path.join(root, 'notes', 'new.txt'), 'utf8'), 'replacement');
  await assert.rejects(
    remote.upload('../', 'outside.txt', Buffer.from('no').toString('base64')),
    (error) => error.status === 400,
  );
});

test('remote filesystem omits and refuses symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remoteish-links-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'remoteish-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(outside, 'secret.txt'), 'secret');

  try {
    await symlink(outside, path.join(root, 'outside'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Symlinks unavailable in this environment (${error.code}).`);
      return;
    }
    throw error;
  }

  const remote = await RemoteFileSystem.open(root);
  assert.deepEqual((await remote.list('')).entries, []);
  await assert.rejects(remote.list('outside'), (error) => error.status === 403);
  await assert.rejects(remote.readText('outside/secret.txt'), (error) => error.status === 403);
});
