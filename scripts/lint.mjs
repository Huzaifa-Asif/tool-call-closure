import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'test', 'examples', 'scripts'];
const files = [];
function walk(path) {
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    if (statSync(entry).isDirectory()) walk(entry);
    else if (/\.(?:c?js|mjs)$/.test(name)) files.push(entry);
  }
}
for (const root of roots) walk(root);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

const forbidden = new RegExp(`\\b(?:${['TO', 'DO'].join('')}|${['FIX', 'ME'].join('')})\\b`);
for (const file of files) {
  if (forbidden.test(readFileSync(file, 'utf8'))) throw new Error(`unfinished marker in ${file}`);
}
console.log(`Checked ${files.length} JavaScript files.`);
