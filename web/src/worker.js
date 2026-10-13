import { createDisassembler } from './disasm.mjs';
import { createRunner } from './run.mjs';

const TRIPLES = {
  x86_64: 'x86_64-unknown-linux-gnu',
  aarch64: 'aarch64-unknown-linux-gnu',
  riscv64: 'riscv64gc-unknown-linux-gnu',
  s390x: 's390x-unknown-linux-gnu',
};

let assets;
let cranelift;
let compiled = null;

const qemuModules = new Map();
let capstoneModule;

function status(text) {
  postMessage({ type: 'status', text });
}

const providers = {
  qemu(arch) {
    if (!qemuModules.has(arch)) {
      status(`Loading ${arch} emulator…`);
      const js = new URL(assets.qemu[arch].js, self.location).href;
      const wasm = new URL(assets.qemu[arch].wasm, self.location).href;
      qemuModules.set(
        arch,
        WebAssembly.compileStreaming(fetch(wasm)).then((compiled) => ({
          js,
          wasm,
          worker: new URL(assets.qemuWorker, self.location).href,
          compiled,
        })),
      );
    }
    return qemuModules.get(arch);
  },
  capstone() {
    if (!capstoneModule) {
      status('Loading disassembler…');
      const wasm = new URL(assets.capstone.wasm, self.location).href;
      capstoneModule = import(new URL(assets.capstone.js, self.location).href).then(({ default: create }) => create({ locateFile: () => wasm }));
    }
    return capstoneModule;
  },
};

async function disassemble(arch, functions, syntax = 'intel') {
  const disassembler = createDisassembler(arch, await providers.capstone(), syntax);
  try {
    return functions.map((f) => ({ ...f, lines: disassembler.disassemble(f.code, f.traps) }));
  } finally {
    disassembler.close();
  }
}

function compileKey({ arch, clif, flags }) {
  return JSON.stringify([arch, flags, clif]);
}

async function compile(request) {
  const { arch, clif, flags } = request;
  const started = performance.now();
  const output = cranelift.compile(clif, TRIPLES[arch], flags);
  const ms = performance.now() - started;
  compiled = output.errors.length ? null : { key: compileKey(request), arch, functions: output.functions, runner: null };
  const functions = output.errors.length ? [] : await disassemble(arch, output.functions);
  if (arch === 'x86_64' && functions.length) {
    const att = await disassemble(arch, output.functions, 'att');
    functions.forEach((f, i) => { f.attLines = att[i].lines; });
  }
  return { errors: output.errors, functions, ms };
}

const handlers = {
  async init({ version, assets: urls }) {
    assets = urls;
    status(`Loading Cranelift ${version.id}…`);
    importScripts(version.js);
    await wasm_bindgen({ module_or_path: version.wasm });
    cranelift = wasm_bindgen;
    return { archs: Object.keys(TRIPLES) };
  },

  schema({ arch }) {
    return cranelift.flag_schema(TRIPLES[arch]);
  },

  compile,

  async run(request) {
    const { function: name, args } = request;
    if (compiled?.key !== compileKey(request)) {
      const { errors } = await compile(request);
      if (errors.length) throw new Error('The program does not compile.');
    }
    compiled.runner ??= await createRunner(compiled.arch, compiled.functions, {
      ...providers,
      compileAdapter: (source) => cranelift.compile(source, TRIPLES[request.arch], request.flags),
    });
    const started = performance.now();
    const result = await compiled.runner.run(name, args);
    return { ...result, ms: performance.now() - started };
  },
};

self.onmessage = async ({ data: { id, type, ...request } }) => {
  try {
    postMessage({ id, ok: true, result: await handlers[type](request) });
  } catch (error) {
    postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
