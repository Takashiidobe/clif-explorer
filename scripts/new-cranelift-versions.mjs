import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MINIMUM = [0, 136, 0];
const versionsFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'versions.json');
const current = JSON.parse(readFileSync(versionsFile, 'utf8'));
const known = new Set(current);

const response = await fetch('https://crates.io/api/v1/crates/cranelift-codegen', {
  headers: { 'user-agent': 'clif-explorer (https://github.com/Takashiidobe/clif-explorer)' },
});
if (!response.ok) throw new Error(`crates.io returned ${response.status}`);
const { versions } = await response.json();

const atLeastMinimum = (parts) => {
  for (let i = 0; i < 3; i++) if (parts[i] !== MINIMUM[i]) return parts[i] > MINIMUM[i];
  return true;
};

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const fresh = versions
  .filter((v) => !v.yanked && /^\d+\.\d+\.\d+$/.test(v.num) && !known.has(v.num))
  .map((v) => v.num)
  .filter((num) => atLeastMinimum(num.split('.').map(Number)))
  .sort(compare);

if (process.argv.includes('--write') && fresh.length) {
  writeFileSync(versionsFile, `${JSON.stringify([...current, ...fresh].sort(compare), null, 2)}\n`);
}
console.log(fresh.join('\n'));
