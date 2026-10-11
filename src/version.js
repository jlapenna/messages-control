import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// "messages-control 0.2.0 (c83570c)"; the commit is left out when the
// package is not running from a git checkout.
export function versionText(root, git = execFileSync) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let commit = '';
  try {
    commit = String(git('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    // not a git checkout, or git is missing
  }
  return `messages-control ${version}${commit ? ` (${commit})` : ''}`;
}
