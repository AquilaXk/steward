import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { claudeArtifacts } from '../src/skills.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const { relative, body } of claudeArtifacts(root)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
}
