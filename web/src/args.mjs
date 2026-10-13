import { typeInfo } from './types.mjs';

const INTEGER = /^([+-]?)(0x[0-9a-f]+|0b[01]+|\d+)$/i;

export function parseInteger(text) {
  const match = INTEGER.exec(text.trim().replaceAll('_', ''));
  if (!match) throw new Error(`"${text}" is not an integer`);
  const magnitude = BigInt(match[2]);
  return match[1] === '-' ? -magnitude : magnitude;
}

const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseArgument(type, text) {
  const info = typeInfo(type);
  if (info.vector) {
    const source = text.trim();
    const values = (source.startsWith('[') && source.endsWith(']') ? source.slice(1, -1) : source).split(',');
    if (values.length !== info.lanes) throw new Error(`${type} takes ${info.lanes} lanes, got ${values.length}`);
    return values.map((value) => parseArgument(info.laneType, value));
  }
  if (!type.startsWith('f')) return parseInteger(text);
  const value = text.trim().replaceAll('_', '');
  if (/^[+-]?nan$/i.test(value)) return NaN;
  if (/^[+-]?(?:inf|infinity)$/i.test(value)) return value.startsWith('-') ? -Infinity : Infinity;
  if (!FLOAT.test(value)) throw new Error(`"${text}" is not a floating-point number`);
  return Number(value);
}

export function defaultArgument(type) {
  try {
    const info = typeInfo(type);
    return info.vector ? `[${Array(info.lanes).fill('0').join(', ')}]` : '0';
  } catch {
    return '0';
  }
}

export function parseSharedArguments(text) {
  if (text.startsWith('[')) {
    try {
      const values = JSON.parse(text);
      if (Array.isArray(values) && values.every((value) => typeof value === 'string')) return values;
    } catch {}
  }
  return text.split(',');
}

export function formatFloat(value) {
  return Object.is(value, -0) ? '-0' : String(value);
}

export function floatBits(type, value) {
  const view = new DataView(new ArrayBuffer(8));
  if (type === 'f16') {
    value = Number(value);
    const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
    const magnitude = Math.abs(value);
    if (Number.isNaN(value)) return 0x7e00n;
    if (magnitude >= 65520) return BigInt(sign | 0x7c00);
    const roundEven = (n) => {
      const lower = Math.floor(n);
      const fraction = n - lower;
      return lower + (fraction > 0.5 || (fraction === 0.5 && lower % 2) ? 1 : 0);
    };
    if (magnitude < 2 ** -14) return BigInt(sign | roundEven(magnitude * 2 ** 24));
    const exponent = Math.floor(Math.log2(magnitude));
    const significand = roundEven(magnitude / 2 ** (exponent - 10));
    return BigInt(sign | (((exponent + 15) << 10) + significand - 1024));
  }
  if (type === 'f32') {
    view.setFloat32(0, Number(value), true);
    return BigInt(view.getUint32(0, true));
  }
  view.setFloat64(0, Number(value), true);
  return view.getBigUint64(0, true);
}

export function floatValue(type, bits) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  if (type === 'f16') {
    const raw = Number(bits & 0xffffn);
    const exponent = (raw >> 10) & 31;
    const fraction = raw & 1023;
    const magnitude = exponent === 31 ? (fraction ? NaN : Infinity)
      : exponent === 0 ? fraction * 2 ** -24 : (1024 + fraction) * 2 ** (exponent - 25);
    return raw & 0x8000 ? -magnitude : magnitude;
  }
  if (type === 'f32') return view.getFloat32(0, true);
  return view.getFloat64(0, true);
}

function writeBits(view, offset, size, bits, littleEndian) {
  for (let i = 0; i < size; i++) {
    view.setUint8(offset + (littleEndian ? i : size - 1 - i), Number(bits & 255n));
    bits >>= 8n;
  }
}

function readBits(view, offset, size, littleEndian) {
  let bits = 0n;
  for (let i = size - 1; i >= 0; i--) {
    bits = (bits << 8n) | BigInt(view.getUint8(offset + (littleEndian ? i : size - 1 - i)));
  }
  return bits;
}

export function encodeArgument(view, offset, type, value, littleEndian) {
  const info = typeInfo(type);
  if (info.vector) {
    if (!Array.isArray(value) || value.length !== info.lanes) throw new Error(`${type} takes ${info.lanes} lanes`);
    value.forEach((lane, i) => encodeArgument(view, offset + i * info.laneBits / 8, info.laneType, lane, littleEndian));
    return;
  }
  const bits = type.startsWith('f') ? floatBits(type, value) : BigInt.asUintN(info.laneBits, BigInt(value));
  writeBits(view, offset, info.size, bits, littleEndian);
}

export function decodeReturn(view, offset, type, littleEndian) {
  const info = typeInfo(type);
  const bits = readBits(view, offset, info.size, littleEndian);
  if (info.vector) {
    const lanes = Array.from({ length: info.lanes }, (_, i) => decodeReturn(view, offset + i * info.laneBits / 8, info.laneType, littleEndian));
    return { type, bits, lanes };
  }
  if (type.startsWith('f')) return { type, bits, value: floatValue(type, bits) };
  return { type, unsigned: bits, signed: BigInt.asIntN(info.laneBits, bits) };
}
