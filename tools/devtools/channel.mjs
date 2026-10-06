// Shared by daemon.mjs and call.mjs: where the command channel lives.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const PIPE = '\\\\.\\pipe\\msf-devtools';
export const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'token.txt');
