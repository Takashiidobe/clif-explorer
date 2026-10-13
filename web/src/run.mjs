import { createDisassembler } from './disasm.mjs';
import { GuestTimeout, runGuest } from './qemu.mjs';
import { STUBS } from './stubs.mjs';
import { adapterSource } from './adapter.mjs';
import { decodeReturn, encodeArgument } from './args.mjs';
import { MAX_RESULT_BYTES, RESULT_HEADER_LENGTH, RESULT_OFFSET, TRAP_RECORD_LENGTH, valueLayout } from './types.mjs';

const PAGE = 0x1000;
const FUNCTION_ALIGN = 16;
const DEFAULT_TIMEOUT_MS = 5000;
const GUEST_MEMORY_MB = 16;

const COMMON_QEMU_ARGS = ['-display', 'none', '-monitor', 'none', '-nodefaults', '-no-reboot', '-m', String(GUEST_MEMORY_MB), '-accel', 'tcg,tb-size=16'];
const SERIAL_FILE = ['-serial', 'file:/serial.bin'];

const X86_EXCEPTIONS = {
  0: 'divide error',
  1: 'debug',
  3: 'breakpoint',
  4: 'overflow',
  5: 'bound range exceeded',
  6: 'invalid opcode',
  7: 'device not available',
  8: 'double fault',
  10: 'invalid TSS',
  11: 'segment not present',
  12: 'stack fault',
  13: 'general protection fault',
  14: 'page fault',
  16: 'x87 floating-point error',
  17: 'alignment check',
  19: 'SIMD floating-point error',
};

const RISCV_CAUSES = {
  0: 'instruction address misaligned',
  1: 'instruction access fault',
  2: 'illegal instruction',
  3: 'breakpoint',
  4: 'load address misaligned',
  5: 'load access fault',
  6: 'store address misaligned',
  7: 'store access fault',
};

const AARCH64_CLASSES = {
  0x00: 'unknown reason (undefined instruction)',
  0x07: 'SIMD/FP access trapped',
  0x15: 'supervisor call',
  0x20: 'instruction abort',
  0x21: 'instruction abort',
  0x22: 'PC alignment fault',
  0x24: 'data abort',
  0x25: 'data abort',
  0x26: 'SP alignment fault',
  0x2c: 'floating-point exception',
  0x3c: 'breakpoint',
};

const S390X_CODES = {
  0x01: 'operation exception',
  0x02: 'privileged operation',
  0x03: 'execute exception',
  0x04: 'protection exception',
  0x05: 'addressing exception',
  0x06: 'specification exception',
  0x07: 'data exception',
  0x08: 'fixed-point overflow',
  0x09: 'fixed-point divide',
  0x0a: 'decimal overflow',
  0x0b: 'decimal divide',
  0x10: 'segment translation',
  0x11: 'page translation',
  0x12: 'translation specification',
  0x13: 'special operation',
};

const hexValue = (n) => `0x${n.toString(16)}`;

const ABIS = {
  x86_64: {
    codeBase: 0x101000,
    littleEndian: true,
    describeTrap: (_pc, cause) => X86_EXCEPTIONS[Number(cause)] ?? `exception ${cause}`,
    image(stub, argsBlock, code) {
      const blob = new Uint8Array(PAGE + code.length);
      blob.set(argsBlock);
      blob.set(code, PAGE);
      return {
        files: { '/stub.bin': stub, '/blob.bin': blob },
        args: [
          '-machine', 'pc', '-cpu', 'max', '-bios', '/stub.bin',
          '-device', 'loader,file=/blob.bin,addr=0x100000,force-raw=on',
          ...SERIAL_FILE,
        ],
      };
    },
  },
  aarch64: {
    codeBase: 0x40081000,
    littleEndian: true,
    describeTrap: (_pc, cause) => AARCH64_CLASSES[Number(cause >> 26n)] ?? `exception class ${hexValue(cause >> 26n)}`,
    image: flatImage(0x100, ['-machine', 'virt', '-cpu', 'max', '-kernel', '/image.bin', ...SERIAL_FILE]),
  },
  riscv64: {
    codeBase: 0x80001000,
    littleEndian: true,
    describeTrap: (_pc, cause) => RISCV_CAUSES[Number(cause)] ?? `trap cause ${cause}`,
    image: flatImage(0x100, ['-machine', 'virt', '-cpu', 'max', '-bios', 'none', '-kernel', '/image.bin', ...SERIAL_FILE]),
  },
  s390x: {
    codeBase: 0x3000,
    littleEndian: false,
    describeTrap: (_pc, cause) => S390X_CODES[Number(cause & 0xffffn)] ?? `program interruption ${hexValue(cause & 0xffffn)}`,
    trapCandidates: (pc, cause) => [pc - (cause >> 16n), pc],
    image(stub, argsBlock, code) {
      const image = new Uint8Array(0x3000 + code.length);
      new DataView(image.buffer).setUint32(4, 0x2000);
      image.set(stub, 0x2000);
      image.set(argsBlock, 0x2200);
      image.set(code, 0x3000);
      return {
        files: { '/image.bin': image, '/firmware.bin': new Uint8Array(16) },
        args: [
          '-machine', 's390-ccw-virtio', '-cpu', 'max', '-bios', '/firmware.bin', '-kernel', '/image.bin',
          '-device', 'sclpconsole,chardev=c0', '-chardev', 'file,id=c0,path=/serial.bin',
        ],
      };
    },
  },
};

