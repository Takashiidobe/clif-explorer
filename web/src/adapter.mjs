import { RESULT_OFFSET, valueLayout } from './types.mjs';

export function adapterSource(f, name) {
  const inputs = valueLayout(f.params);
  const outputs = valueLayout(f.returns);
  const targetReturns = f.returns.length ? ` -> ${f.returns.join(', ')}` : '';
  const lines = [
    `function ${name}(i64, i64) -> i64 {`,
    `    fn0 = colocated ${f.name}${f.signature ?? `(${f.params.join(', ')})${targetReturns} ${f.call_conv}`}`,
    'block0(v0: i64, v1: i64):',
  ];
  let next = 2;
  const emit = (instruction) => {
    const value = `v${next++}`;
    lines.push(`    ${value} = ${instruction}`);
    return value;
  };
  const args = inputs.entries.map(({ type, offset }) => emit(`load.${type} v0+${offset}`));
  const results = f.returns.map(() => `v${next++}`);
  lines.push(`    ${results.length ? `${results.join(', ')} = ` : ''}call fn0(${args.join(', ')})`);
  outputs.entries.forEach(({ offset }, i) => {
    lines.push(`    store ${results[i]}, v1+${RESULT_OFFSET + offset}`);
  });
  lines.push('    return v1', '}');
  return `${lines.join('\n')}\n`;
}

