const WINDOW = 16;

const TEXT_CAPACITY = 256;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const ARCHES = {
  x86_64: { target: 0, unit: () => 1 },
  aarch64: { target: 1, unit: () => 4 },
  riscv64: { target: 2, unit: (b) => ((b[0] & 3) === 3 ? 4 : 2) },
  s390x: { target: 3, unit: (b) => [2, 4, 4, 6][b[0] >> 6] },
};

export const ARCH_NAMES = Object.keys(ARCHES);

export function createDisassembler(archName, capstone, syntax = 'intel') {
  const spec = ARCHES[archName];
  if (!spec) throw new Error(`unknown arch ${archName}`);
  const handle = capstone._dis_open(spec.target, syntax === 'att' ? 1 : 0);
  if (!handle) throw new Error(`cannot open disassembler for ${archName}`);
  const codePointer = capstone._malloc(WINDOW);
  const textPointer = capstone._malloc(TEXT_CAPACITY);

  function decodeOne(window, address) {
    capstone.HEAPU8.set(window, codePointer);
    const size = capstone._dis_one(handle, codePointer, window.length, address, textPointer, TEXT_CAPACITY);
    return size ? { size, text: capstone.UTF8ToString(textPointer).trim() } : undefined;
  }

  function disassemble(code, traps = [], baseAddress = 0) {
    const lines = [];
    let offset = 0;
    while (offset < code.length) {
      const window = code.subarray(offset, offset + WINDOW);
      const insn = decodeOne(window, baseAddress + offset);
      const size = insn ? insn.size : Math.min(spec.unit(window), code.length - offset);
      const bytes = code.slice(offset, offset + size);
      lines.push({
        offset,
        size,
        bytes,
        text: insn ? insn.text : `.insn 0x${hex(bytes)}`,
        decoded: Boolean(insn),
        trap: traps.find((t) => t.offset >= offset && t.offset < offset + size)?.code,
      });
      offset += size;
    }
    return lines;
  }

  function close() {
    capstone._free(codePointer);
    capstone._free(textPointer);
    capstone._dis_close(handle);
  }

  return { disassemble, close };
}
