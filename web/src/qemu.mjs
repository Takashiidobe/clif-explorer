import { MAX_RESULT_BYTES, RESULT_HEADER_LENGTH, TRAP_RECORD_LENGTH } from './types.mjs';
export class GuestTimeout extends Error {}

export function recordLength(serial, resultBytes) {
  if (!serial.length) return null;
  if (serial[0] === 'T'.charCodeAt(0)) return TRAP_RECORD_LENGTH;
  if (serial[0] !== 'R'.charCodeAt(0)) throw new Error('the emulator produced an invalid record');
  if (serial.length < RESULT_HEADER_LENGTH) return null;
  const size = new DataView(serial.buffer, serial.byteOffset).getBigUint64(1, true);
  if (size > BigInt(MAX_RESULT_BYTES) || size !== BigInt(resultBytes)) throw new Error('the emulator produced an invalid result length');
  return RESULT_HEADER_LENGTH + Number(size);
}

export async function runGuest({ load, files, args, timeoutMs, resultBytes }) {
  const { compiled, js, wasm, worker: workerURL } = await load();
  const nodeProcesses = typeof process === 'undefined' ? null : process.getBuiltinModule?.('child_process');
  const worker = nodeProcesses
    ? nodeProcesses.fork(workerURL, { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    : new Worker(workerURL);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const message = (data) => {
        if (data.ok) resolve(data.record);
        else reject(new Error(data.error));
      };
      if (nodeProcesses) {
        worker.stderr.resume();
        worker.on('message', message);
        worker.on('error', reject);
        worker.on('exit', (code) => reject(new Error(`the emulator worker exited before reporting a result (${code})`)));
      } else {
        worker.onmessage = ({ data }) => message(data);
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message));
        };
      }
      timer = setTimeout(() => reject(new GuestTimeout()), timeoutMs);
      const request = { compiled, js, wasm, files, args, resultBytes };
      if (nodeProcesses) worker.send(request);
      else worker.postMessage(request);
    });
  } finally {
    clearTimeout(timer);
    if (nodeProcesses) {
      if (worker.exitCode === null && worker.signalCode === null) {
        await new Promise((resolve) => {
          worker.once('close', resolve);
          worker.kill('SIGKILL');
        });
      }
    } else worker.terminate();
  }
}
