// Stable launcher: the installed checkout is never overwritten during an update.
import { installedRoot } from './supervisor.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const active = installedRoot(join(root, '.land-updates'), root);
const { startOffice } = await import(pathToFileURL(join(active, 'scripts/supervisor.mjs')).href);
await startOffice({ root });
