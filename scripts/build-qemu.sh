#!/bin/sh
# builds the four system emulators as wasm64 into build/qemu-wasm/out (raw output in build/qemu-wasm/raw)
# needs docker, wasm-opt and a QEMU checkout in third_party/qemu (tested at 615ece3c40, 11.1.50)
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
qemu=$root/third_party/qemu
raw=$root/build/qemu-wasm/raw
out=$root/build/qemu-wasm/out
targets="riscv64 x86_64 aarch64 s390x"

docker build -t qemu-emsdk-wasm64 -f "$qemu/tests/docker/dockerfiles/emsdk-wasm64-cross.docker" "$qemu/tests/docker/dockerfiles"
mkdir -p "$raw" "$out"

make_targets=""
target_list=""
for arch in $targets; do
  make_targets="$make_targets qemu-system-$arch.js"
  target_list="$target_list,$arch-softmmu"
done

# the source mount is writable because meson downloads the dtc subproject into it
docker run --rm -v "$qemu:/qemu" -v "$raw:/build" qemu-emsdk-wasm64 sh -c "
  set -e
  cd /build
  emconfigure /qemu/configure --static --cpu=wasm64 --disable-tools --disable-docs \
    --enable-tcg-interpreter \
    --target-list=${target_list#,}
  emmake make -j\$(nproc) $make_targets
"

cp "$qemu/COPYING" "$out/QEMU-LICENSE"
for arch in $targets; do
  cp "$raw/qemu-system-$arch.js" "$out/"
  wasm-opt "$raw/qemu-system-$arch.wasm" -Oz --strip-debug --strip-producers -o "$out/qemu-system-$arch.wasm" &
done
wait
