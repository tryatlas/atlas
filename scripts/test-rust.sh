#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# apple-sys needs the active macOS SDK while compiling native dependencies.
# Respect an explicitly selected SDK, otherwise use Xcode's current default.
if [[ "$(uname -s)" == "Darwin" && -z "${SDKROOT:-}" ]]; then
  export SDKROOT="$(xcrun --show-sdk-path)"
fi

# A SUBSET of CI, not a replica. CI (.github/workflows/ci.yml) is the
# authority; this is the quick local pass over the same test suites. For the
# replica — each crate from its own directory, clippy included — run
# `bun run ci:local`. What this leaves out:
#   - clippy. CI runs one pass per crate: `cargo clippy --locked --all-targets`,
#     plus `-- -D warnings` for the crates flagged `clippy: true` in the
#     matrix, and plain for the app. Run those by hand for a crate you touched.
#   - atlas-kb-server, which is workspace-excluded and compiled at runtime by
#     `knowledge_export`; CI tests it and builds its release profile.
#   - Linux-only paths (the engine's bubblewrap sandbox in engine_turn.rs):
#     a Mac run cannot exercise them. `bun run ci:local --linux atlas-native-agent` runs
#     that job in a Linux container.
#   - the frontend (`bun run test` and friends).
#
# One real difference in what it DOES run: the atlas-* crates are tested in
# one cargo invocation, where CI gives each crate its own job. Cargo unifies
# features across every package in an invocation, so a crate that only
# compiles because a sibling happens to enable a feature on a shared
# dependency passes here and fails in its CI job. When they disagree, the
# per-crate CI job is right.
#
# `--locked` everywhere, as in CI: a Cargo.lock that needs rewriting fails here
# instead of being silently updated.

# Three cargo invocations, not twenty. The old loop ran `cargo test` from
# inside every crates/* directory, which predates the workspace: each run was
# its own cargo start-up and fingerprint pass (and, before the workspace, its
# own target/). `--workspace --exclude` selects every member — the 22 Atlas
# crates, with their `tests/` dirs and doctests — minus the engine
# (`atlas-engine-*` and its two test-support crates; 64 of its manifests carry
# their own suites) and the app, which has its own invocation below. Not a
# `-p 'atlas-*'` glob: since ADR-0011 that also matches the engine.
echo "==> crates/atlas-* (unit + integration + doctests)"
cargo test --locked --workspace \
  --exclude 'atlas-engine-*' --exclude app_test_support --exclude core_test_support \
  --exclude atlas

# `--lib` only for the app crate, as in CI: every src-tauri test is a unit
# test in the lib, and `-p atlas` alone would also link the `atlas` binary's
# own test harness, a second full-size link to run nothing.
echo "==> src-tauri --lib"
cargo test --locked -p atlas --lib

# CI's `engine dialect (atlas-engine-api)` job: the Atlas-authored dialect plus the
# engine crates Atlas has edited. Keep this list equal to that job's `-p`
# list; tests/ci-coverage.test.ts checks it.
echo "==> engine dialect + edited engine crates"
cargo test --locked \
  -p atlas-engine-analytics \
  -p atlas-engine-api \
  -p atlas-engine-app-server-protocol \
  -p atlas-engine-apply-patch \
  -p atlas-engine-backend-client \
  -p atlas-engine-config \
  -p atlas-engine-core-plugins \
  -p atlas-engine-exec-server \
  -p atlas-engine-external-agent-migration \
  -p atlas-engine-feedback \
  -p atlas-engine-file-watcher \
  -p atlas-engine-git-utils \
  -p atlas-engine-hooks \
  -p atlas-engine-linux-sandbox \
  -p atlas-engine-login \
  -p atlas-engine-mcp \
  -p atlas-engine-model-provider \
  -p atlas-engine-models-manager \
  -p atlas-engine-network-proxy \
  -p atlas-engine-otel \
  -p atlas-engine-protocol \
  -p atlas-engine-rmcp-client \
  -p atlas-engine-rollout \
  -p atlas-engine-rollout-trace \
  -p atlas-engine-sandboxing \
  -p atlas-engine-shell-command \
  -p atlas-engine-shell-escalation \
  -p atlas-engine-skills \
  -p atlas-engine-skills-extension \
  -p atlas-engine-utils-cargo-bin \
  -p atlas-engine-utils-pty \
  -p atlas-engine-windows-sandbox

# Atlas runs the full core/app-server unit suites and the supported integration
# paths. Other upstream integration fixtures require the removed analytics
# sender, opt-in AWS support or standalone CLI helpers (see ci.yml).
cargo test --locked -p atlas-engine-core --lib
cargo test --locked -p atlas-engine-app-server --lib
cargo test --locked -p atlas-engine-core --test all -- suite::compact::
cargo test --locked -p atlas-engine-app-server --test all -- \
  suite::v2::turn_interrupt:: suite::v2::mcp_server_status::
