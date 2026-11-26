#!/usr/bin/env bash
# Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine_root="$(cd "$script_dir/../.." && pwd)"
proto_dir="$engine_root/config/src/thread_config/proto"
generated="$proto_dir/atlas_engine.thread_config.v1.rs"
tmpdir="$(mktemp -d)"

cleanup() {
    rm -rf "$tmpdir"
}
trap cleanup EXIT

(
    cd "$engine_root"
    cargo run --locked \
        -p atlas-engine-config \
        --example generate-proto \
        -- "$proto_dir"
)

if ! sed -n '2p' "$generated" | grep -q 'clippy::trivially_copy_pass_by_ref'; then
    {
        sed -n '1p' "$generated"
        printf '#![allow(clippy::trivially_copy_pass_by_ref)]\n'
        sed '1d' "$generated"
    } > "$tmpdir/generated.rs"
    mv "$tmpdir/generated.rs" "$generated"
fi

rustfmt --edition 2024 "$generated"

awk '
    NR == 3 && previous ~ /clippy::trivially_copy_pass_by_ref/ && $0 != "" { print "" }
    { print; previous = $0 }
' "$generated" > "$tmpdir/formatted.rs"
mv "$tmpdir/formatted.rs" "$generated"

# prost replaces the whole file, including the vendored source's notice.
{
    printf '%s\n' '// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.'
    cat "$generated"
} > "$tmpdir/noticed.rs"
mv "$tmpdir/noticed.rs" "$generated"
