#!/bin/sh
# rebuilds Capstone and web/dist from source, reusing the QEMU build in build/qemu-wasm/out
# needs docker, wasm-opt, wasm-pack and the qemu-emsdk-wasm64 image made by scripts/build-qemu.sh
set -e
root=$(cd "$(dirname "$0")/.." && pwd)

[ -d "$root/build/qemu-wasm/out" ] || { echo "build/qemu-wasm/out is missing; run scripts/build-qemu.sh" >&2; exit 1; }
docker image inspect qemu-emsdk-wasm64 >/dev/null 2>&1 || { echo "docker image qemu-emsdk-wasm64 is missing; run scripts/build-qemu.sh" >&2; exit 1; }

"$root/scripts/build-capstone.sh"
cd "$root/web"
[ -d node_modules ] || npm ci
npm run build
