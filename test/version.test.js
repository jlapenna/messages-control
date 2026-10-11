import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { versionText } from '../src/version.js';

const pkgDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-v-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  return dir;
};

test('version prints the package version and the short commit', () => {
  const git = (cmd, args) => {
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(2), ['rev-parse', '--short', 'HEAD']);
    return 'c83570c\n';
  };
  assert.equal(versionText(pkgDir(), git), 'messages-control 1.2.3 (c83570c)');
});

test('version omits the commit outside a git checkout', () => {
  const git = () => {
    throw new Error('not a git repository');
  };
  assert.equal(versionText(pkgDir(), git), 'messages-control 1.2.3');
});
