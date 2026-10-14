const WINDOW = 16;

const TEXT_CAPACITY = 256;
const DETAIL_CAPACITY = 2048;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const ARCHES = {
  x86_64: { target: 0, unit: () => 1 },
  aarch64: { target: 1, unit: () => 4 },
  riscv64: { target: 2, unit: (b) => ((b[0] & 3) === 3 ? 4 : 2) },
  s390x: { target: 3, unit: (b) => [2, 4, 4, 6][b[0] >> 6] },
};

export const ARCH_NAMES = Object.keys(ARCHES);

export function createDisassembler(archName, capstone, syntax = 'intel', flags = {
  has_a: true,
  has_f: true,
  has_d: true,
  has_v: true,
}) {
  const spec = ARCHES[archName];
  if (!spec) throw new Error(`unknown arch ${archName}`);
  const riscvModes = {
    has_a: 1 << 9,
    has_f: 1 << 3,
    has_d: 1 << 3,
    has_v: 1 << 4,
    has_zba: 1 << 14,
    has_zbb: 1 << 15,
    has_zbc: 1 << 16,
    has_zbkb: 1 << 17,
    has_zbkc: 1 << 18,
    has_zbkx: 1 << 19,
    has_zbs: 1 << 20,
  };
  const mode = spec.target === 2
    ? (1 << 1) | (1 << 2) | Object.entries(riscvModes)
      .reduce((value, [flag, bit]) => value | (flags[flag] ? bit : 0), 0)
    : syntax === 'att' ? 1 : 0;
  const handle = capstone._dis_open(spec.target, mode);
  if (!handle) throw new Error(`cannot open disassembler for ${archName}`);
  const codePointer = capstone._malloc(WINDOW);
  const textPointer = capstone._malloc(TEXT_CAPACITY);
  const detailPointer = capstone._malloc(DETAIL_CAPACITY);

  function decodeOne(window, address) {
    capstone.HEAPU8.set(window, codePointer);
    const size = capstone._dis_one(handle, spec.target, codePointer, window.length, address, textPointer, TEXT_CAPACITY, detailPointer, DETAIL_CAPACITY);
    return size ? {
      size,
      text: capstone.UTF8ToString(textPointer).trim(),
      operands: JSON.parse(capstone.UTF8ToString(detailPointer)),
    } : undefined;
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
        operands: insn?.operands ?? [],
        trap: traps.find((t) => t.offset >= offset && t.offset < offset + size)?.code,
      });
      offset += size;
    }
    return lines;
  }

  function close() {
    capstone._free(codePointer);
    capstone._free(textPointer);
    capstone._free(detailPointer);
    capstone._dis_close(handle);
  }

  return { disassemble, close };
}
