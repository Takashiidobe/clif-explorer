import { recordLength } from './qemu.mjs';

const nodeThreads = typeof process === 'undefined' ? null : process.getBuiltinModule?.('worker_threads');
const port = nodeThreads?.parentPort;
const children = [];
const Native = nodeThreads?.Worker ?? globalThis.Worker;
const Tracked = class extends Native {
  constructor(...args) {
    if (nodeThreads && typeof args[0] === 'string' && args[0].startsWith('file:')) args[0] = new URL(args[0]);
    super(...args);
    children.push(this);
  }
};
if (nodeThreads) nodeThreads.Worker = Tracked;
else globalThis.Worker = Tracked;

async function execute({ compiled, js, wasm, files, args, resultBytes }) {
  let record;
  let failure;
  try {
    if (!compiled) compiled = await WebAssembly.compile(await process.getBuiltinModule('fs/promises').readFile(new URL(wasm)));
    const { default: create } = await import(js);
    let emscripten;
    let fatal;
    Promise.resolve(create({
      arguments: args,
      mainScriptUrlOrBlob: js,
      locateFile: (file) => file.endsWith('.wasm') ? wasm : new URL(file, js).href,
      print() {},
      printErr() {},
      onAbort: (message) => { fatal = new Error(String(message)); },
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(compiled, imports).then((instance) => receive(instance, compiled)).catch((error) => { fatal = error; });
        return {};
      },
      preRun: [(module) => {
        emscripten = module;
        for (const [path, bytes] of Object.entries(files)) module.FS.writeFile(path, bytes);
      }],
    })).catch((error) => { fatal = error; });
    for (;;) {
      if (fatal) throw fatal;
      let serial = new Uint8Array();
      if (emscripten?.FS.analyzePath('/serial.bin').exists) serial = emscripten.FS.readFile('/serial.bin');
      const length = recordLength(serial, resultBytes);
      if (length !== null && serial.length >= length) {
        record = serial.slice(0, length);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } catch (error) {
    failure = String(error?.message ?? error);
  } finally {
    await Promise.all(children.map((child) => child.terminate()));
  }
  const message = failure ? { ok: false, error: failure } : { ok: true, record };
  if (port) port.postMessage(message, record ? [record.buffer] : []);
  else if (nodeThreads) process.send(message);
  else postMessage(message, record ? [record.buffer] : []);
}

if (port) port.on('message', execute);
else if (nodeThreads) process.on('message', execute);
else onmessage = ({ data }) => execute(data);
