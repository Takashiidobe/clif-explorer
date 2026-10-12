#!/bin/sh
# runs the clif-wasm tests against one Cranelift version: scripts/check-cranelift-version.sh 0.137.0
set -e
version=$1
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/crates" "$work/web"
cp "$root/Cargo.toml" "$work/"
cp -r "$root/crates/clif-wasm" "$work/crates/"
cp -r "$root/web/frontend" "$work/web/"
sed -i "s/\"=[0-9][^\"]*\"/\"=$version\"/g" "$work/crates/clif-wasm/Cargo.toml"
cd "$work"
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$root/web/target/cargo-check} cargo test
