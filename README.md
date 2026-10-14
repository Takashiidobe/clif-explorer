# clif-explorer

Compile [Cranelift](https://cranelift.dev) IR (CLIF) to machine code in your
browser, read the disassembly, and run it under QEMU. Nothing is sent to a
server.

## Use

```sh
cd web
npm install
npm run build
npm run serve
```

Open <http://127.0.0.1:8000> in Chromium or Firefox. To rebuild the emulators
and the disassembler from source, see [UPDATING.md](UPDATING.md).

The page has three tabs:

- **CLIF**: edit a program. Compile errors appear under the editor.
- **Assembly**: machine code or VCode for each function.
- **Run**: call a function with scalar or vector arguments and see its results or
  the trap it hit.

## Supported

- Targets: x86-64, aarch64, riscv64, s390x.
- Every Cranelift release since 0.136.0, chosen from the version menu.
- Cranelift flags for each target, set from the flags panel.
- Integer arguments and results through `i128`, plus `f16`, `f32`, and `f64`.
  Arguments can use registers or the stack, including mixed signatures.
- Fixed-width SIMD vectors through 128 bits, where the target and selected
  flags support them. Enter lanes as `[1, 2, 3, 4]` for `i32x4`, or
  `[1.25, -2.5]` for `f64x2`. Results show lanes in the same order.
- Multiple results, including wide integers and vectors. Results use memory
  when the target's calling convention requires it.
- Float inputs accept decimal and scientific notation, `NaN`, `inf`, and
  `-inf`. Results show the numeric value and its hexadecimal bits, preserving
  negative zero. Inputs round to the parameter's precision.
- Calls between functions in the same program.
- Traps, reported with the Cranelift trap code and the instruction that raised
  it.
- Default, Emacs, and Vim keybindings in the editor.
- Your last program, Cranelift version, target, flags, and keybindings are
  restored when you revisit.
- Share links that restore the program, Cranelift version, target, and flags.

Hover over a decoded instruction in the Assembly tab to see its description;
hover over its registers and values for operand details.
RISC-V descriptions come from the
[RISC-V Unified Database](https://github.com/riscv/riscv-unified-db); x86 and
AArch64 descriptions come from the
[ISA Database](https://instructionsets.com/data/).

LLVM ABI extensions, implicit return areas, and RISC-V vector instructions
are enabled by default. You can override these in the flags panel.

## Not supported

- Scalable vectors, vectors wider than 128 bits, and `f128` in `Run`. The
  Assembly tab shows them.
- Results larger than 4073 bytes in `Run`.
- Some `f16` operations cannot compile on some targets. Passing and returning
  `f16` works when the selected Cranelift backend can compile the program.
- Libcalls and external symbols.
- Single-stepping, instruction traces, and register views. A run goes to
  completion.
- A run that takes longer than five seconds is stopped and reported as a
  timeout.
- Safari. The emulator needs WebAssembly Memory64 (Chromium, Firefox 134 or
  later).

## Hosting

Serve `web/dist` with these headers on every response, or the emulator cannot
start:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`npm run serve` and `dist/_headers` (Cloudflare Pages and Netlify format) set
them. If a run fails with `DataCloneError`, check that `crossOriginIsolated` is
`true` in the browser console.

Enable Brotli or gzip on the host. Each emulator is tens of megabytes
uncompressed, and the page downloads only the one for the selected target.

## How it works

Cranelift runs as WebAssembly in a Web Worker and compiles your CLIF. Capstone
disassembles the result. To run a function, the worker boots QEMU in system
mode, with the code and arguments loaded into guest memory. A small stub calls
the function and writes the result to the serial port. Each emulator runs in
a separate worker that is terminated after the result or timeout. One worker
holds one Cranelift version.

## Tests

```sh
cargo test
cd web && npm test
cd web && npm run e2e
```

`npm run e2e` drives the built page in Chromium. Set `CHROMIUM` if it is not at
`/usr/bin/chromium`.

## Licenses

The page ships QEMU (GPL-2.0) and Capstone (BSD, with LLVM-derived parts). Their
licenses are in `dist/vendor/`. If you host a build, you distribute QEMU and
must comply with the GPL-2.0, including making its source available.

RISC-V instruction descriptions come from the RISC-V Unified Database
instruction records, Copyright (c) Qualcomm Technologies, Inc. and/or its
subsidiaries, under BSD-3-Clause-Clear. The license is in
`dist/vendor/RISCV-UDB-LICENSE.txt`. The bundled descriptions use the resolved
database published 2026-10-08 from commit
`f9f7e6c08ecb397432c3deb587cd1dfa789ba51a`.

x86 and AArch64 instruction descriptions come from the InstructionSets
instruction dataset under CC0-1.0. The bundled snapshot was generated
2026-10-13. The compact records are in
`web/src/x86-instruction-help.json` and
`web/src/arm-instruction-help.json`; edit these files directly when
correcting a description.

s390x instruction forms are based on the Go
[`x/arch` opcode table](https://go.googlesource.com/arch/+/9d90945922a772f53487baa5b1b03f061aebb164/s390x/s390x.csv),
which is BSD-licensed and generated from IBM's z/Architecture Principles of Operation.
The concise descriptions are written for this project. The selected records
are in `web/src/s390x-instruction-help.json`; edit this file directly when
adding instructions or correcting a description.
