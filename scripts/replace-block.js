#!/usr/bin/env node
// Refresh the kankan protocol block inside a target CLAUDE.md, in place.
//   node replace-block.js <target CLAUDE.md> <source CLAUDE.md>
// Replaces whatever is between the kankan markers with the current source.
// Prints `updated` if it replaced the block, or `manual` if the target has
// no markers (a legacy/pristine file we won't risk overwriting).
import { readFileSync, writeFileSync } from 'node:fs';

const [targetPath, sourcePath] = process.argv.slice(2);
const BEGIN = '<!-- kankan:begin -->';
const END = '<!-- kankan:end -->';

const target = readFileSync(targetPath, 'utf8');
if (!target.includes(BEGIN) || !target.includes(END)) {
  console.log('manual');
  process.exit(0);
}

const source = readFileSync(sourcePath, 'utf8').trimEnd();
const block = `${BEGIN}\n${source}\n${END}`;
writeFileSync(targetPath, target.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), () => block));
console.log('updated');
