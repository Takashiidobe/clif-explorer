#!/bin/sh
# uploads the QEMU and Capstone wasm builds to the "emulators" GitHub release for CI to download
# needs gh, and both builds already made by build-qemu.sh and build-capstone.sh
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
archive=$(mktemp -d)/emulators.tar.gz

cd "$root"
tar -czf "$archive" \
  build/qemu-wasm/out/QEMU-LICENSE build/qemu-wasm/out/qemu-system-*.js build/qemu-wasm/out/qemu-system-*.wasm \
  build/capstone-wasm/out/CAPSTONE-LICENSE build/capstone-wasm/out/capstone.mjs build/capstone-wasm/out/capstone.wasm

if gh release view emulators >/dev/null 2>&1; then
  gh release upload emulators "$archive" --clobber
else
  gh release create emulators "$archive" --title "Emulator builds" --notes "Prebuilt QEMU and Capstone wasm. Made by scripts/package-emulators.sh."
fi
