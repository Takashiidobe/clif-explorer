const INTEGER = /^([+-]?)(0x[0-9a-f]+|0b[01]+|\d+)$/i;

export function parseInteger(text) {
  const match = INTEGER.exec(text.trim().replaceAll('_', ''));
  if (!match) throw new Error(`"${text}" is not an integer`);
  const magnitude = BigInt(match[2]);
  return match[1] === '-' ? -magnitude : magnitude;
}
