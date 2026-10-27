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

test('recursive search is case-insensitive by default and honors root/nested .gitignore rules', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remoteish-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'nested', 'sub'), { recursive: true });
  await mkdir(path.join(root, 'ignored-dir'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.gitignore'), 'ignored-dir/\n*.log\nsrc/ignored.txt\n');
  await writeFile(path.join(root, 'src', '.gitignore'), 'ignored-local.txt\n!keep.log\n');
  await writeFile(path.join(root, 'src', 'nested', '.gitignore'), 'hidden.md\n');
  await writeFile(path.join(root, 'src', 'CaseFile.TXT'), 'Needle appears here.\nSecond needle line.\n');
  await writeFile(path.join(root, 'src', 'CaseSensitive.txt'), 'Needle only uppercase.\n');
  await writeFile(path.join(root, 'src', 'needle-name.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'src', 'keep.log'), 'Needle in a file re-included by the nested ignore file.\n');
  await writeFile(path.join(root, 'src', 'ignored-local.txt'), 'needle in ignored local file');
  await writeFile(path.join(root, 'src', 'ignored.txt'), 'needle in root-ignored file');
  await writeFile(path.join(root, 'src', 'nested', 'hidden.md'), 'needle in nested ignored file');
  await writeFile(path.join(root, 'src', 'nested', 'visible.md'), 'Needle in visible nested file');
  await writeFile(path.join(root, 'src', 'nested', 'sub', 'hidden.md'), 'needle in deeply ignored file');
  await writeFile(path.join(root, 'ignored-dir', 'ignored.txt'), 'needle in ignored directory');
  await writeFile(path.join(root, '.git', 'secret.txt'), 'needle in git metadata');

  const remote = await RemoteFileSystem.open(root);
  const results = await remote.search('NEEDLE');
  const byPath = new Map(results.results.map((result) => [result.path, result]));
  assert.deepEqual([...byPath.keys()].sort(), [
    'src/CaseFile.TXT',
    'src/CaseSensitive.txt',
    'src/keep.log',
    'src/needle-name.bin',
    'src/nested/visible.md',
  ]);
  assert.equal(byPath.get('src/CaseFile.TXT').matches[0].lineNumber, 1);
  assert.equal(byPath.get('src/needle-name.bin').nameMatch, true);
  assert.equal(results.largeFilesSkipped, 0);
  assert.equal(results.truncated, false);

  const caseSensitiveResults = await remote.search('needle', true);
  assert.deepEqual(caseSensitiveResults.results.map((result) => result.path), ['src/CaseFile.TXT', 'src/needle-name.bin']);
  await assert.rejects(remote.search('   '), (error) => error.status === 400);
  await assert.rejects(remote.search('x'.repeat(201)), (error) => error.status === 400);
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
