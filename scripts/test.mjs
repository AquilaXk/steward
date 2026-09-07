import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = readdirSync(new URL('../test/', import.meta.url)).filter(f => f.endsWith('.test.mjs')).sort().map(f => 'test/' + f);
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (run.error) {
    console.error(run.error.message);
    process.exitCode = 1;
}
else
    process.exitCode = run.status ?? 1;
