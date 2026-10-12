import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createDisassembler } from './disasm.mjs';
import { nodeProviders } from './node-providers.mjs';

const clif = createRequire(import.meta.url)('../../build/clif-0.136.0/clif_wasm.js');

const SRC = `function %f(i64, i64) -> i64 {
block0(v0: i64, v1: i64):
    v2 = imul v0, v1
    v3 = iconst.i64 3
    v4 = ushr v2, v3
    brif v4, block1, block2
block1:
    return v4
block2:
    trap user1
}
`;

const TARGETS = {
  x86_64: 'x86_64-unknown-linux-gnu',
  aarch64: 'aarch64-unknown-linux-gnu',
  riscv64: 'riscv64gc-unknown-linux-gnu',
  s390x: 's390x-unknown-linux-gnu',
};

for (const [arch, triple] of Object.entries(TARGETS)) {
  test(`${arch}: listing covers every byte and marks the trap`, async () => {
    const { functions, errors } = clif.compile(SRC, triple, ['unwind_info=false']);
    assert.deepEqual(errors, []);
    const [f] = functions;
    const d = createDisassembler(arch, await nodeProviders.capstone());
    const lines = d.disassemble(f.code, f.traps);
    d.close();

    assert.equal(lines.reduce((n, l) => n + l.size, 0), f.code.length);
    lines.reduce((expected, l) => {
      assert.equal(l.offset, expected);
      return expected + l.size;
    }, 0);
    const trapLines = lines.filter((l) => l.trap);
    assert.equal(trapLines.length, 1);
    assert.equal(trapLines[0].trap, 'user1');
    const undecoded = lines.filter((l) => !l.decoded);
    assert.ok(
      undecoded.every((l) => l.trap || l.bytes.every((b) => b === 0)),
      'only trap encodings or zero padding may be undecoded',
    );
  });
}
