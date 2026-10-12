export const RECORD_LENGTH = 17;
const POLL_MS = 2;

export class GuestTimeout extends Error {}

let spawned = null;
let wrapped = false;

function trackWorkers() {
  if (wrapped) return;
  wrapped = true;
  const nodeThreads = typeof process === 'undefined' ? null : process.getBuiltinModule?.('worker_threads');
  const Native = nodeThreads?.Worker ?? globalThis.Worker;
  const Tracked = class extends Native {
    constructor(...args) {
      super(...args);
      spawned?.push(this);
    }
  };
  if (nodeThreads) nodeThreads.Worker = Tracked;
  else globalThis.Worker = Tracked;
}

export async function runGuest({ load, files, args, timeoutMs }) {
  const { factory, compiled } = await load();
  let emscripten;
  trackWorkers();
  const workers = (spawned = []);
  const started = Date.now();
  factory({
    arguments: args,
    print() {},
    printErr() {},
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(compiled, imports).then((instance) => receive(instance, compiled));
      return {};
    },
    preRun: [
      (m) => {
        emscripten = m;
        for (const [path, bytes] of Object.entries(files)) m.FS.writeFile(path, bytes);
      },
    ],
  });

  try {
    for (;;) {
      let serial = new Uint8Array();
      try {
        serial = emscripten.FS.readFile('/serial.bin');
      } catch {
        // the chardev creates the file once QEMU has started
      }
      if (serial.length >= RECORD_LENGTH) return serial.slice(0, RECORD_LENGTH);
      if (Date.now() - started > timeoutMs) throw new GuestTimeout();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    spawned = null;
    for (const worker of workers) worker.terminate();
  }
}
