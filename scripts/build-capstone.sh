#!/bin/sh
# builds Capstone 6 for x86-64, aarch64, riscv64 and s390x into build/capstone-wasm/out
# needs docker, wasm-opt and the emscripten image made by build-qemu.sh
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
src=$root/third_party/capstone
out=$root/build/capstone-wasm/out
tag=6.0.0-Alpha11

[ -d "$src" ] || git clone --depth 1 --branch $tag https://github.com/capstone-engine/capstone.git "$src"
mkdir -p "$out"

docker run --rm -e OWNER="$(id -u):$(id -g)" -v "$src:/capstone" -v "$root/scripts/capstone:/wrapper:ro" -v "$out:/out" qemu-emsdk-wasm64 sh -c '
  set -e
  cd /out
  emcmake cmake /capstone -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DCAPSTONE_ARCHITECTURE_DEFAULT=OFF -DCAPSTONE_X86_SUPPORT=ON -DCAPSTONE_AARCH64_SUPPORT=ON \
    -DCAPSTONE_RISCV_SUPPORT=ON -DCAPSTONE_SYSTEMZ_SUPPORT=ON \
    -DCAPSTONE_BUILD_CSTOOL=OFF -DCAPSTONE_BUILD_TESTS=OFF -DCAPSTONE_BUILD_CSTEST=OFF -DCAPSTONE_BUILD_STATIC_LIBS=ON
  emmake make -j$(nproc) capstone_static
  emcc -Oz /wrapper/disasm.c libcapstone.a -I/capstone/include -o capstone.mjs \
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createCapstone -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString -sEXPORTED_FUNCTIONS=_malloc,_free
  chown -R $OWNER /out
'
wasm-opt "$out/capstone.wasm" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --strip-debug --strip-producers -o "$out/capstone.wasm"
cat "$src/LICENSES/LICENSE.TXT" "$src/LICENSES/LICENSE_LLVM.TXT" > "$out/CAPSTONE-LICENSE"