function flatImage(argsOffset, args) {
  return (stub, argsBlock, code) => {
    const image = new Uint8Array(PAGE + code.length);
    image.set(stub);
    image.set(argsBlock, argsOffset);
    image.set(code, PAGE);
    return { files: { '/image.bin': image }, args };
  };
}

export class RunError extends Error {}

const u64 = (v) => BigInt.asUintN(64, BigInt(v));
const roundUp = (n, to) => Math.ceil(n / to) * to;

function expandStub(archName) {
  const { size, chunks } = STUBS[archName];
  const stub = new Uint8Array(size);
  for (const [offset, base64] of chunks) stub.set(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), offset);
  return stub;
}

function layOut(functions) {
  const offsets = new Map();
  let size = 0;
  for (const f of functions) {
    size = roundUp(size, FUNCTION_ALIGN);
    offsets.set(f.name, size);
    size += f.code.length;
  }
  const image = new Uint8Array(roundUp(Math.max(size, 1), PAGE));
  for (const f of functions) image.set(f.code, offsets.get(f.name));
  return { image, offsets };
}

function applyRelocs(archName, functions, image, offsets, codeBase) {
  const view = new DataView(image.buffer);
  for (const f of functions) {
    for (const r of f.relocs) {
      const targetOffset = offsets.get(r.target);
      if (targetOffset === undefined) {
        throw new RunError(`${f.name}: unresolved ${r.kind} relocation against ${r.target}`);
      }
      const at = offsets.get(f.name) + r.offset;
      const delta = BigInt(targetOffset) + BigInt(r.addend) - BigInt(at);
      const offsetRelative = Number(delta);
      switch (`${archName}:${r.kind}`) {
        case 'x86_64:CallPCRel4':
        case 'x86_64:PCRel4':
          view.setInt32(at, offsetRelative, true);
          break;
        case 'x86_64:Abs8':
        case 'aarch64:Abs8':
        case 'riscv64:Abs8':
          view.setBigUint64(at, u64(BigInt(codeBase + targetOffset) + BigInt(r.addend)), true);
          break;
        case 's390x:Abs8':
          view.setBigUint64(at, u64(BigInt(codeBase + targetOffset) + BigInt(r.addend)), false);
          break;
        case 'aarch64:Call':
          view.setUint32(at, (view.getUint32(at, true) | ((offsetRelative >> 2) & 0x3ffffff)) >>> 0, true);
          break;
        case 'riscv64:RiscvCallPlt': {
          const hi = (offsetRelative + 0x800) >> 12;
          const lo = offsetRelative - (hi << 12);
          view.setUint32(at, (view.getUint32(at, true) | ((hi & 0xfffff) << 12)) >>> 0, true);
          view.setUint32(at + 4, (view.getUint32(at + 4, true) | ((lo & 0xfff) << 20)) >>> 0, true);
          break;
        }
        case 's390x:PLTRel32Dbl':
        case 's390x:PCRel32Dbl':
          view.setInt32(at, offsetRelative / 2, false);
          break;
        default:
          throw new RunError(`${f.name}: unsupported ${r.kind} relocation against ${r.target} on ${archName}`);
      }
    }
  }
}

function checkSignature(f, args) {
  if (args.length !== f.params.length) {
    throw new RunError(`${f.name} takes ${f.params.length} arguments, got ${args.length}`);
  }
  const inputs = valueLayout(f.params);
  const outputs = valueLayout(f.returns);
  if (outputs.size > MAX_RESULT_BYTES) throw new RunError(`${f.name}: results exceed the ${MAX_RESULT_BYTES}-byte limit`);
  return { inputs, outputs };
}

function argsBlock(abi, entry, values) {
  const block = new Uint8Array(8 * (1 + values.length));
  const view = new DataView(block.buffer);
  [entry, ...values].forEach((value, i) => view.setBigUint64(8 * i, u64(value), abi.littleEndian));
  return block;
}

