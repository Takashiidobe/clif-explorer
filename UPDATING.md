# Updating

Rebuild `web/dist` from source. Run every command from the repository root
unless noted.

## Requirements

- Rust with the `wasm32-unknown-unknown` target, and `wasm-pack`
- Node.js
- Docker
- `wasm-opt` (binaryen)
- `clang`, `ld.lld` and `llvm-objcopy`, only to regenerate the guest stubs

## Rebuild everything

1. Get QEMU. The build is tested at commit `615ece3c40`.

   ```sh
   git clone https://gitlab.com/qemu-project/qemu.git third_party/qemu
   git -C third_party/qemu checkout 615ece3c40
   ```

2. Build the emulators into `build/qemu-wasm/out`. This takes a long time.

   ```sh
   scripts/build-qemu.sh
   ```

3. Build the disassembler into `build/capstone-wasm/out`. It clones Capstone
   itself and needs the docker image from step 2.

   ```sh
   scripts/build-capstone.sh
   ```

4. Build the page into `web/dist`.

   ```sh
   cd web
   npm install
   npm run build
   ```

5. Check it.

   ```sh
   npm test
   npm run serve
   ```

   Open <http://127.0.0.1:8000> and run an example on each target. `npm run e2e`
   does the same in Chromium.

`npm run build` rebuilds the Cranelift wasm only when `crates/clif-wasm` is
newer than the last build. It takes about three minutes.

## Update a component

- **Cranelift**: add the version to `web/versions.json`, then repeat step 4.
  Versions are never removed, so old share links keep working. Commit
  `web/versions.json` and the new file in `web/locks/`. The weekly workflow does
  this for each new crates.io release; see below.
- **QEMU**: check out the new commit in `third_party/qemu`, update the commit in
  the header of `scripts/build-qemu.sh`, then repeat steps 2 and 4.
- **Capstone**: change `tag` in `scripts/build-capstone.sh`, delete
  `third_party/capstone`, then repeat steps 3 and 4.
- **Guest stubs**: edit the sources in `web/stubs/`, then run
  `node web/stubs/build.mjs`. It rewrites `web/src/stubs.mjs`. Repeat step 4.

## Outputs

- `web/dist`: the site. Deploy this directory.
- `build/qemu-wasm/raw`: unoptimized QEMU output. `out` holds the `wasm-opt`
  results.
- `build/capstone-wasm/out`: the disassembler.

Rebuild `web/dist` after any change to these.

## Weekly deploy

`.github/workflows/update-cranelift.yml` runs every Monday. If crates.io has a
new Cranelift release (0.136.0 or later, no pre-releases), it tests the release,
builds `web/dist`, deploys it to Netlify, and commits `web/versions.json` and
`web/locks/`. If the tests fail, it opens an issue instead. Run it by hand from
the Actions tab; check **force** to redeploy with no new release.

Set up once:

1. Add the repository secrets `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`.
2. Build the emulators locally (steps 2 and 3 above), then upload them:

   ```sh
   scripts/package-emulators.sh
   ```

   The workflow downloads them from the `emulators` release. Run this again
   whenever you rebuild QEMU or Capstone.
