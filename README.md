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
- **Run**: call a function with integer arguments and see its return values or
  the trap it hit.

## Supported

- Targets: x86-64, aarch64, riscv64, s390x.
- Every Cranelift release since 0.136.0, chosen from the version menu.
- Cranelift flags for each target, set from the flags panel.
- Arguments and results of type `i64` or narrower. Up to 6 arguments on x86-64,
  8 on aarch64 and riscv64, and 5 on s390x.
- Calls between functions in the same program.
- Traps, reported with the Cranelift trap code and the instruction that raised
  it.
- Default, Emacs, and Vim keybindings in the editor.
- Your last program, Cranelift version, target, flags, and keybindings are
  restored when you revisit.
- Share links that restore the program, Cranelift version, target, and flags.

## Not supported

- Floats, vectors, `i128`, and stack arguments in `Run`. The Assembly tab shows
  all of them.
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
the function and writes the result to the serial port. One worker holds one
Cranelift version.

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
