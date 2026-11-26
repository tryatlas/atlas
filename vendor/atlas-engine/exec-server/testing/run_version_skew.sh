#!/usr/bin/env bash
# Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.

set -euo pipefail

engine_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Atlas has its own Noise domain and executable layout. A Codex release is not
# an Atlas protocol baseline. Pass a prior Atlas-compatible driver for skew;
# without one, run the current/current protocol smoke check explicitly.
baseline="${ATLAS_AGENT_TEST_RELEASED_ATLAS_ENGINE:-}"
case "${1:-}" in
  "" | --current-only) ;;
  --baseline)
    baseline="${2:?--baseline requires an Atlas-compatible executable}"
    if [[ ! -x "${baseline}" ]]; then
      echo "Baseline executable does not exist or is not executable: ${baseline}" >&2
      exit 1
    fi
    baseline="$(cd "$(dirname "${baseline}")" && pwd)/$(basename "${baseline}")"
    ;;
  *)
    echo "Usage: $0 [--current-only | --baseline /path/to/atlas-engine-driver]" >&2
    exit 2
    ;;
esac
if [[ "${1:-}" == "--current-only" ]]; then
  baseline=""
fi
release_directory="$(mktemp -d "${TMPDIR:-/tmp}/atlas-engine-exec-server-skew.XXXXXX")"
trap 'rm -rf "${release_directory:?}"' EXIT

cd "${engine_root}"
cargo build --locked -p atlas-engine-app-server --bin atlas-engine-app-server
cargo build --locked -p atlas-engine-exec-server --example remote-executor
target_directory="$(cargo metadata --locked --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
export ATLAS_AGENT_TEST_APP_SERVER="${target_directory}/debug/atlas-engine-app-server"
export ATLAS_AGENT_TEST_CURRENT_ATLAS_ENGINE="${release_directory}/current-engine"
printf '#!/usr/bin/env bash\nset -euo pipefail\nmode="$1"; shift\ncase "$mode" in\n  app-server) exec %q "$@" ;;\n  exec-server) exec %q "$@" ;;\n  *) exit 2 ;;\nesac\n' \
  "${ATLAS_AGENT_TEST_APP_SERVER}" "${target_directory}/debug/examples/remote-executor" > "${ATLAS_AGENT_TEST_CURRENT_ATLAS_ENGINE}"
chmod 700 "${ATLAS_AGENT_TEST_CURRENT_ATLAS_ENGINE}"

echo "Testing the current Atlas engine in both Noise relay roles"
export ATLAS_AGENT_TEST_RELEASED_ATLAS_ENGINE="${ATLAS_AGENT_TEST_CURRENT_ATLAS_ENGINE}"
cargo test --locked -p atlas-engine-exec-server --test relay version_skew -- --include-ignored --test-threads 1

if [[ -n "${baseline}" ]]; then
  echo "Testing Atlas version skew against ${baseline}"
  export ATLAS_AGENT_TEST_RELEASED_ATLAS_ENGINE="${baseline}"
  cargo test --locked -p atlas-engine-exec-server --test relay version_skew -- --include-ignored --test-threads 1
else
  echo "Current/current protocol smoke check completed; use --baseline for version-skew coverage."
fi
