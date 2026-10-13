const WIDTHS = { i8: 8, i16: 16, i32: 32, i64: 64, i128: 128, f16: 16, f32: 32, f64: 64 };
export const RESULT_OFFSET = 64;
export const RESULT_HEADER_LENGTH = 9;
export const TRAP_RECORD_LENGTH = 17;
export const MAX_RESULT_BYTES = 4096 - 23;

export function typeInfo(type) {
  const match = /^(i8|i16|i32|i64|i128|f16|f32|f64)(?:x(\d+))?$/.exec(type);
  if (!match) throw new Error(`${type} is not supported in Run yet`);
  const laneType = match[1];
  const lanes = match[2] ? Number(match[2]) : 1;
  const laneBits = WIDTHS[laneType];
  if (match[2] && (lanes < 2 || lanes > 256 || (lanes & (lanes - 1)) || laneBits * lanes > 128)) {
    throw new Error(`${type} is not supported in Run yet`);
  }
  return { type, laneType, laneBits, lanes, vector: !!match[2], size: laneBits * lanes / 8 };
}

export function valueLayout(types) {
  let size = 0;
  const entries = types.map((type) => {
    const info = typeInfo(type);
    size = Math.ceil(size / info.size) * info.size;
    const offset = size;
    size += info.size;
    return { ...info, offset };
  });
  return { entries, size };
}
