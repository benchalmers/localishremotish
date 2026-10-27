import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBrowserUrl } from '../src/browser.js';

test('desktop browser URLs are restricted to HTTP(S)', () => {
  assert.equal(validateBrowserUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(validateBrowserUrl('http://localhost:3000/'), 'http://localhost:3000/');
  assert.throws(() => validateBrowserUrl('javascript:alert(1)'), /HTTP and HTTPS/u);
  assert.throws(() => validateBrowserUrl('not a URL'), /absolute HTTP or HTTPS/u);
});
