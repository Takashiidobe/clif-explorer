import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, '..');
const out = process.argv[2] ?? join(root, 'dist');
const crate = join(repo, 'crates', 'clif-wasm');

const QEMU_ARCHS = ['x86_64', 'aarch64', 'riscv64', 's390x'];
const qemuDist = join(repo, 'build', 'qemu-wasm', 'out');

const versions = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'));
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function sourceHash(version, lock) {
  const hash = createHash('sha256').update(version);
  const files = readdirSync(join(crate, 'src')).sort().map((name) => join(crate, 'src', name));
  for (const file of [...files, join(crate, 'Cargo.toml'), ...(existsSync(lock) ? [lock] : [])]) hash.update(readFileSync(file));
  return hash.digest('hex');
}

function ensureWasm(version) {
  const outDir = join(root, 'target', `clif-${version}`);
  const wasm = join(outDir, 'clif_wasm_bg.wasm');
  const lock = join(root, 'locks', `${version}.lock`);
  const stamp = join(outDir, 'source.hash');
  const wanted = sourceHash(version, lock);
  const upToDate = existsSync(wasm) && existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted;
  if (!upToDate) {
    const workDir = join(root, 'target', `src-${version}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(join(workDir, 'crates'), { recursive: true });
    cpSync(crate, join(workDir, 'crates', 'clif-wasm'), { recursive: true });
    cpSync(join(repo, 'Cargo.toml'), join(workDir, 'Cargo.toml'));
    const manifestPath = join(workDir, 'crates', 'clif-wasm', 'Cargo.toml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(/"=[0-9][^"]*"/g, `"=${version}"`));
    if (existsSync(lock)) cpSync(lock, join(workDir, 'Cargo.lock'));
    const result = spawnSync('wasm-pack', ['build', '--target', 'no-modules', '--release', '--out-dir', outDir], {
      cwd: join(workDir, 'crates', 'clif-wasm'),
      env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target', 'cargo') },
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`wasm-pack failed for Cranelift ${version}`);
    mkdirSync(dirname(lock), { recursive: true });
    cpSync(join(workDir, 'Cargo.lock'), lock);
    writeFileSync(stamp, sourceHash(version, lock));
    rmSync(workDir, { recursive: true, force: true });
  }
  return outDir;
}

function hashOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

function emit(directory, stem, extension, bytes) {
  const name = `${stem}.${hashOf(bytes)}.${extension}`;
  mkdirSync(join(out, directory), { recursive: true });
  writeFileSync(join(out, directory, name), bytes);
  return directory ? `${directory}/${name}` : name;
}

function emitFile(directory, stem, extension, path) {
  return emit(directory, stem, extension, readFileSync(path));
}

async function bundle(entry, stem) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
  });
  return emit('', stem, 'js', result.outputFiles[0].contents);
}

const builds = versions.toSorted(compareVersions).map((version) => ({ version, wasmDir: ensureWasm(version) }));
const newest = builds.at(-1).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'frontend'), out, { recursive: true });

const worker = await bundle('src/worker.js', 'worker');
const qemuWorker = await bundle('src/qemu-worker.mjs', 'qemu-worker');
const app = await bundle('frontend/app.js', 'app');
rmSync(join(out, 'app.js'));

const capstoneDist = join(repo, 'build', 'capstone-wasm', 'out');

const qemu = Object.fromEntries(
  QEMU_ARCHS.map((arch) => [
    arch,
    {
      js: emitFile('vendor', `qemu-system-${arch}`, 'js', join(qemuDist, `qemu-system-${arch}.js`)),
      wasm: emitFile('vendor', `qemu-system-${arch}`, 'wasm', join(qemuDist, `qemu-system-${arch}.wasm`)),
    },
  ]),
);
const capstone = {
  js: emitFile('vendor', 'capstone', 'js', join(capstoneDist, 'capstone.mjs')),
  wasm: emitFile('vendor', 'capstone', 'wasm', join(capstoneDist, 'capstone.wasm')),
};
cpSync(join(qemuDist, 'QEMU-LICENSE'), join(out, 'vendor', 'QEMU-LICENSE'));
cpSync(join(capstoneDist, 'CAPSTONE-LICENSE'), join(out, 'vendor', 'CAPSTONE-LICENSE'));

const manifest = {
  worker,
  defaultVersion: newest,
  versions: builds.toReversed().map(({ version, wasmDir }) => ({
    id: version,
    label: `Cranelift ${version}`,
    js: emitFile('', `clif-${version}`, 'js', join(wasmDir, 'clif_wasm.js')),
    wasm: emitFile('', `clif-${version}`, 'wasm', join(wasmDir, 'clif_wasm_bg.wasm')),
  })),
  assets: { capstone, qemu, qemuWorker },
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const indexPath = join(out, 'index.html');
const index = readFileSync(indexPath, 'utf8');
if (!index.includes('src="app.js"')) throw new Error('index.html no longer references app.js');
writeFileSync(indexPath, index.replace('src="app.js"', `src="${app}"`));

const immutable = 'Cache-Control: public, max-age=31536000, immutable';
writeFileSync(
  join(out, '_headers'),
  [
    '/worker.*.js',
    `  ${immutable}`,
    '/qemu-worker.*.js',
    `  ${immutable}`,
    '/app.*.js',
    `  ${immutable}`,
    '/clif-*',
    `  ${immutable}`,
    '/vendor/*',
    `  ${immutable}`,
    '/*',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Embedder-Policy: require-corp',
    '/manifest.json',
    '  Cache-Control: no-cache',
    '/',
    '  Cache-Control: no-cache',
    '/index.html',
    '  Cache-Control: no-cache',
    '/assets/*',
    '  Cache-Control: no-cache',
    '/examples/*',
    '  Cache-Control: no-cache',
    '',
  ].join('\n'),
);

console.log(`built Cranelift ${versions.join(', ')} into ${out}`);
