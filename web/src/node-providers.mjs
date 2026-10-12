import { readFile } from 'node:fs/promises';

const QEMU_DIR = new URL('../../build/qemu-wasm/out/', import.meta.url);
const CAPSTONE_DIR = new URL('../../build/capstone-wasm/out/', import.meta.url);

const qemuModules = new Map();
let capstoneModule;

export const nodeProviders = {
  qemu(arch) {
    if (!qemuModules.has(arch)) {
      qemuModules.set(
        arch,
        (async () => {
          const base = new URL(`qemu-system-${arch}`, QEMU_DIR);
          const { default: create } = await import(`${base}.js`);
          const compiled = await WebAssembly.compile(await readFile(new URL(`${base}.wasm`)));
          return { factory: (options) => create({ ...options, locateFile: (f) => new URL(f, QEMU_DIR).href }), compiled };
        })(),
      );
    }
    return qemuModules.get(arch);
  },
  capstone() {
    capstoneModule ??= import(`${CAPSTONE_DIR}capstone.mjs`).then(({ default: create }) => create());
    return capstoneModule;
  },
};
