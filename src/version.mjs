import { readFileSync } from 'node:fs';

// Package metadata is the single runtime version authority.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
