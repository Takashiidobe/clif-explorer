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
          return { js: `${base}.js`, wasm: `${base}.wasm`, worker: new URL('./qemu-worker.mjs', import.meta.url) };
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