export async function createRunner(archName, functions, { qemu, capstone, compileAdapter }) {
  const abi = ABIS[archName];
  if (!abi) throw new RunError(`unknown arch ${archName}`);
  if (!compileAdapter) throw new RunError('Run requires an adapter compiler');
  const { image: code, offsets } = layOut(functions);
  applyRelocs(archName, functions, code, offsets, abi.codeBase);
  const stub = expandStub(archName);

  const disassembler = await createDisassembler(archName, await capstone());
  const lines = new Map();
  for (const f of functions) {
    for (const line of disassembler.disassemble(f.code, f.traps, abi.codeBase + offsets.get(f.name))) {
      lines.set(offsets.get(f.name) + line.offset, { ...line, function: f.name });
    }
  }
  disassembler.close();

  const byName = new Map(functions.map((f) => [f.name, f]));
  const adapters = new Map();
  let adapterName = '%__clif_explorer_run';
  while (byName.has(adapterName)) adapterName += '_';

  async function prepare(f) {
    if (!adapters.has(f.name)) {
      const output = await compileAdapter(adapterSource(f, adapterName));
      if (output.errors.length) throw new RunError(`${f.name}: cannot prepare the call: ${output.errors.join('\n')}`);
      const adapter = output.functions[0];
      if (!adapter) throw new RunError(`${f.name}: the adapter compiler produced no function`);
      const all = [...functions, adapter];
      const layout = layOut(all);
      applyRelocs(archName, all, layout.image, layout.offsets, abi.codeBase);
      adapters.set(f.name, { code: layout.image, entry: abi.codeBase + layout.offsets.get(adapter.name) });
    }
    return adapters.get(f.name);
  }

  function locate(pcs) {
    let fallback = {};
    for (const pc of pcs) {
      const offset = Number(pc) - abi.codeBase;
      const size = lines.get(offset)?.size ?? 1;
      for (const f of functions) {
        const start = offsets.get(f.name);
        if (offset < start || offset >= start + f.code.length) continue;
        const rel = offset - start;
        const site = f.traps.find((t) => t.offset >= rel && t.offset < rel + size);
        const found = { fn: f.name, offset: rel, pc, trap: site?.code };
        if (site) return found;
        if (!fallback.fn) fallback = found;
      }
    }
    return fallback;
  }

  async function run(fnName, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const f = byName.get(fnName);
    if (!f) throw new RunError(`no function named ${fnName}`);
    const { inputs, outputs } = checkSignature(f, args);
    const prepared = await prepare(f);
    const outputOffset = roundUp(inputs.size, RESULT_OFFSET);
    const runCode = new Uint8Array(prepared.code.length + outputOffset + RESULT_OFFSET + outputs.size);
    runCode.set(prepared.code);
    const data = new DataView(runCode.buffer, prepared.code.length);
    inputs.entries.forEach(({ type, offset }, i) => encodeArgument(data, offset, type, args[i], abi.littleEndian));
    data.setBigUint64(outputOffset, BigInt(outputs.size), abi.littleEndian);
    const callArgs = [abi.codeBase + prepared.code.length, abi.codeBase + prepared.code.length + outputOffset];
    const guest = abi.image(stub, argsBlock(abi, prepared.entry, callArgs), runCode);

    let record;
    try {
      record = await runGuest({
        load: () => qemu(archName),
        files: guest.files,
        args: [...guest.args, ...COMMON_QEMU_ARGS],
        timeoutMs,
        resultBytes: outputs.size,
      });
    } catch (error) {
      if (error instanceof GuestTimeout) return { status: 'timeout', returns: [] };
      throw error;
    }
    const view = new DataView(record.buffer, record.byteOffset);
    if (record[0] === 'R'.charCodeAt(0)) {
      if (record.length !== RESULT_HEADER_LENGTH + outputs.size || view.getBigUint64(1, true) !== BigInt(outputs.size)) {
        throw new RunError('the emulator produced an invalid result');
      }
      const returns = outputs.entries.map(({ type, offset }) => decodeReturn(view, RESULT_HEADER_LENGTH + offset, type, abi.littleEndian));
      return { status: 'ok', returns };
    }

    if (record.length !== TRAP_RECORD_LENGTH || record[0] !== 'T'.charCodeAt(0)) throw new RunError('the emulator produced an invalid trap record');
    const first = view.getBigUint64(1, true);
    const second = view.getBigUint64(9, true);
    const found = locate((abi.trapCandidates ?? ((pc) => [pc]))(first, second));
    return {
      status: found.trap ? 'trap' : 'fault',
      returns: [],
      error: abi.describeTrap(first, second),
      pc: found.pc ?? first,
      function: found.fn,
      offset: found.offset,
      text: found.fn === undefined ? undefined : lines.get(offsets.get(found.fn) + found.offset)?.text,
      trapCode: found.trap,
    };
  }

  return { run, functions: functions.map((f) => f.name) };
}
