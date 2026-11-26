# Codebase remediation implementation and verification

Review: 24 November 2026 · Verification updated: 25 November 2026 · Branch `maklu/codebase-remediation-20261124` · Baseline `ba48bdff24d8885104dcd30090ac5d1b60f5f3b4`.

All 448 retained finding IDs have an implementation recorded. This is a patch inventory, not a claim that every fix has passed verification. The researched [plan](2026-11-24-codebase-remediation-plan.md) retains the original confidence labels and acceptance cases. Several IDs describe the same defect.

## Completed verification — 25 November 2026

**Final run result: all 11 queued jobs finished; 10 passed and one failed. The full app-server integration target reported 59 failures, and the separately enabled redaction check reported three failures. The [exact list](#exact-failing-tests-from-completed-verification) below contains all 62 names. Earlier progress notes below are superseded by these completed results.**

Verification resumed at the maintainer's request against the existing working-tree changes. No new production-code fixes are being made during this pass. The 448-row index records implementation work, not 448 independently verified resolutions. Results from the fresh runs are being recorded in `/tmp/atlas-verification-20261125-resumed/`.

The refreshed skills, artifacts and remote-control suites passed **217 tests, zero failures and zero ignored**. Native skills Clippy and the Windows Git/skills cross-check passed. Formatting of the latest security fix and `git diff --check` passed too. The fresh application run passed **1,493 tests with six ignored**, the native catalog refresh passed **26 tests**, and the complete core-engine unit suite passed **2,207 tests with zero failures and zero ignored**. App-server and engine integration verification is still in progress.

**Explicitly running the three ignored memory-redaction regressions failed all three.** The current `atlas_memory::record::redact` preserves the fixture secrets in an Authorization Bearer header, `password: value`, and a YAML password field. These tests and their known-gap annotations predate this remediation; they are additional existing gaps, not a failure of the repaired skill-pack path protection. Reproduce with `cargo test --locked -p atlas --lib commands::memory_delta::tests:: -- --ignored --test-threads=1`. The fresh application binary produced **zero passed, three failed, zero ignored**; the log is `/tmp/atlas-verification-20261125-resumed/ignored-redaction.log`. See [the regression cases](../../src-tauri/src/commands/memory_delta.rs) and [the shared scrubber](../../crates/atlas-memory/src/record.rs).

Remaining work:

1. ~~**Fix the confirmed skill-pack unprojection vulnerability.**~~ **Fixed 2026-11-25.** `trusted_target` in `crates/atlas-skills/src/packs/projection.rs` recomputes each ledger entry's destination from the tool registry (kind, mode, leaf, both scopes, `env_override` included) and un-projection acts only on an exact match; anything else is dropped from the ledger without touching the disk. Symlinked tool dirs still work because the match is lexical. The regression `a_pack_ledger_entry_cannot_point_unprojection_outside_the_root` is no longer ignored and passes; `cargo test --locked -p atlas-skills` is green.
2. **Finish the engine acceptance runs.** Core units now passed all 2,207 tests. App-server units, compaction, and interruption/MCP acceptance have not completed their final reruns. The support-crate batch passed 4,232 tests.
3. ~~**Finish the native catalog refresh.**~~ **Passed 2026-11-25: 26 tests, zero failures and zero ignored.** The fresh application run also passed 1,493 active tests after the admission-semaphore and strict installed-settings-reader changes. The modified artifacts/remote-control HTTP fixtures passed in the fresh 217-test shared-crate run. The three explicit ignored-redaction failures above remain open.
4. ~~**Refresh Windows checks for Git and skills.**~~ **Passed 2026-11-25.** The original 12 portable crates passed cross-compilation/strict Clippy, and the latest Git/skills changes passed their Windows refresh. This checks compilation and lints, not native Windows execution.
5. **Run the repaired relay harness.** Execute `bash vendor/atlas-engine/exec-server/testing/run_version_skew.sh --current-only`; it was queued but not executed. True cross-version coverage additionally needs `--baseline /path/to/atlas-compatible-driver`.
6. **Triage the broader upstream app-server integration target.** Its exploratory run failed; some fixtures were corrected afterward, but the whole target has not been rerun successfully. Distinguish actual regressions from assumptions about removed analytics, optional AWS support and standalone helper binaries.
7. **Complete environment-specific acceptance.** Native macOS/Windows execution, signed updater installation, and distributed/server scenarios remain unverified here. Linux desktop checks passed, including restart and the exported knowledge-server binary.

An existing frontend expected failure also remains: [comment-anchor regression](../../src/features/chat/lib/comment-anchors.test.ts) (`stale entries while a new turn streams do not shift earlier rows`). The passing frontend suite includes that explicit expected failure; neither this test nor the three ignored memory-redaction cases was introduced by the remediation patch.

Commands used for resumed Rust verification:

```sh
cargo test --locked -p atlas-engine-core --lib
cargo test --locked -p atlas-engine-app-server --lib
cargo test --locked -p atlas-engine-core --test all -- suite::compact::
cargo test --locked -p atlas-engine-app-server --test all -- suite::v2::turn_interrupt:: suite::v2::mcp_server_status::
cargo test --locked -p atlas --lib
cargo test --locked -p atlas-native-agent --lib catalog_cache::
cargo test --locked -p atlas-artifacts -p atlas-remote-control --lib
cargo clippy --locked --all-targets --target aarch64-pc-windows-msvc -p atlas-git -p atlas-skills -- -D warnings
```

Native strict Clippy passed for the 21 affected crates requiring `-D warnings`. The follow-up Clippy run for the application and engine core-plugins also passed before stopping. The original failed shared-crate targets were corrected and passed a 687-test rerun. The previously ignored skill-pack unprojection regression has since been enabled and passed a focused recheck against the current implementation; that security defect is resolved.

## Verification snapshot

- Frontend: **6,748 tests passed across 633 files**, plus one existing expected failure (`bun run test --maxWorkers=5 --testTimeout=15000`). The larger timeout accommodates simultaneous Rust compilation; assertions are unchanged.
- Application backend: **1,493 tests passed**, six ignored (`cargo test --locked -p atlas --lib`), including memory-dream admission and releasing sessions without an advertised close RPC. The fresh run covers the admission-semaphore and strict installed-settings-reader changes. Three ignored redaction cases were then run explicitly and all failed, as detailed above; the normal green suite does not establish those cases.
- Browser: **52 browser checks passed across Chromium and WebKit**, covering session state, settings, Git conflicts, the command palette, onboarding, shell navigation, accessibility and Mermaid PNG export. Both exported PNGs were visually inspected. The browser backend mocks native I/O. Separately, **14 native Linux checks passed** through the actual desktop: file-copy protection, audio/video decoding, seeking and playback, media-lease revocation, knowledge export, clean shutdown and state restoration after a real process restart. The exported server binary also ran and served its embedded pages outside the source checkout.
- Production frontend build, lint, formatting and both TypeScript configurations passed. The final test-harness typecheck passed too. Rust formatting passed for all 329 changed/new Rust files, using each package's declared edition. The latest complete repository-contract run passed **538 tests**, including CI planning, licensing and no-upstream-telemetry checks.
- Native agent: **273 tests passed**, one ignored, including the gateway and real Linux sandbox turn suites. The latest catalog-cache changes subsequently passed their fresh **26-test** run. The shared-crate corrective suites and engine support suites passed; remaining core/app-server verification has resumed. Engine verification found a private-directory permission defect, product-name parsing incompatibility and stale/non-hermetic fixtures; the support-crate corrections passed, while the core/app-server reruns are still pending. The earlier app-server preflight passed 265 tests and exposed two ported fixture errors (an identifier containing a space and a renamed trace attribute); both expectations are corrected for the final rerun. An early run of already-built shared-crate test executables also caught a checkpoint migration recovery error; table creation is now idempotent, and stale test fixtures/expectations were corrected before the fresh Cargo run.
- Native Clippy with `-D warnings` passed for all 21 affected crates that require the strict CI gate. Application and engine-plugin Clippy follow-ups passed too. Windows cross-compilation and Clippy with `-D warnings` passed for all 12 affected crates marked portable in the CI matrix; the subsequently edited Git and skills crates passed their fresh Windows check too. A separate compile probe checked the actual clipboard and no-replace rename implementations against the pinned Windows bindings. These checks establish target/API compatibility, not a successful Windows application build or native execution.
- The repaired protocol-generation script was exercised twice against temporary proto fixtures using the Cargo-built generator; both outputs exactly matched the checked-in generated file, including its attribution notice. The 15 vendor-licensing contract tests passed afterward.
- Native macOS and Windows execution, signed updater installation and distributed/server acceptance cases require their respective environments. Unit tests and Linux execution do not establish those results.

## Reproducing the completed frontend and portability checks

```sh
bun run lint
bun run format:check
bun run typecheck
bun run test --maxWorkers=5 --testTimeout=15000
bun run build:vite
bun run test:e2e
cargo clippy --locked --all-targets --target aarch64-pc-windows-msvc \
  -p atlas-acp-thread -p atlas-agent-delta -p atlas-process -p atlas-fs \
  -p atlas-agent-servers -p atlas-git -p atlas-gitdiff -p atlas-instruction-sync \
  -p atlas-redact -p atlas-skills -p atlas-terminal -p atlas-theme -- -D warnings
```

The browser runs used the repository's Playwright configuration with a temporary port/output-directory override and an isolated WebKit launcher for missing host libraries. No system package changes were required. The native smoke-check environment is Ubuntu 26.04.1, x86_64, WebKitGTK 2.52.6 and GStreamer 1.28.2; its data/config/cache directories are temporary and separate from the user's installation.

## Engine acceptance scope

The expanded CI job runs full suites for the edited support crates, the complete core and app-server unit suites, and the compaction, turn-interruption and MCP app-server integration suites. The final support-crate batch passed **4,232 tests with zero failures and 12 ignored**. The fresh core-engine unit run passed **2,207 tests with zero failures and zero ignored**; app-server units and the integration runs are pending. The native-agent job separately exercises the embedded engine through Atlas's connection, including real Linux sandboxed turns.

An exploratory run of the entire upstream app-server integration target has **not passed**. Some cases expect the intentionally removed upstream analytics uploader, AWS support that is disabled in this build, or standalone code-mode helper binaries outside Atlas's shipped runtime. These assumptions are visible in `vendor/atlas-engine/analytics/src/client.rs`, `vendor/atlas-engine/model-provider/Cargo.toml`, and the app-server code-mode fixture. That broader run is diagnostic evidence, not a successful acceptance gate. The retained CI suites exercise the remediation paths without reintroducing those services. Command-output fixtures now use non-login shells, and the OAuth registration fixture returns the redirect metadata required by the pinned SDK.

Preflight runs of freshly built unit binaries also found mismatched MCP span field names, a hosted MCP URL changed by branding, a fallible optional-binary lookup that panicked with the pinned `assert_cmd`, and stale fixture expectations. The implementation and fixtures are corrected. The support-crate fixes passed their final Cargo run; core and app-server verification is still pending. The upstream analytics assertion now verifies that subagent lineage is never uploaded, even when local analytics recording is requested. The stalled-response fixture now consumes its HTTP request before replying: a probe against the pinned HTTP client reproduced the original early connection error and confirmed the corrected fixture reaches the body timeout.

The support-crate verification exposed an issuer error-code mismatch and a dependency on an unbuilt CLI. Both are fixed and verified in the final passing batch, including the real remote executor round trip. A shared-crate compile also found a test that had not acquired the memory corpus's new mutex before calling it; that test is corrected, and its fresh Cargo run passed.

The complete shared-crate run then passed 2,273 tests and failed four. All four affected crates passed their corrective rerun: **687 passed, zero failed, one ignored**. The fixes preserve empty Git operations, link delayed shell captures only to their originating Session, reject external skill links, and register whole-directory swaps in the file-replacement audit. An additional real filesystem fixture reproduced a symlink-chain escape that lexical checks missed; installation now checks the resolved existing prefix too, including dangling targets, while preserving the previous installation on refusal.

The first native desktop compilation exposed `tempfile` being available only to tests despite the new knowledge export using it at runtime. Its existing dependency was moved to the runtime section, and the desktop subsequently built and passed the native checks. The probe verified the real knowledge-server export, its camelCase result and stored note titles. First launch and restart both exited with status zero.

## Exact failing tests from completed verification

Completed on 25 November 2026. All 11 queued jobs finished: **10 passed and one failed**. The broader app-server integration target finished with **861 passed, 59 failed and one ignored**. The separately enabled memory-redaction check finished with **zero passed, three failed and zero ignored**. These are **62 failing test cases**, not a count of distinct defects or unresolved review findings. No new tests or fixes were started to produce this list.

### Memory redaction — 3 failures

Source: [memory_delta.rs](../../src-tauri/src/commands/memory_delta.rs). These existing tests are normally ignored; this verification pass ran them explicitly.

```text
commands::memory_delta::tests::bearer_token_in_an_authorization_header_is_redacted
commands::memory_delta::tests::password_after_a_colon_and_space_is_redacted
commands::memory_delta::tests::password_field_in_yaml_is_redacted
```

Reproduce:

```sh
cargo test --locked -p atlas --lib commands::memory_delta::tests:: -- --ignored --test-threads=1
```

### App-server integration — 59 failures

Reproduce the full target:

```sh
cargo test --locked --no-fail-fast -p atlas-engine-app-server --test all
```

**account — 9** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/account.rs)

```text
suite::v2::account::account_reads_use_startup_config_when_config_reload_fails
suite::v2::account::get_account_with_aws_provider
suite::v2::account::get_account_with_managed_bedrock_provider
suite::v2::account::get_account_with_user_managed_bedrock_provider
suite::v2::account::login_amazon_bedrock_allows_bedrock_provider_override
suite::v2::account::login_amazon_bedrock_rejects_non_bedrock_provider_override_without_changes
suite::v2::account::login_amazon_bedrock_replaces_primary_auth_and_persists_provider
suite::v2::account::login_managed_bedrock_updates_active_bedrock_account
suite::v2::account::logout_managed_bedrock_restores_default_account
```

**analytics — 5** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/analytics.rs)

```text
suite::v2::analytics::classic_plugin_script_emits_measurement_analytics
suite::v2::analytics::remote_unified_background_plugin_script_emits_measurements_after_turn_completion
suite::v2::analytics::remote_unified_plugin_script_emits_measurement_analytics
suite::v2::analytics::unified_background_plugin_script_emits_measurements_after_turn_completion
suite::v2::analytics::unified_plugin_script_emits_measurement_analytics
```

**code_mode_host — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/code_mode_host.rs)

```text
suite::v2::code_mode_host::app_server_shares_flag_selected_code_mode_host_across_threads
suite::v2::code_mode_host::app_server_shares_flag_selected_grpc_code_mode_host_across_threads
```

**curated_mcp_sync — 1** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/curated_mcp_sync.rs)

```text
suite::v2::curated_mcp_sync::existing_thread_loads_api_curated_mcp_after_auth_switch_sync
```

**executor_mcp — 1** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/executor_mcp.rs)

```text
suite::v2::executor_mcp::selected_executor_plugin_exposes_its_mcps_only_to_that_thread
```

**external_agent_config — 4** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/external_agent_config.rs)

```text
suite::v2::external_agent_config::external_agent_config_import_completed_tracks_analytics_event
suite::v2::external_agent_config::external_agent_config_import_reinstalls_plugins_from_known_marketplaces
suite::v2::external_agent_config::external_agent_config_import_reports_failed_sync_import_in_completion
suite::v2::external_agent_config::external_agent_config_import_reports_session_config_error_subtype
```

**git_attribution — 3** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/git_attribution.rs)

```text
suite::v2::git_attribution::cold_resume_replaces_legacy_attribution_without_duplication::test_case_1_commit_only
suite::v2::git_attribution::cold_resume_replaces_legacy_attribution_without_duplication::test_case_2_unlinked_pull_request
suite::v2::git_attribution::git_attribution_follows_authenticated_workspace_policy
```

**imagegen_extension — 1** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/imagegen_extension.rs)

```text
suite::v2::imagegen_extension::standalone_image_generation_is_callable_from_code_mode_only
```

**model_provider_capabilities_read — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/model_provider_capabilities_read.rs)

```text
suite::v2::model_provider_capabilities_read::read_amazon_bedrock_provider_capabilities
suite::v2::model_provider_capabilities_read::read_amazon_bedrock_runtime_provider_capabilities
```

**plugin_install — 9** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/plugin_install.rs)

```text
suite::v2::plugin_install::plugin_install_failure_tracks_analytics_event
suite::v2::plugin_install::plugin_install_preserves_status_when_remote_bundle_error_body_is_too_large
suite::v2::plugin_install::plugin_install_rejects_remote_plugin_disabled_by_admin_before_download
suite::v2::plugin_install::plugin_install_rejects_remote_plugin_not_available
suite::v2::plugin_install::plugin_install_tracks_analytics_event
suite::v2::plugin_install::plugin_install_tracks_analytics_when_marketplace_file_cannot_be_read
suite::v2::plugin_install::plugin_install_tracks_analytics_when_remote_detail_fetch_fails
suite::v2::plugin_install::plugin_install_tracks_analytics_when_remote_install_is_rate_limited
suite::v2::plugin_install::plugin_install_tracks_remote_plugin_analytics_event
```

**plugin_uninstall — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/plugin_uninstall.rs)

```text
suite::v2::plugin_uninstall::plugin_uninstall_tracks_analytics_event
suite::v2::plugin_uninstall::plugin_uninstall_writes_remote_plugin_to_cloud_when_remote_plugin_enabled
```

**selected_capability_stack — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/selected_capability_stack.rs)

```text
suite::v2::selected_capability_stack::selected_capabilities_become_available_between_samples_in_one_turn
suite::v2::selected_capability_stack::selected_capability_stack_tracks_environment_availability_and_resume
```

**thread_archive — 1** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/thread_archive.rs)

```text
suite::v2::thread_archive::thread_archive_succeeds_when_descendant_archive_fails
```

**thread_fork — 1** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/thread_fork.rs)

```text
suite::v2::thread_fork::thread_fork_tracks_thread_initialized_analytics
```

**thread_resume — 4** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/thread_resume.rs)

```text
suite::v2::thread_resume::thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal
suite::v2::thread_resume::thread_resume_rejects_archived_session_by_id
suite::v2::thread_resume::thread_resume_running_thread_tracks_thread_originator_in_analytics
suite::v2::thread_resume::thread_resume_tracks_thread_initialized_analytics
```

**thread_shell_command — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/thread_shell_command.rs)

```text
suite::v2::thread_shell_command::thread_shell_command_history_responses_exclude_persisted_command_executions
suite::v2::thread_shell_command::thread_shell_command_uses_existing_active_turn
```

**thread_start — 4** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/thread_start.rs)

```text
suite::v2::thread_start::thread_start_bedrock_runtime_prefers_global_cross_region_models
suite::v2::thread_start::thread_start_provider_model_fallback_applies_to_configured_model
suite::v2::thread_start::thread_start_provider_model_fallback_uses_bedrock_static_catalog
suite::v2::thread_start::thread_start_tracks_thread_initialized_analytics
```

**turn_start — 4** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/turn_start.rs)

```text
suite::v2::turn_start::code_mode_exec_emits_correlated_production_analytics
suite::v2::turn_start::turn_profile_tracks_blocking_tool_and_follow_up_sampling
suite::v2::turn_start::turn_start_emits_thread_scoped_warning_notification_for_trimmed_skills
suite::v2::turn_start::turn_start_tracks_thread_originator_in_analytics
```

**turn_steer — 2** · [source](../../vendor/atlas-engine/app-server/tests/suite/v2/turn_steer.rs)

```text
suite::v2::turn_steer::turn_steer_requires_active_turn
suite::v2::turn_steer::turn_steer_returns_active_turn_id
```

Raw logs: `/tmp/atlas-verification-20261125-resumed/app-server-integration.log` and `/tmp/atlas-verification-20261125-resumed/ignored-redaction.log`.

## Research used during implementation

- Windows clipboard file transfers use `CF_HDROP` and `DragQueryFileW`; the implementation reads the clipboard while owned and closes it on every path. [Microsoft Shell clipboard formats](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard), [clipboard ownership](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations).
- Mermaid supports disabling HTML labels. The exporter now requests SVG text labels and surfaces export failures; WebKit SVG images containing `foreignObject` were the relevant canvas limitation. [Mermaid configuration](https://mermaid.js.org/config/schema-docs/config.html), [WebKit issue 180301](https://bugs.webkit.org/show_bug.cgi?id=180301).
- `AltGraph` is not a portable synonym for Windows AltGr: Firefox reports it for macOS Option too. The guard is restricted to non-Mac keyboards. [Mozilla modifier-state documentation](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState).
- Hosted ChatGPT MCP service paths remain `/api/codex/ps/mcp` for a custom origin and `/backend-api/ps/mcp` for ChatGPT. These are service contracts, not product branding. Explicitly configured Atlas proxy prefixes remain supported. [OpenAI's MCP URL implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/mcp/mod.rs).
- OAuth's `missing_codex_entitlement` error is likewise an issuer-defined identifier. It now selects Atlas's actionable access-denied page while preserving the existing Atlas alias. [OpenAI's callback error handling](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs).
- The pinned dependency source, the repository contracts and temporary local fixtures supplied implementation evidence for filesystem, IPC, process and persistence behavior. Other primary sources and the server revision inspected are linked in the researched plan.

## Finding index

“Implemented” below means the changes are in the working tree. The site is the reported module or the shared boundary that fixes it. Passing module tests support the implementation; they are not substitutes for the platform and end-to-end acceptance checks above.

| Finding   | Priority | Implementation site                                                                                                                                                                               | Status                                |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A000-01   | P1       | [.github/workflows/release.yml](../../.github/workflows/release.yml)                                                                                                                              | Implemented; verification in progress |
| A000-02   | P3       | [.github/workflows/ci.yml](../../.github/workflows/ci.yml)                                                                                                                                        | Implemented; verification in progress |
| A000-03   | P3       | [.github/workflows/ci.yml](../../.github/workflows/ci.yml)                                                                                                                                        | Implemented; verification in progress |
| A000-04   | P3       | [.github/workflows/ci.yml](../../.github/workflows/ci.yml)                                                                                                                                        | Implemented; verification in progress |
| A000-05   | P3       | [scripts/app-icons.mjs](../../scripts/app-icons.mjs)                                                                                                                                              | Implemented; verification in progress |
| A001-01   | P3       | [crates/atlas-acp-thread/src/thread.rs](../../crates/atlas-acp-thread/src/thread.rs)                                                                                                              | Implemented; verification in progress |
| A001-02   | P3       | [crates/atlas-acp-thread/src/thread.rs](../../crates/atlas-acp-thread/src/thread.rs)                                                                                                              | Implemented; verification in progress |
| A001-03   | P3       | [crates/atlas-acp-thread/src/thread.rs](../../crates/atlas-acp-thread/src/thread.rs)                                                                                                              | Implemented; verification in progress |
| A002-01   | P1       | [crates/atlas-agent-delta/src/projector.rs](../../crates/atlas-agent-delta/src/projector.rs)                                                                                                      | Implemented; verification in progress |
| A002-02   | P1       | [crates/atlas-agent-delta/src/projector.rs](../../crates/atlas-agent-delta/src/projector.rs)                                                                                                      | Implemented; verification in progress |
| A003-01   | P1       | [crates/atlas-agent-servers/src/handlers.rs](../../crates/atlas-agent-servers/src/handlers.rs)                                                                                                    | Implemented; verification in progress |
| A003-02   | P1       | [crates/atlas-agent-servers/src/handlers.rs](../../crates/atlas-agent-servers/src/handlers.rs)                                                                                                    | Implemented; verification in progress |
| A003-03   | P3       | [crates/atlas-agent-servers/src/handlers.rs](../../crates/atlas-agent-servers/src/handlers.rs)                                                                                                    | Implemented; verification in progress |
| A003-04   | P1       | [crates/atlas-agent-servers/src/host_env.rs](../../crates/atlas-agent-servers/src/host_env.rs)                                                                                                    | Implemented; verification in progress |
| A003-05   | P3       | [crates/atlas-agent-servers/src/connection.rs](../../crates/atlas-agent-servers/src/connection.rs)                                                                                                | Implemented; verification in progress |
| A004-01   | P1       | [crates/atlas-agent-store/src/store.rs](../../crates/atlas-agent-store/src/store.rs)                                                                                                              | Implemented; verification in progress |
| A004-02   | P1       | [crates/atlas-agent-store/src/servers.rs](../../crates/atlas-agent-store/src/servers.rs)                                                                                                          | Implemented; verification in progress |
| A004-03   | P2       | [crates/atlas-agent-store/src/servers.rs](../../crates/atlas-agent-store/src/servers.rs)                                                                                                          | Implemented; verification in progress |
| A004-04   | P3       | [crates/atlas-agent-store/src/servers.rs](../../crates/atlas-agent-store/src/servers.rs)                                                                                                          | Implemented; verification in progress |
| A005-01   | P1       | [crates/atlas-artifacts/src/client.rs](../../crates/atlas-artifacts/src/client.rs)                                                                                                                | Implemented; verification in progress |
| A005-02   | P1       | [crates/atlas-artifacts/src/client.rs](../../crates/atlas-artifacts/src/client.rs)                                                                                                                | Implemented; verification in progress |
| A005-03   | P3       | [crates/atlas-artifacts/src/board.rs](../../crates/atlas-artifacts/src/board.rs)                                                                                                                  | Implemented; verification in progress |
| A006-01   | P0       | [crates/atlas-checkpoint/src/capture.rs](../../crates/atlas-checkpoint/src/capture.rs)                                                                                                            | Implemented; verification in progress |
| A006-02   | P1       | [crates/atlas-checkpoint/src/binding.rs](../../crates/atlas-checkpoint/src/binding.rs)                                                                                                            | Implemented; verification in progress |
| A006-03   | P1       | [crates/atlas-checkpoint/src/checkpoint.rs](../../crates/atlas-checkpoint/src/checkpoint.rs)                                                                                                      | Implemented; verification in progress |
| A006-04   | P1       | [crates/atlas-checkpoint/src/checkpoint.rs](../../crates/atlas-checkpoint/src/checkpoint.rs)                                                                                                      | Implemented; verification in progress |
| A006-05   | P1       | [crates/atlas-checkpoint/src/import.rs](../../crates/atlas-checkpoint/src/import.rs)                                                                                                              | Implemented; verification in progress |
| A007-01   | P1       | [crates/atlas-checkpoint/src/store.rs](../../crates/atlas-checkpoint/src/store.rs)                                                                                                                | Implemented; verification in progress |
| A007-02   | P3       | [crates/atlas-checkpoint/src/store.rs](../../crates/atlas-checkpoint/src/store.rs)                                                                                                                | Implemented; verification in progress |
| A007-03   | P3       | [crates/atlas-checkpoint/src/timeline.rs](../../crates/atlas-checkpoint/src/timeline.rs)                                                                                                          | Implemented; verification in progress |
| A007-04   | P1       | [crates/atlas-checkpoint/src/tools.rs](../../crates/atlas-checkpoint/src/tools.rs)                                                                                                                | Implemented; verification in progress |
| A008-01   | P1       | [crates/atlas-comms/src/rest.rs](../../crates/atlas-comms/src/rest.rs)                                                                                                                            | Implemented; verification in progress |
| A008-02   | P1       | [crates/atlas-comms/src/rest.rs](../../crates/atlas-comms/src/rest.rs)                                                                                                                            | Implemented; verification in progress |
| A008-03   | P1       | [crates/atlas-comms/src/manager.rs](../../crates/atlas-comms/src/manager.rs)                                                                                                                      | Implemented; verification in progress |
| A008-04   | P1       | [crates/atlas-comms/src/manager.rs](../../crates/atlas-comms/src/manager.rs)                                                                                                                      | Implemented; verification in progress |
| A008-05   | P1       | [crates/atlas-comms/src/manager.rs](../../crates/atlas-comms/src/manager.rs)                                                                                                                      | Implemented; verification in progress |
| A008-06   | P3       | [crates/atlas-comms/src/manager.rs](../../crates/atlas-comms/src/manager.rs)                                                                                                                      | Implemented; verification in progress |
| A008-07   | P2       | [crates/atlas-comms/src/conn.rs](../../crates/atlas-comms/src/conn.rs)                                                                                                                            | Implemented; verification in progress |
| A008-08   | P3       | [crates/atlas-comms/src/state.rs](../../crates/atlas-comms/src/state.rs)                                                                                                                          | Implemented; verification in progress |
| A009-01   | P0       | [crates/atlas-git/src/repo/worktree.rs](../../crates/atlas-git/src/repo/worktree.rs)                                                                                                              | Implemented; verification in progress |
| A009-02   | P1       | [crates/atlas-git/src/repo/history.rs](../../crates/atlas-git/src/repo/history.rs)                                                                                                                | Implemented; verification in progress |
| A009-03   | P1       | [crates/atlas-git/src/patch.rs](../../crates/atlas-git/src/patch.rs)                                                                                                                              | Implemented; verification in progress |
| A009-04   | P1       | [crates/atlas-git/src/repo/worktree.rs](../../crates/atlas-git/src/repo/worktree.rs)                                                                                                              | Implemented; verification in progress |
| A009-05   | P1       | [crates/atlas-git/src/patch.rs](../../crates/atlas-git/src/patch.rs)                                                                                                                              | Implemented; verification in progress |
| A009-06   | P2       | [crates/atlas-git/src/exec.rs](../../crates/atlas-git/src/exec.rs)                                                                                                                                | Implemented; verification in progress |
| A009-07   | P3       | [crates/atlas-git/src/exec.rs](../../crates/atlas-git/src/exec.rs)                                                                                                                                | Implemented; verification in progress |
| A010-01   | P1       | [crates/atlas-icon-theme/src/resolve.rs](../../crates/atlas-icon-theme/src/resolve.rs)                                                                                                            | Implemented; verification in progress |
| A010-02   | P3       | [crates/atlas-icon-theme/src/format.rs](../../crates/atlas-icon-theme/src/format.rs)                                                                                                              | Implemented; verification in progress |
| A011-01   | P1       | [crates/atlas-fs/src/lib.rs](../../crates/atlas-fs/src/lib.rs)                                                                                                                                    | Implemented; verification in progress |
| A011-02   | P2       | [crates/atlas-embed/src/lib.rs](../../crates/atlas-embed/src/lib.rs)                                                                                                                              | Implemented; verification in progress |
| A011-03   | P1       | [crates/atlas-gitdiff/src/engine.rs](../../crates/atlas-gitdiff/src/engine.rs)                                                                                                                    | Implemented; verification in progress |
| A012-01   | P1       | [crates/atlas-memory/src/lib.rs](../../crates/atlas-memory/src/lib.rs)                                                                                                                            | Implemented; verification in progress |
| A012-02   | P2       | [crates/atlas-memory/src/lib.rs](../../crates/atlas-memory/src/lib.rs)                                                                                                                            | Implemented; verification in progress |
| A012-03   | P1       | [crates/atlas-memory/src/citation.rs](../../crates/atlas-memory/src/citation.rs)                                                                                                                  | Implemented; verification in progress |
| A013-01   | P3       | [crates/atlas-memory/src/retrieve.rs](../../crates/atlas-memory/src/retrieve.rs)                                                                                                                  | Implemented; verification in progress |
| A013-02   | P3       | [crates/atlas-memory/src/record.rs](../../crates/atlas-memory/src/record.rs)                                                                                                                      | Implemented; verification in progress |
| A014-01   | P1       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A014-02   | P1       | [crates/atlas-native-agent/src/engine/catalog_cache.rs](../../crates/atlas-native-agent/src/engine/catalog_cache.rs)                                                                              | Implemented; verification in progress |
| A014-03   | P1       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A014-04   | P1       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A014-05   | P2       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A015-01   | P1       | [crates/atlas-native-agent/src/engine/replay.rs](../../crates/atlas-native-agent/src/engine/replay.rs)                                                                                            | Implemented; verification in progress |
| A015-03   | P3       | [crates/atlas-native-agent/src/engine/sink.rs](../../crates/atlas-native-agent/src/engine/sink.rs)                                                                                                | Implemented; verification in progress |
| A016-01   | P1       | [crates/atlas-redact/src/json.rs](../../crates/atlas-redact/src/json.rs)                                                                                                                          | Implemented; verification in progress |
| A016-02   | P1       | [crates/atlas-redact/src/lib.rs](../../crates/atlas-redact/src/lib.rs)                                                                                                                            | Implemented; verification in progress |
| A016-03   | P3       | [crates/atlas-redact/src/vendor.rs](../../crates/atlas-redact/src/vendor.rs)                                                                                                                      | Implemented; verification in progress |
| A017-01   | P1       | [crates/atlas-remote-control/src/host.rs](../../crates/atlas-remote-control/src/host.rs)                                                                                                          | Implemented; verification in progress |
| A017-02   | P3       | [crates/atlas-remote-control/src/rest.rs](../../crates/atlas-remote-control/src/rest.rs)                                                                                                          | Implemented; verification in progress |
| A018-01   | P1       | [crates/atlas-security/src/view.rs](../../crates/atlas-security/src/view.rs)                                                                                                                      | Implemented; verification in progress |
| A018-02   | P3       | [crates/atlas-security/src/map.rs](../../crates/atlas-security/src/map.rs)                                                                                                                        | Implemented; verification in progress |
| A019-01   | P1       | [crates/atlas-skills/src/disk.rs](../../crates/atlas-skills/src/disk.rs)                                                                                                                          | Implemented; verification in progress |
| A019-02   | P2       | [crates/atlas-skills/src/packs/source.rs](../../crates/atlas-skills/src/packs/source.rs)                                                                                                          | Implemented; verification in progress |
| A019-03   | P3       | [crates/atlas-skills/src/packs/projection.rs](../../crates/atlas-skills/src/packs/projection.rs)                                                                                                  | Implemented; verification in progress |
| A019-04   | P3       | [crates/atlas-skills/src/packs/projection.rs](../../crates/atlas-skills/src/packs/projection.rs)                                                                                                  | Implemented; verification in progress |
| A019-05   | P1       | [crates/atlas-skills/src/library.rs](../../crates/atlas-skills/src/library.rs)                                                                                                                    | Implemented; verification in progress |
| A020-01   | P1       | [crates/atlas-theme/src/import/mod.rs](../../crates/atlas-theme/src/import/mod.rs)                                                                                                                | Implemented; verification in progress |
| A020-02   | P3       | [crates/atlas-theme/src/import/css.rs](../../crates/atlas-theme/src/import/css.rs)                                                                                                                | Implemented; verification in progress |
| A020-03   | P3       | [crates/atlas-theme/src/import/css.rs](../../crates/atlas-theme/src/import/css.rs)                                                                                                                | Implemented; verification in progress |
| A021-02   | P3       | [crates/atlas-thread-metadata/src/import.rs](../../crates/atlas-thread-metadata/src/import.rs)                                                                                                    | Implemented; verification in progress |
| A022-01   | P0       | [crates/atlas-terminal/src/lib.rs](../../crates/atlas-terminal/src/lib.rs)                                                                                                                        | Implemented; verification in progress |
| A022-02   | P3       | [crates/atlas-instruction-sync/src/lib.rs](../../crates/atlas-instruction-sync/src/lib.rs)                                                                                                        | Implemented; verification in progress |
| A023-01   | P0       | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)                                                                                                                                                | Implemented; verification in progress |
| A023-02   | P1       | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)                                                                                                                                                | Implemented; verification in progress |
| A024-01   | P2       | [src-tauri/src/auth/core.rs](../../src-tauri/src/auth/core.rs)                                                                                                                                    | Implemented; verification in progress |
| A024-02   | P3       | [src-tauri/src/auth/core.rs](../../src-tauri/src/auth/core.rs)                                                                                                                                    | Implemented; verification in progress |
| A024-03   | P3       | [src-tauri/src/auth/core.rs](../../src-tauri/src/auth/core.rs)                                                                                                                                    | Implemented; verification in progress |
| A025-01   | P1       | [src-tauri/src/commands/agent_config.rs](../../src-tauri/src/commands/agent_config.rs)                                                                                                            | Implemented; verification in progress |
| A025-02   | P0       | [src-tauri/src/commands/agent_host.rs](../../src-tauri/src/commands/agent_host.rs)                                                                                                                | Implemented; verification in progress |
| A026-01   | P1       | [src-tauri/src/commands/agent_memory.rs](../../src-tauri/src/commands/agent_memory.rs)                                                                                                            | Implemented; verification in progress |
| A026-02   | P1       | [src-tauri/src/commands/agent_memory.rs](../../src-tauri/src/commands/agent_memory.rs)                                                                                                            | Implemented; verification in progress |
| A026-03   | P2       | [src-tauri/src/commands/agent_memory.rs](../../src-tauri/src/commands/agent_memory.rs)                                                                                                            | Implemented; verification in progress |
| A026-04   | P3       | [src-tauri/src/commands/agent_host/open_turns.rs](../../src-tauri/src/commands/agent_host/open_turns.rs)                                                                                          | Implemented; verification in progress |
| A027-01   | P2       | [src-tauri/src/commands/agents.rs](../../src-tauri/src/commands/agents.rs)                                                                                                                        | Implemented; verification in progress |
| A027-03   | P3       | [src-tauri/src/commands/agents.rs](../../src-tauri/src/commands/agents.rs)                                                                                                                        | Implemented; verification in progress |
| A028-01   | P2       | [src-tauri/src/commands/auth.rs](../../src-tauri/src/commands/auth.rs)                                                                                                                            | Implemented; verification in progress |
| A028-02   | P2       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| A028-03   | P3       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| A028-04   | P3       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| A028-05   | P3       | [src-tauri/src/commands/artifacts_cloud.rs](../../src-tauri/src/commands/artifacts_cloud.rs)                                                                                                      | Implemented; verification in progress |
| A029-01   | P1       | [src-tauri/src/commands/capture.rs](../../src-tauri/src/commands/capture.rs)                                                                                                                      | Implemented; verification in progress |
| A029-02   | P2       | [src-tauri/src/commands/capture.rs](../../src-tauri/src/commands/capture.rs)                                                                                                                      | Implemented; verification in progress |
| A029-04   | P3       | [src-tauri/src/commands/capture.rs](../../src-tauri/src/commands/capture.rs)                                                                                                                      | Implemented; verification in progress |
| A030-01   | P1       | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)                                                                                                                                                | Implemented; verification in progress |
| A030-02   | P3       | [src-tauri/src/commands/compose_prompt.rs](../../src-tauri/src/commands/compose_prompt.rs)                                                                                                        | Implemented; verification in progress |
| A030-03   | P1       | [src-tauri/src/commands/diff_preview.rs](../../src-tauri/src/commands/diff_preview.rs)                                                                                                            | Implemented; verification in progress |
| A031-01   | P1       | [src-tauri/src/commands/external_editor.rs](../../src-tauri/src/commands/external_editor.rs)                                                                                                      | Implemented; verification in progress |
| A031-02   | P1       | [src-tauri/src/commands/rc.rs](../../src-tauri/src/commands/rc.rs)                                                                                                                                | Implemented; verification in progress |
| A031-03   | P1       | [src-tauri/src/commands/plans.rs](../../src-tauri/src/commands/plans.rs)                                                                                                                          | Implemented; verification in progress |
| A032-01   | P1       | [src-tauri/src/commands/shell_profile.rs](../../src-tauri/src/commands/shell_profile.rs)                                                                                                          | Implemented; verification in progress |
| A032-02   | P1       | [src-tauri/src/commands/registry.rs](../../src-tauri/src/commands/registry.rs)                                                                                                                    | Implemented; verification in progress |
| A032-03   | P2       | [src-tauri/src/commands/registry.rs](../../src-tauri/src/commands/registry.rs)                                                                                                                    | Implemented; verification in progress |
| A032-04   | P3       | [src-tauri/src/commands/save_guard.rs](../../src-tauri/src/commands/save_guard.rs)                                                                                                                | Implemented; verification in progress |
| A033-01   | P3       | [src-tauri/src/commands/memory_dream.rs](../../src-tauri/src/commands/memory_dream.rs)                                                                                                            | Implemented; verification in progress |
| A033-02   | P3       | [src-tauri/src/commands/claude_memory_import.rs](../../src-tauri/src/commands/claude_memory_import.rs)                                                                                            | Implemented; verification in progress |
| A034-01   | P1       | [src-tauri/src/commands/memory_policy.rs](../../src-tauri/src/commands/memory_policy.rs)                                                                                                          | Implemented; verification in progress |
| A034-02   | P3       | [crates/atlas-memory/src/record.rs](../../crates/atlas-memory/src/record.rs)                                                                                                                      | Implemented; verification in progress |
| A034-03   | P0       | [src-tauri/src/commands/memory_policy.rs](../../src-tauri/src/commands/memory_policy.rs)                                                                                                          | Implemented; verification in progress |
| A034-04   | P2       | [src-tauri/src/commands/memory_graph.rs](../../src-tauri/src/commands/memory_graph.rs)                                                                                                            | Implemented; verification in progress |
| A034-05   | P2       | [src-tauri/src/commands/memory_indexer.rs](../../src-tauri/src/commands/memory_indexer.rs)                                                                                                        | Implemented; verification in progress |
| A035-01   | P1       | [src-tauri/src/commands/memory_sharing.rs](../../src-tauri/src/commands/memory_sharing.rs)                                                                                                        | Implemented; verification in progress |
| A035-02   | P3       | [src-tauri/src/commands/memory_sharing.rs](../../src-tauri/src/commands/memory_sharing.rs)                                                                                                        | Implemented; verification in progress |
| A035-03   | P3       | [src-tauri/src/commands/shared_memory.rs](../../src-tauri/src/commands/shared_memory.rs)                                                                                                          | Implemented; verification in progress |
| A036-01   | P2       | [src-tauri/src/commands/fileindex.rs](../../src-tauri/src/commands/fileindex.rs)                                                                                                                  | Implemented; verification in progress |
| A036-02   | P3       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| A036-03   | P3       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| A037-01   | P1       | [src-tauri/src/commands/git_watcher.rs](../../src-tauri/src/commands/git_watcher.rs)                                                                                                              | Implemented; verification in progress |
| A037-03   | P3       | [src-tauri/src/commands/github.rs](../../src-tauri/src/commands/github.rs)                                                                                                                        | Implemented; verification in progress |
| A037-04   | P3       | [src-tauri/src/commands/github.rs](../../src-tauri/src/commands/github.rs)                                                                                                                        | Implemented; verification in progress |
| A038-01   | P2       | [src-tauri/src/commands/org_server/tools/mod.rs](../../src-tauri/src/commands/org_server/tools/mod.rs)                                                                                            | Implemented; verification in progress |
| A039-01   | P1       | [src-tauri/src/commands/knowledge_export.rs](../../src-tauri/src/commands/knowledge_export.rs)                                                                                                    | Implemented; verification in progress |
| A039-02   | P3       | [src-tauri/src/commands/knowledge_export.rs](../../src-tauri/src/commands/knowledge_export.rs)                                                                                                    | Implemented; verification in progress |
| A039-03   | P3       | [src-tauri/src/commands/knowledge_export.rs](../../src-tauri/src/commands/knowledge_export.rs)                                                                                                    | Implemented; verification in progress |
| A039-04   | P1       | [src-tauri/src/commands/knowledge.rs](../../src-tauri/src/commands/knowledge.rs)                                                                                                                  | Implemented; verification in progress |
| A039-05   | P0       | [src-tauri/src/commands/knowledge_meta.rs](../../src-tauri/src/commands/knowledge_meta.rs)                                                                                                        | Implemented; verification in progress |
| A039-06   | P2       | [src-tauri/src/commands/modelchat.rs](../../src-tauri/src/commands/modelchat.rs)                                                                                                                  | Implemented; verification in progress |
| A039-07   | P2       | [src-tauri/src/commands/models_pricing.rs](../../src-tauri/src/commands/models_pricing.rs)                                                                                                        | Implemented; verification in progress |
| A040-01   | P3       | [src-tauri/src/commands/pull_requests/github.rs](../../src-tauri/src/commands/pull_requests/github.rs)                                                                                            | Implemented; verification in progress |
| A040-02   | P2       | [src-tauri/src/commands/pull_request_watch.rs](../../src-tauri/src/commands/pull_request_watch.rs)                                                                                                | Implemented; verification in progress |
| A041-01   | P1       | [src-tauri/src/commands/pull_requests/guide.rs](../../src-tauri/src/commands/pull_requests/guide.rs)                                                                                              | Implemented; verification in progress |
| A041-02   | P3       | [src-tauri/src/commands/pull_requests/parse.rs](../../src-tauri/src/commands/pull_requests/parse.rs)                                                                                              | Implemented; verification in progress |
| A042-01   | P0       | [src-tauri/src/commands/session_chat.rs](../../src-tauri/src/commands/session_chat.rs)                                                                                                            | Implemented; verification in progress |
| A043-01   | P1       | [src-tauri/src/commands/updater_macos.rs](../../src-tauri/src/commands/updater_macos.rs)                                                                                                          | Implemented; verification in progress |
| A043-02   | P3       | [src/features/projects/lib/project-icon.ts](../../src/features/projects/lib/project-icon.ts)                                                                                                      | Implemented; verification in progress |
| A045-01   | P1       | [src-tauri/src/telemetry/mod.rs](../../src-tauri/src/telemetry/mod.rs)                                                                                                                            | Implemented; verification in progress |
| A045-02   | P2       | [src-tauri/src/telemetry/mod.rs](../../src-tauri/src/telemetry/mod.rs)                                                                                                                            | Implemented; verification in progress |
| A046-01   | P3       | [src/components/mermaid-block.tsx](../../src/components/mermaid-block.tsx)                                                                                                                        | Implemented; verification in progress |
| A046-02   | P3       | [src/components/titlebar.tsx](../../src/components/titlebar.tsx)                                                                                                                                  | Implemented; verification in progress |
| A047-01   | P1       | [src/features/agents/stores/agent-registry-store.ts](../../src/features/agents/stores/agent-registry-store.ts)                                                                                    | Implemented; verification in progress |
| A047-02   | P2       | [src/features/agents/lib/agent-update.ts](../../src/features/agents/lib/agent-update.ts)                                                                                                          | Implemented; verification in progress |
| A047-03   | P3       | [src/features/agents/components/agent-oauth-modal.tsx](../../src/features/agents/components/agent-oauth-modal.tsx)                                                                                | Implemented; verification in progress |
| A048-01   | P1       | [src/features/artifacts/components/share-morph.tsx](../../src/features/artifacts/components/share-morph.tsx)                                                                                      | Implemented; verification in progress |
| A048-02   | P1       | [src/features/artifacts/components/share-morph.tsx](../../src/features/artifacts/components/share-morph.tsx)                                                                                      | Implemented; verification in progress |
| A048-03   | P3       | [src/features/artifacts/components/views/comment-row-view.tsx](../../src/features/artifacts/components/views/comment-row-view.tsx)                                                                | Implemented; verification in progress |
| A048-04   | P3       | [src/features/artifacts/components/views/comment-composer-view.tsx](../../src/features/artifacts/components/views/comment-composer-view.tsx)                                                      | Implemented; verification in progress |
| A048-05   | P3       | [src/features/artifacts/components/comments-morph.tsx](../../src/features/artifacts/components/comments-morph.tsx)                                                                                | Implemented; verification in progress |
| A048-06   | P3       | [src/features/artifacts/components/session-show-full.tsx](../../src/features/artifacts/components/session-show-full.tsx)                                                                          | Implemented; verification in progress |
| A048-07   | P3       | [src/features/artifacts/components/session-chat-panel.tsx](../../src/features/artifacts/components/session-chat-panel.tsx)                                                                        | Implemented; verification in progress |
| A049-01   | P1       | [src/features/artifacts/lib/use-open-session-detail.ts](../../src/features/artifacts/lib/use-open-session-detail.ts)                                                                              | Implemented; verification in progress |
| A049-02   | P1       | [src/features/artifacts/lib/use-session-detail.ts](../../src/features/artifacts/lib/use-session-detail.ts)                                                                                        | Implemented; verification in progress |
| A049-03   | P1       | [src/features/artifacts/lib/export.ts](../../src/features/artifacts/lib/export.ts)                                                                                                                | Implemented; verification in progress |
| A049-04   | P3       | [src/features/artifacts/lib/use-session-comments.ts](../../src/features/artifacts/lib/use-session-comments.ts)                                                                                    | Implemented; verification in progress |
| A049-05   | P3       | [src/features/artifacts/stores/session-chat-store.ts](../../src/features/artifacts/stores/session-chat-store.ts)                                                                                  | Implemented; verification in progress |
| A049-06   | P3       | [src/features/artifacts/lib/use-open-session-detail.ts](../../src/features/artifacts/lib/use-open-session-detail.ts)                                                                              | Implemented; verification in progress |
| A050-01   | P1       | [src/features/browser/lib/use-live-embed.ts](../../src/features/browser/lib/use-live-embed.ts)                                                                                                    | Implemented; verification in progress |
| A050-02   | P1       | [src/features/ui-actions/lib/ui-open.ts](../../src/features/ui-actions/lib/ui-open.ts)                                                                                                            | Implemented; verification in progress |
| A050-03   | P1       | [src/features/auth/stores/auth-store.ts](../../src/features/auth/stores/auth-store.ts)                                                                                                            | Implemented; verification in progress |
| A050-04   | P2       | [src/features/browser/lib/use-live-embed.ts](../../src/features/browser/lib/use-live-embed.ts)                                                                                                    | Implemented; verification in progress |
| A050-05   | P3       | [src/features/browser/components/browser-panel.tsx](../../src/features/browser/components/browser-panel.tsx)                                                                                      | Implemented; verification in progress |
| A050-06   | P3       | [src/features/auth/stores/auth-store.ts](../../src/features/auth/stores/auth-store.ts)                                                                                                            | Implemented; verification in progress |
| A050-07   | P3       | [src/features/app/lib/start-app-boot.ts](../../src/features/app/lib/start-app-boot.ts)                                                                                                            | Implemented; verification in progress |
| A051-01   | P1       | [src/features/capture/components/connect-tab.tsx](../../src/features/capture/components/connect-tab.tsx)                                                                                          | Implemented; verification in progress |
| A051-02   | P1       | [src/features/capture/components/capture-popover.tsx](../../src/features/capture/components/capture-popover.tsx)                                                                                  | Implemented; verification in progress |
| A052-01   | P1       | [src/features/chat/components/permission-modal.tsx](../../src/features/chat/components/permission-modal.tsx)                                                                                      | Implemented; verification in progress |
| A052-02   | P1       | [src/features/chat/components/permission-modal.tsx](../../src/features/chat/components/permission-modal.tsx)                                                                                      | Implemented; verification in progress |
| A053-01   | P1       | [src/features/chat/components/views/approval-card-view.tsx](../../src/features/chat/components/views/approval-card-view.tsx)                                                                      | Implemented; verification in progress |
| A053-02   | P3       | [src/features/chat/components/views/approval-card-view.tsx](../../src/features/chat/components/views/approval-card-view.tsx)                                                                      | Implemented; verification in progress |
| A053-03   | P3       | [src/features/chat/components/views/chat-search-palette.tsx](../../src/features/chat/components/views/chat-search-palette.tsx)                                                                    | Implemented; verification in progress |
| A054-01   | P3       | [src/features/chat/hooks/use-composer-focus.ts](../../src/features/chat/hooks/use-composer-focus.ts)                                                                                              | Implemented; verification in progress |
| A054-02   | P3       | [src/features/chat/components/views/elicitation-dialog-view.tsx](../../src/features/chat/components/views/elicitation-dialog-view.tsx)                                                            | Implemented; verification in progress |
| A054-03   | P3       | [src/features/chat/hooks/use-composer-attachments.ts](../../src/features/chat/hooks/use-composer-attachments.ts)                                                                                  | Implemented; verification in progress |
| A055-01   | P1       | [src/features/chat/lib/composer-submit.ts](../../src/features/chat/lib/composer-submit.ts)                                                                                                        | Implemented; verification in progress |
| A055-02   | P1       | [src/features/chat/lib/agent-rebind.ts](../../src/features/chat/lib/agent-rebind.ts)                                                                                                              | Implemented; verification in progress |
| A055-03   | P1       | [src/features/chat/lib/comment-mentions.ts](../../src/features/chat/lib/comment-mentions.ts)                                                                                                      | Implemented; verification in progress |
| A055-04   | P3       | [src/features/chat/lib/agents-api.ts](../../src/features/chat/lib/agents-api.ts)                                                                                                                  | Implemented; verification in progress |
| A056-01   | P1       | [src/features/chat/lib/mention-registry.ts](../../src/features/chat/lib/mention-registry.ts)                                                                                                      | Implemented; verification in progress |
| A056-02   | P1       | [src/features/chat/lib/mentions.ts](../../src/features/chat/lib/mentions.ts)                                                                                                                      | Implemented; verification in progress |
| A056-03   | P3       | [src/features/chat/lib/mentions.ts](../../src/features/chat/lib/mentions.ts)                                                                                                                      | Implemented; verification in progress |
| A057-01   | P1       | [src/features/chat/lib/session-send.ts](../../src/features/chat/lib/session-send.ts)                                                                                                              | Implemented; verification in progress |
| A057-02   | P1       | [src/features/chat/lib/switch-agent.ts](../../src/features/chat/lib/switch-agent.ts)                                                                                                              | Implemented; verification in progress |
| A057-03   | P3       | [src/features/chat/lib/switch-agent.ts](../../src/features/chat/lib/switch-agent.ts)                                                                                                              | Implemented; verification in progress |
| A058-01   | P1       | [src/features/chat/stores/chat-store.ts](../../src/features/chat/stores/chat-store.ts)                                                                                                            | Implemented; verification in progress |
| A058-02   | P3       | [src/features/chat/stores/chat-store.ts](../../src/features/chat/stores/chat-store.ts)                                                                                                            | Implemented; verification in progress |
| A058-03   | P2       | [src/features/chat/stores/chat-store.ts](../../src/features/chat/stores/chat-store.ts)                                                                                                            | Implemented; verification in progress |
| A058-04   | P3       | [src/features/chat/stores/detail-panel-store.ts](../../src/features/chat/stores/detail-panel-store.ts)                                                                                            | Implemented; verification in progress |
| A059-01   | P3       | [src/features/command-palette/components/file-search.tsx](../../src/features/command-palette/components/file-search.tsx)                                                                          | Implemented; verification in progress |
| A059-02   | P3       | [src/features/command-palette/lib/palette-add-project.tsx](../../src/features/command-palette/lib/palette-add-project.tsx)                                                                        | Implemented; verification in progress |
| A059-03   | P3       | [src/features/command-palette/lib/palette-add-project.tsx](../../src/features/command-palette/lib/palette-add-project.tsx)                                                                        | Implemented; verification in progress |
| A059-04   | P3       | [src/features/command-palette/lib/palette-add-project.tsx](../../src/features/command-palette/lib/palette-add-project.tsx)                                                                        | Implemented; verification in progress |
| A060-01   | P1       | [src/features/comms/components/message-group.tsx](../../src/features/comms/components/message-group.tsx)                                                                                          | Implemented; verification in progress |
| A060-02   | P1       | [src/features/comms/components/comms-conversation.tsx](../../src/features/comms/components/comms-conversation.tsx)                                                                                | Implemented; verification in progress |
| A060-03   | P1       | [src/features/comms/components/comms-conversation.tsx](../../src/features/comms/components/comms-conversation.tsx)                                                                                | Implemented; verification in progress |
| A060-04   | P1       | [src/features/comms/components/call-activity.tsx](../../src/features/comms/components/call-activity.tsx)                                                                                          | Implemented; verification in progress |
| A060-05   | P3       | [src/features/comms/components/comms-home.tsx](../../src/features/comms/components/comms-home.tsx)                                                                                                | Implemented; verification in progress |
| A060-06   | P3       | [src/features/comms/components/files-tab.tsx](../../src/features/comms/components/files-tab.tsx)                                                                                                  | Implemented; verification in progress |
| A060-07   | P2       | [src/features/comms/components/audio-player.tsx](../../src/features/comms/components/audio-player.tsx)                                                                                            | Implemented; verification in progress |
| A060-08   | P3       | [src/features/comms/components/comms-conversation.tsx](../../src/features/comms/components/comms-conversation.tsx)                                                                                | Implemented; verification in progress |
| A060-09   | P1       | [src/features/comms/stores/comms-store.ts](../../src/features/comms/stores/comms-store.ts)                                                                                                        | Implemented; verification in progress |
| A061-01   | P2       | [src/features/comms/stores/comms-store.ts](../../src/features/comms/stores/comms-store.ts)                                                                                                        | Implemented; verification in progress |
| A061-02   | P1       | [src/features/comms/stores/comms-store.ts](../../src/features/comms/stores/comms-store.ts)                                                                                                        | Implemented; verification in progress |
| A061-03   | P1       | [src/features/comms/lib/use-draft-session.ts](../../src/features/comms/lib/use-draft-session.ts)                                                                                                  | Implemented; verification in progress |
| A061-04   | P1       | [src/features/comms/stores/comms-store.ts](../../src/features/comms/stores/comms-store.ts)                                                                                                        | Implemented; verification in progress |
| A061-05   | P3       | [src/features/comms/stores/comms-store.ts](../../src/features/comms/stores/comms-store.ts)                                                                                                        | Implemented; verification in progress |
| A062-01   | P3       | [src/features/editor/components/editor-panel.tsx](../../src/features/editor/components/editor-panel.tsx)                                                                                          | Implemented; verification in progress |
| A062-02   | P1       | [src/features/editor/components/editor-panel.tsx](../../src/features/editor/components/editor-panel.tsx)                                                                                          | Implemented; verification in progress |
| A062-03   | P3       | [src/features/editor/components/editor-panel.tsx](../../src/features/editor/components/editor-panel.tsx)                                                                                          | Implemented; verification in progress |
| A063-01   | P0       | [src/features/explorer/components/file-tree-confirm-delete.tsx](../../src/features/explorer/components/file-tree-confirm-delete.tsx)                                                              | Implemented; verification in progress |
| A063-02   | P3       | [src/features/explorer/components/project-file-tree.tsx](../../src/features/explorer/components/project-file-tree.tsx)                                                                            | Implemented; verification in progress |
| A063-03   | P3       | [src/features/explorer/lib/project-tree-model.ts](../../src/features/explorer/lib/project-tree-model.ts)                                                                                          | Implemented; verification in progress |
| A064-01   | P1       | [src/features/git/components/commit-view.tsx](../../src/features/git/components/commit-view.tsx)                                                                                                  | Implemented; verification in progress |
| A064-02   | P1       | [src/features/git/components/git-manager/changes-view.tsx](../../src/features/git/components/git-manager/changes-view.tsx)                                                                        | Implemented; verification in progress |
| A065-01   | P1       | [src/features/git/stores/git-store.ts](../../src/features/git/stores/git-store.ts)                                                                                                                | Implemented; verification in progress |
| A066-01   | P0       | [src/features/canvas/stores/canvas-store.ts](../../src/features/canvas/stores/canvas-store.ts)                                                                                                    | Implemented; verification in progress |
| A066-02   | P0       | [src/features/canvas/stores/canvas-store.ts](../../src/features/canvas/stores/canvas-store.ts)                                                                                                    | Implemented; verification in progress |
| A066-03   | P1       | [src/features/canvas/stores/canvas-store.ts](../../src/features/canvas/stores/canvas-store.ts)                                                                                                    | Implemented; verification in progress |
| A066-04   | P0       | [src/features/canvas/components/note-editor-panel.tsx](../../src/features/canvas/components/note-editor-panel.tsx)                                                                                | Implemented; verification in progress |
| A066-05   | P1       | [src/features/canvas/stores/canvas-store.ts](../../src/features/canvas/stores/canvas-store.ts)                                                                                                    | Implemented; verification in progress |
| A066-06   | P3       | [src/features/canvas/components/canvas-panel.tsx](../../src/features/canvas/components/canvas-panel.tsx)                                                                                          | Implemented; verification in progress |
| A067-01   | P0       | [src/features/keybindings/stores/keybindings-store.ts](../../src/features/keybindings/stores/keybindings-store.ts)                                                                                | Implemented; verification in progress |
| A067-02   | P1       | [src/features/keybindings/lib/combo.ts](../../src/features/keybindings/lib/combo.ts)                                                                                                              | Implemented; verification in progress |
| A068-01   | P0       | [src/features/knowledge/components/knowledge-panel.tsx](../../src/features/knowledge/components/knowledge-panel.tsx)                                                                              | Implemented; verification in progress |
| A068-02   | P0       | [src/features/knowledge/stores/knowledge-store.ts](../../src/features/knowledge/stores/knowledge-store.ts)                                                                                        | Implemented; verification in progress |
| A068-03   | P1       | [src/features/knowledge/components/knowledge-sidebar.tsx](../../src/features/knowledge/components/knowledge-sidebar.tsx)                                                                          | Implemented; verification in progress |
| A068-04   | P3       | [src/features/knowledge/components/views/knowledge-graph-canvas.tsx](../../src/features/knowledge/components/views/knowledge-graph-canvas.tsx)                                                    | Implemented; verification in progress |
| A068-05   | P3       | [src/features/knowledge/components/page-header-with-icon.tsx](../../src/features/knowledge/components/page-header-with-icon.tsx)                                                                  | Implemented; verification in progress |
| A069-01   | P1       | [src/features/layout/stores/layout-store.ts](../../src/features/layout/stores/layout-store.ts)                                                                                                    | Implemented; verification in progress |
| A069-02   | P1       | [src/features/layout/stores/layout-store.ts](../../src/features/layout/stores/layout-store.ts)                                                                                                    | Implemented; verification in progress |
| A069-03   | P1       | [src/features/layout/stores/layout-store.ts](../../src/features/layout/stores/layout-store.ts)                                                                                                    | Implemented; verification in progress |
| A069-04   | P3       | [src/features/layout/components/projectless-center.tsx](../../src/features/layout/components/projectless-center.tsx)                                                                              | Implemented; verification in progress |
| A069-05   | P3       | [src/features/layout/components/surface-launcher.tsx](../../src/features/layout/components/surface-launcher.tsx)                                                                                  | Implemented; verification in progress |
| A070-01   | P3       | [src/features/memory/components/memory-policy-view.tsx](../../src/features/memory/components/memory-policy-view.tsx)                                                                              | Implemented; verification in progress |
| A070-02   | P3       | [src/features/memory/components/views/memory-graph-canvas-view.tsx](../../src/features/memory/components/views/memory-graph-canvas-view.tsx)                                                      | Implemented; verification in progress |
| A071-01   | P1       | [src/features/memory/stores/memory-graph-store.ts](../../src/features/memory/stores/memory-graph-store.ts)                                                                                        | Implemented; verification in progress |
| A071-02   | P1       | [src/features/memory/stores/memory-store.ts](../../src/features/memory/stores/memory-store.ts)                                                                                                    | Implemented; verification in progress |
| A072-01   | P3       | [src/features/github/components/github-panel.tsx](../../src/features/github/components/github-panel.tsx)                                                                                          | Implemented; verification in progress |
| A072-02   | P3       | [src/features/log/stores/log-store.ts](../../src/features/log/stores/log-store.ts)                                                                                                                | Implemented; verification in progress |
| A073-01   | P3       | [src/features/notifications/lib/deliver.ts](../../src/features/notifications/lib/deliver.ts)                                                                                                      | Implemented; verification in progress |
| A073-02   | P3       | [src/features/notifications/lib/app-warning-notifier.ts](../../src/features/notifications/lib/app-warning-notifier.ts)                                                                            | Implemented; verification in progress |
| A073-03   | P3       | [src/features/notifications/stores/notifications-store.ts](../../src/features/notifications/stores/notifications-store.ts)                                                                        | Implemented; verification in progress |
| A074-01   | P1       | [src/features/org-agent/stores/org-agent-store.ts](../../src/features/org-agent/stores/org-agent-store.ts)                                                                                        | Implemented; verification in progress |
| A074-02   | P1       | [src/features/org-agent/stores/org-agent-store.ts](../../src/features/org-agent/stores/org-agent-store.ts)                                                                                        | Implemented; verification in progress |
| A074-03   | P1       | [src/features/org-agent/lib/org-agent-links.ts](../../src/features/org-agent/lib/org-agent-links.ts)                                                                                              | Implemented; verification in progress |
| A074-04   | P1       | [src/features/org-agent/stores/org-agent-store.ts](../../src/features/org-agent/stores/org-agent-store.ts)                                                                                        | Implemented; verification in progress |
| A074-05   | P1       | [src/features/org-agent/stores/org-agent-store.ts](../../src/features/org-agent/stores/org-agent-store.ts)                                                                                        | Implemented; verification in progress |
| A075-01   | P1       | [src/features/organisations/lib/org-switch.ts](../../src/features/organisations/lib/org-switch.ts)                                                                                                | Implemented; verification in progress |
| A075-02   | P3       | [src/features/organisations/stores/org-store.ts](../../src/features/organisations/stores/org-store.ts)                                                                                            | Implemented; verification in progress |
| A075-03   | P1       | [src/features/organisations/components/members-modal.tsx](../../src/features/organisations/components/members-modal.tsx)                                                                          | Implemented; verification in progress |
| A078-01   | P1       | [src/features/pull-requests/lib/pull-request-tab-drafts.ts](../../src/features/pull-requests/lib/pull-request-tab-drafts.ts)                                                                      | Implemented; verification in progress |
| A078-02   | P3       | [src/features/pull-requests/lib/use-pull-request-agent-actions.ts](../../src/features/pull-requests/lib/use-pull-request-agent-actions.ts)                                                        | Implemented; verification in progress |
| A078-03   | P3       | [src/features/pull-requests/lib/pull-request-handoff.ts](../../src/features/pull-requests/lib/pull-request-handoff.ts)                                                                            | Implemented; verification in progress |
| A079-01   | P1       | [src/features/session-context/lib/run-git-action.ts](../../src/features/session-context/lib/run-git-action.ts)                                                                                    | Implemented; verification in progress |
| A080-01   | P2       | [src/features/settings/components/marketplace/installed-skills.tsx](../../src/features/settings/components/marketplace/installed-skills.tsx)                                                      | Implemented; verification in progress |
| A080-02   | P3       | [src/features/settings/components/marketplace/skills-marketplace.tsx](../../src/features/settings/components/marketplace/skills-marketplace.tsx)                                                  | Implemented; verification in progress |
| A080-03   | P3       | [src/features/settings/components/agents/agent-settings-sections.tsx](../../src/features/settings/components/agents/agent-settings-sections.tsx)                                                  | Implemented; verification in progress |
| A080-04   | P3       | [src/features/settings/components/agents/agent-config-sections.tsx](../../src/features/settings/components/agents/agent-config-sections.tsx)                                                      | Implemented; verification in progress |
| A081-01   | P3       | [src-tauri/src/state/atlas_config.rs](../../src-tauri/src/state/atlas_config.rs)                                                                                                                  | Implemented; verification in progress |
| A081-03   | P1       | [src/features/settings/components/settings-screen.tsx](../../src/features/settings/components/settings-screen.tsx)                                                                                | Implemented; verification in progress |
| A082-01   | P3       | [src/features/sidebar/components/sidebar-session-list.tsx](../../src/features/sidebar/components/sidebar-session-list.tsx)                                                                        | Implemented; verification in progress |
| A082-02   | P3       | [src/App.tsx](../../src/App.tsx)                                                                                                                                                                  | Implemented; verification in progress |
| A082-03   | P3       | [src/features/sidebar/hooks/use-session-shelves.ts](../../src/features/sidebar/hooks/use-session-shelves.ts)                                                                                      | Implemented; verification in progress |
| A083-01   | P0       | [src/features/spaces/components/space-nodes.tsx](../../src/features/spaces/components/space-nodes.tsx)                                                                                            | Implemented; verification in progress |
| A083-02   | P1       | [src/features/spaces/lib/use-space-session.ts](../../src/features/spaces/lib/use-space-session.ts)                                                                                                | Implemented; verification in progress |
| A083-03   | P0       | [src/features/spaces/lib/use-space-session.ts](../../src/features/spaces/lib/use-space-session.ts)                                                                                                | Implemented; verification in progress |
| A083-04   | P1       | [src/features/spaces/lib/use-space-session.ts](../../src/features/spaces/lib/use-space-session.ts)                                                                                                | Implemented; verification in progress |
| A083-05   | P3       | [src/features/spaces/components/space-canvas.tsx](../../src/features/spaces/components/space-canvas.tsx)                                                                                          | Implemented; verification in progress |
| A084-01   | P3       | [src/features/terminal/lib/terminal-session.ts](../../src/features/terminal/lib/terminal-session.ts)                                                                                              | Implemented; verification in progress |
| A084-02   | P3       | [src/features/terminal/lib/path-link-provider.ts](../../src/features/terminal/lib/path-link-provider.ts)                                                                                          | Implemented; verification in progress |
| A084-03   | P3       | [src/features/terminal/lib/format-duration.ts](../../src/features/terminal/lib/format-duration.ts)                                                                                                | Implemented; verification in progress |
| A085-01   | P3       | [src/features/pdf/components/pdf-viewer.tsx](../../src/features/pdf/components/pdf-viewer.tsx)                                                                                                    | Implemented; verification in progress |
| A085-02   | P3       | [src/features/pdf/components/pdf-viewer.tsx](../../src/features/pdf/components/pdf-viewer.tsx)                                                                                                    | Implemented; verification in progress |
| A085-03   | P3       | [src/features/projects/stores/project-git-store.ts](../../src/features/projects/stores/project-git-store.ts)                                                                                      | Implemented; verification in progress |
| A085-04   | P3       | [src/features/projects/stores/project-git-store.ts](../../src/features/projects/stores/project-git-store.ts)                                                                                      | Implemented; verification in progress |
| A085-05   | P3       | [src/features/projects/stores/project-store.ts](../../src/features/projects/stores/project-store.ts)                                                                                              | Implemented; verification in progress |
| A085-06   | P1       | [src/features/telemetry/posthog-client.ts](../../src/features/telemetry/posthog-client.ts)                                                                                                        | Implemented; verification in progress |
| A085-07   | P3       | [src/features/svg/components/svg-viewer.tsx](../../src/features/svg/components/svg-viewer.tsx)                                                                                                    | Implemented; verification in progress |
| A086-01   | P1       | [src/features/usage/stores/usage-store.ts](../../src/features/usage/stores/usage-store.ts)                                                                                                        | Implemented; verification in progress |
| A086-02   | P3       | [src/features/usage/components/usage-panel.tsx](../../src/features/usage/components/usage-panel.tsx)                                                                                              | Implemented; verification in progress |
| A086-03   | P3       | [src/features/usage/lib/use-usage-view.ts](../../src/features/usage/lib/use-usage-view.ts)                                                                                                        | Implemented; verification in progress |
| A086-04   | P3       | [src/features/usage/lib/use-usage-view.ts](../../src/features/usage/lib/use-usage-view.ts)                                                                                                        | Implemented; verification in progress |
| A087-01   | P3       | [src/lib/link-services.ts](../../src/lib/link-services.ts)                                                                                                                                        | Implemented; verification in progress |
| A087-02   | P2       | [src/lib/markdown-cache.tsx](../../src/lib/markdown-cache.tsx)                                                                                                                                    | Implemented; verification in progress |
| A088-01   | P3       | [src/features/ui-actions/lib/ui-chat.ts](../../src/features/ui-actions/lib/ui-chat.ts)                                                                                                            | Implemented; verification in progress |
| A088-02   | P3       | [src/features/theme/components/theme-editor/theme-editor-panel.tsx](../../src/features/theme/components/theme-editor/theme-editor-panel.tsx)                                                      | Implemented; verification in progress |
| A088-03   | P3       | [src/features/theme/components/theme-editor/theme-editor-panel.tsx](../../src/features/theme/components/theme-editor/theme-editor-panel.tsx)                                                      | Implemented; verification in progress |
| A088-04   | P3       | [src/features/updater/stores/updater-store.ts](../../src/features/updater/stores/updater-store.ts)                                                                                                | Implemented; verification in progress |
| A089-01   | P3       | [engine/analytics/src/client.rs](../../vendor/atlas-engine/analytics/src/client.rs)                                                                                                               | Implemented; verification in progress |
| A092-01   | P1       | [engine/app-server-protocol/src/protocol/thread_history.rs](../../vendor/atlas-engine/app-server-protocol/src/protocol/thread_history.rs)                                                         | Implemented; verification in progress |
| A099-01   | P3       | [engine/app-server/src/lib.rs](../../vendor/atlas-engine/app-server/src/lib.rs)                                                                                                                   | Implemented; verification in progress |
| A102-02   | P1       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A103-01   | P1       | [engine/app-server/src/request_processors/turn_processor.rs](../../vendor/atlas-engine/app-server/src/request_processors/turn_processor.rs)                                                       | Implemented; verification in progress |
| A104-01   | P0       | [engine/apply-patch/src/lib.rs](../../vendor/atlas-engine/apply-patch/src/lib.rs)                                                                                                                 | Implemented; verification in progress |
| A104-02   | P1       | [engine/apply-patch/src/file_update.rs](../../vendor/atlas-engine/apply-patch/src/file_update.rs)                                                                                                 | Implemented; verification in progress |
| A104-03   | P3       | [engine/apply-patch/src/file_update.rs](../../vendor/atlas-engine/apply-patch/src/file_update.rs)                                                                                                 | Implemented; verification in progress |
| A105-01   | P1       | [engine/atlas-engine-api/src/atlas_chat/request.rs](../../vendor/atlas-engine/atlas-engine-api/src/atlas_chat/request.rs)                                                                         | Implemented; verification in progress |
| A105-02   | P1       | [engine/atlas-engine-api/src/atlas_chat/sse.rs](../../vendor/atlas-engine/atlas-engine-api/src/atlas_chat/sse.rs)                                                                                 | Implemented; verification in progress |
| A108-01   | P1       | [engine/atlas-engine-mcp/src/rmcp_client.rs](../../vendor/atlas-engine/atlas-engine-mcp/src/rmcp_client.rs)                                                                                       | Implemented; verification in progress |
| A109-01   | P3       | [engine/backend-client/src/client.rs](../../vendor/atlas-engine/backend-client/src/client.rs)                                                                                                     | Implemented; verification in progress |
| A112-01   | P3       | [engine/config/scripts/generate-proto.sh](../../vendor/atlas-engine/config/scripts/generate-proto.sh)                                                                                             | Implemented; verification in progress |
| A113-01   | P3       | [engine/config/src/loader/mod.rs](../../vendor/atlas-engine/config/src/loader/mod.rs)                                                                                                             | Implemented; verification in progress |
| A117-01   | P3       | [engine/core-plugins/src/marketplace_upgrade/git.rs](../../vendor/atlas-engine/core-plugins/src/marketplace_upgrade/git.rs)                                                                       | Implemented; verification in progress |
| A117-02   | P3       | [engine/core-plugins/src/marketplace_upgrade/git.rs](../../vendor/atlas-engine/core-plugins/src/marketplace_upgrade/git.rs)                                                                       | Implemented; verification in progress |
| A118-01   | P3       | [engine/core-plugins/src/startup_sync.rs](../../vendor/atlas-engine/core-plugins/src/startup_sync.rs)                                                                                             | Implemented; verification in progress |
| A120-01   | P1       | [engine/core/src/compact.rs](../../vendor/atlas-engine/core/src/compact.rs)                                                                                                                       | Implemented; verification in progress |
| A120-02   | P1       | [engine/core/src/compact.rs](../../vendor/atlas-engine/core/src/compact.rs)                                                                                                                       | Implemented; verification in progress |
| A121-01   | P1       | [engine/core/src/config/mod.rs](../../vendor/atlas-engine/core/src/config/mod.rs)                                                                                                                 | Implemented; verification in progress |
| A122-01   | P3       | [engine/core/src/config/permissions.rs](../../vendor/atlas-engine/core/src/config/permissions.rs)                                                                                                 | Implemented; verification in progress |
| A127-01   | P1       | [engine/core/src/session/rollout_reconstruction.rs](../../vendor/atlas-engine/core/src/session/rollout_reconstruction.rs)                                                                         | Implemented; verification in progress |
| A128-01   | P1       | [engine/core/src/shell_snapshot.rs](../../vendor/atlas-engine/core/src/shell_snapshot.rs)                                                                                                         | Implemented; verification in progress |
| A132-01   | P3       | [engine/core/src/tools/handlers/unified_exec/exec_command.rs](../../vendor/atlas-engine/core/src/tools/handlers/unified_exec/exec_command.rs)                                                     | Implemented; verification in progress |
| A134-01   | P1       | [engine/core/src/unified_exec/async_watcher.rs](../../vendor/atlas-engine/core/src/unified_exec/async_watcher.rs)                                                                                 | Implemented; verification in progress |
| A134-02   | P3       | [engine/core/src/unified_exec/async_watcher.rs](../../vendor/atlas-engine/core/src/unified_exec/async_watcher.rs)                                                                                 | Implemented; verification in progress |
| A136-01   | P3       | [engine/exec-server/src/fs_sandbox.rs](../../vendor/atlas-engine/exec-server/src/fs_sandbox.rs)                                                                                                   | Implemented; verification in progress |
| A138-01   | P3       | [engine/exec-server/testing/run_version_skew.sh](../../vendor/atlas-engine/exec-server/testing/run_version_skew.sh)                                                                               | Implemented; verification in progress |
| A139-01   | P1       | [crates/atlas-native-agent/src/engine/connection.rs](../../crates/atlas-native-agent/src/engine/connection.rs)                                                                                    | Implemented; verification in progress |
| A140-01   | P1       | [engine/ext/skills/src/host_roots.rs](../../vendor/atlas-engine/ext/skills/src/host_roots.rs)                                                                                                     | Implemented; verification in progress |
| A142-01   | P3       | [engine/external-agent-migration/src/memory_import.rs](../../vendor/atlas-engine/external-agent-migration/src/memory_import.rs)                                                                   | Implemented; verification in progress |
| A142-02   | P3       | [engine/external-agent-migration/src/hooks_common.rs](../../vendor/atlas-engine/external-agent-migration/src/hooks_common.rs)                                                                     | Implemented; verification in progress |
| A146-01   | P3       | [engine/file-watcher/src/lib.rs](../../vendor/atlas-engine/file-watcher/src/lib.rs)                                                                                                               | Implemented; verification in progress |
| A147-01   | P2       | [engine/hooks/src/engine/command_runner.rs](../../vendor/atlas-engine/hooks/src/engine/command_runner.rs)                                                                                         | Implemented; verification in progress |
| A148-01   | P3       | [engine/hooks/src/output_spill.rs](../../vendor/atlas-engine/hooks/src/output_spill.rs)                                                                                                           | Implemented; verification in progress |
| A148-02   | P2       | [engine/hooks/src/engine/command_runner.rs](../../vendor/atlas-engine/hooks/src/engine/command_runner.rs)                                                                                         | Implemented; verification in progress |
| A150-01   | P1       | [engine/linux-sandbox/src/linux_run_main.rs](../../vendor/atlas-engine/linux-sandbox/src/linux_run_main.rs)                                                                                       | Implemented; verification in progress |
| A150-02   | P3       | [engine/linux-sandbox/src/linux_run_main.rs](../../vendor/atlas-engine/linux-sandbox/src/linux_run_main.rs)                                                                                       | Implemented; verification in progress |
| A151-01   | P3       | [engine/login/src/auth/manager.rs](../../vendor/atlas-engine/login/src/auth/manager.rs)                                                                                                           | Implemented; verification in progress |
| A151-02   | P3       | [engine/login/src/server.rs](../../vendor/atlas-engine/login/src/server.rs)                                                                                                                       | Implemented; verification in progress |
| A153-01   | P3       | [engine/model-provider/src/provider.rs](../../vendor/atlas-engine/model-provider/src/provider.rs)                                                                                                 | Implemented; verification in progress |
| A154-01   | P3       | [engine/network-proxy/src/mitm_hook.rs](../../vendor/atlas-engine/network-proxy/src/mitm_hook.rs)                                                                                                 | Implemented; verification in progress |
| A154-02   | P3       | [engine/network-proxy/src/runtime.rs](../../vendor/atlas-engine/network-proxy/src/runtime.rs)                                                                                                     | Implemented; verification in progress |
| A156-01   | P1       | [engine/otel/src/events/session_telemetry.rs](../../vendor/atlas-engine/otel/src/events/session_telemetry.rs)                                                                                     | Implemented; verification in progress |
| A156-02   | P3       | [engine/otel/src/events/session_telemetry.rs](../../vendor/atlas-engine/otel/src/events/session_telemetry.rs)                                                                                     | Implemented; verification in progress |
| A157-01   | P3       | [engine/protocol/src/exec_output.rs](../../vendor/atlas-engine/protocol/src/exec_output.rs)                                                                                                       | Implemented; verification in progress |
| A162-01   | P3       | [engine/rmcp-client/src/oauth.rs](../../vendor/atlas-engine/rmcp-client/src/oauth.rs)                                                                                                             | Implemented; verification in progress |
| A162-02   | P2       | [engine/rmcp-client/src/oauth_client_registration.rs](../../vendor/atlas-engine/rmcp-client/src/oauth_client_registration.rs)                                                                     | Implemented; verification in progress |
| A162-03   | P3       | [engine/rmcp-client/src/oauth.rs](../../vendor/atlas-engine/rmcp-client/src/oauth.rs)                                                                                                             | Implemented; verification in progress |
| A162-04   | P3       | [engine/rmcp-client/src/stdio_server_launcher.rs](../../vendor/atlas-engine/rmcp-client/src/stdio_server_launcher.rs)                                                                             | Implemented; verification in progress |
| A162-05   | P2       | [engine/rmcp-client/src/oauth/refresh_transaction.rs](../../vendor/atlas-engine/rmcp-client/src/oauth/refresh_transaction.rs)                                                                     | Implemented; verification in progress |
| A164-01   | P3       | [engine/rollout-trace/src/reducer/conversation/normalize.rs](../../vendor/atlas-engine/rollout-trace/src/reducer/conversation/normalize.rs)                                                       | Implemented; verification in progress |
| A165-01   | P2       | [engine/rollout/src/list.rs](../../vendor/atlas-engine/rollout/src/list.rs)                                                                                                                       | Implemented; verification in progress |
| A168-01   | P0       | [engine/shell-command/src/bash.rs](../../vendor/atlas-engine/shell-command/src/bash.rs)                                                                                                           | Implemented; verification in progress |
| A168-02   | P1       | [engine/shell-command/src/command_safety/is_safe_command.rs](../../vendor/atlas-engine/shell-command/src/command_safety/is_safe_command.rs)                                                       | Implemented; verification in progress |
| A168-03   | P3       | [engine/shell-command/src/command_safety/is_dangerous_command.rs](../../vendor/atlas-engine/shell-command/src/command_safety/is_dangerous_command.rs)                                             | Implemented; verification in progress |
| A168-04   | P2       | [engine/shell-command/src/command_safety/powershell_parser.rs](../../vendor/atlas-engine/shell-command/src/command_safety/powershell_parser.rs)                                                   | Implemented; verification in progress |
| A169-01   | P1       | [engine/skills/src/assets/samples/skill-installer/scripts/install-skill-from-github.py](../../vendor/atlas-engine/skills/src/assets/samples/skill-installer/scripts/install-skill-from-github.py) | Implemented; verification in progress |
| A169-02   | P3       | [engine/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py](../../vendor/atlas-engine/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py)                       | Implemented; verification in progress |
| A178-01   | P3       | [engine/utils/pty/src/pty.rs](../../vendor/atlas-engine/utils/pty/src/pty.rs)                                                                                                                     | Implemented; verification in progress |
| A180-01   | P1       | [engine/windows-sandbox-rs/src/env.rs](../../vendor/atlas-engine/windows-sandbox-rs/src/env.rs)                                                                                                   | Implemented; verification in progress |
| A180-02   | P3       | [engine/windows-sandbox-rs/src/lib.rs](../../vendor/atlas-engine/windows-sandbox-rs/src/lib.rs)                                                                                                   | Implemented; verification in progress |
| A181-02   | P3       | [engine/windows-sandbox-rs/src/unified_exec/backends/legacy.rs](../../vendor/atlas-engine/windows-sandbox-rs/src/unified_exec/backends/legacy.rs)                                                 | Implemented; verification in progress |
| A182-01   | P3       | [engine/shell-escalation/src/unix/stopwatch.rs](../../vendor/atlas-engine/shell-escalation/src/unix/stopwatch.rs)                                                                                 | Implemented; verification in progress |
| PL01-01   | P1       | [src/features/terminal/components/terminal-tab-strip.tsx](../../src/features/terminal/components/terminal-tab-strip.tsx)                                                                          | Implemented; verification in progress |
| PL01-02   | P1       | [src/lib/native-context-menu.ts](../../src/lib/native-context-menu.ts)                                                                                                                            | Implemented; verification in progress |
| PL01-03   | P1       | [src/features/terminal/lib/terminal-session.ts](../../src/features/terminal/lib/terminal-session.ts)                                                                                              | Implemented; verification in progress |
| PL01-04   | P1       | [src/features/explorer/lib/project-file-ops.ts](../../src/features/explorer/lib/project-file-ops.ts)                                                                                              | Implemented; verification in progress |
| PL01-05   | P3       | [src-tauri/src/commands/browser.rs](../../src-tauri/src/commands/browser.rs)                                                                                                                      | Implemented; verification in progress |
| PL01-06   | P1       | [src/features/spaces/components/space-canvas.tsx](../../src/features/spaces/components/space-canvas.tsx)                                                                                          | Implemented; verification in progress |
| PL01G2-01 | P1       | [src-tauri/src/commands/save_guard.rs](../../src-tauri/src/commands/save_guard.rs)                                                                                                                | Implemented; verification in progress |
| PL01G2-02 | P3       | [src/features/usage/components/usage-panel.tsx](../../src/features/usage/components/usage-panel.tsx)                                                                                              | Implemented; verification in progress |
| PL02-01   | P1       | [src/features/keybindings/lib/combo.ts](../../src/features/keybindings/lib/combo.ts)                                                                                                              | Implemented; verification in progress |
| PL02-02   | P1       | [src/features/keybindings/lib/actions.ts](../../src/features/keybindings/lib/actions.ts)                                                                                                          | Implemented; verification in progress |
| PL02-03   | P1       | [src/features/terminal/lib/terminal-session.ts](../../src/features/terminal/lib/terminal-session.ts)                                                                                              | Implemented; verification in progress |
| PL02-04   | P1       | [src/features/chat/components/views/permission-card-view.tsx](../../src/features/chat/components/views/permission-card-view.tsx)                                                                  | Implemented; verification in progress |
| PL02-05   | P1       | [src/features/pull-requests/components/pull-request-header.tsx](../../src/features/pull-requests/components/pull-request-header.tsx)                                                              | Implemented; verification in progress |
| PL02-06   | P1       | [src/features/keybindings/lib/combo.ts](../../src/features/keybindings/lib/combo.ts)                                                                                                              | Implemented; verification in progress |
| PL02-07   | P1       | [src/hooks/use-hotkey.ts](../../src/hooks/use-hotkey.ts)                                                                                                                                          | Implemented; verification in progress |
| PL02G1-01 | P1       | [src/features/comms/components/views/create-channel-menu-view.tsx](../../src/features/comms/components/views/create-channel-menu-view.tsx)                                                        | Implemented; verification in progress |
| PL02G1-02 | P3       | [src/features/knowledge/components/knowledge-finder.tsx](../../src/features/knowledge/components/knowledge-finder.tsx)                                                                            | Implemented; verification in progress |
| PL02G2-01 | P1       | [src/features/menu/lib/use-native-menu.ts](../../src/features/menu/lib/use-native-menu.ts)                                                                                                        | Implemented; verification in progress |
| PL02G2-02 | P3       | [src/features/editor-notion/extensions/toggle.tsx](../../src/features/editor-notion/extensions/toggle.tsx)                                                                                        | Implemented; verification in progress |
| PL02G3-01 | P1       | [src/features/browser/components/views/browser-toolbar.tsx](../../src/features/browser/components/views/browser-toolbar.tsx)                                                                      | Implemented; verification in progress |
| PL02G3-02 | P3       | [src/lib/window-focus.ts](../../src/lib/window-focus.ts)                                                                                                                                          | Implemented; verification in progress |
| PL03-01   | P3       | [src/lib/markdown-fileviewer.tsx](../../src/lib/markdown-fileviewer.tsx)                                                                                                                          | Implemented; verification in progress |
| PL03-02   | P3       | [src/features/chat/hooks/use-mark-session-viewed.ts](../../src/features/chat/hooks/use-mark-session-viewed.ts)                                                                                    | Implemented; verification in progress |
| PL03-03   | P3       | [src/features/layout/components/pane-tab.tsx](../../src/features/layout/components/pane-tab.tsx)                                                                                                  | Implemented; verification in progress |
| PL03-04   | P3       | [src/features/memory/lib/memory-graph-scene.ts](../../src/features/memory/lib/memory-graph-scene.ts)                                                                                              | Implemented; verification in progress |
| PL03G1-01 | P3       | [src/features/spaces/components/space-canvas.tsx](../../src/features/spaces/components/space-canvas.tsx)                                                                                          | Implemented; verification in progress |
| PL04-01   | P1       | [src/features/app/stores/app-store.ts](../../src/features/app/stores/app-store.ts)                                                                                                                | Implemented; verification in progress |
| PL04-02   | P1       | [src/features/pdf/components/views/pdf-viewer-view.tsx](../../src/features/pdf/components/views/pdf-viewer-view.tsx)                                                                              | Implemented; verification in progress |
| PL04-03   | P1       | [src/features/comms/components/views/media-lightbox-view.tsx](../../src/features/comms/components/views/media-lightbox-view.tsx)                                                                  | Implemented; verification in progress |
| PL04-04   | P3       | [src/features/comms/components/audio-player.tsx](../../src/features/comms/components/audio-player.tsx)                                                                                            | Implemented; verification in progress |
| PL04-05   | P2       | [src/lib/pixi-app.ts](../../src/lib/pixi-app.ts)                                                                                                                                                  | Implemented; verification in progress |
| PL04-06   | P3       | [src/features/comms/components/audio-player.tsx](../../src/features/comms/components/audio-player.tsx)                                                                                            | Implemented; verification in progress |
| PL05-01   | P1       | [src/features/media/components/media-viewer.tsx](../../src/features/media/components/media-viewer.tsx)                                                                                            | Implemented; verification in progress |
| PL05-03   | P1       | [src/features/media/components/media-viewer.tsx](../../src/features/media/components/media-viewer.tsx)                                                                                            | Implemented; verification in progress |
| PL05-04   | P1       | [src/features/app/stores/app-store.ts](../../src/features/app/stores/app-store.ts)                                                                                                                | Implemented; verification in progress |
| PL05-05   | P3       | [src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json)                                                                                                                                      | Implemented; verification in progress |
| PL05-06   | P3       | [src-tauri/src/commands/browser.rs](../../src-tauri/src/commands/browser.rs)                                                                                                                      | Implemented; verification in progress |
| PL05G1-01 | P3       | [src/features/chat/components/provider-model-pills.tsx](../../src/features/chat/components/provider-model-pills.tsx)                                                                              | Implemented; verification in progress |
| PL05G2-01 | P1       | [src/components/mermaid-block.tsx](../../src/components/mermaid-block.tsx)                                                                                                                        | Implemented; verification in progress |
| PL06-01   | P3       | [src/features/terminal/lib/terminal-session.ts](../../src/features/terminal/lib/terminal-session.ts)                                                                                              | Implemented; verification in progress |
| PL06G2-01 | P3       | [src/features/git/components/git-manager/git-op-output.tsx](../../src/features/git/components/git-manager/git-op-output.tsx)                                                                      | Implemented; verification in progress |
| PL06G3-01 | P1       | [src/features/memory/components/views/memory-graph-canvas-view.tsx](../../src/features/memory/components/views/memory-graph-canvas-view.tsx)                                                      | Implemented; verification in progress |
| PL06G3-02 | P1       | [src/features/browser/components/browser-overlay-watcher.tsx](../../src/features/browser/components/browser-overlay-watcher.tsx)                                                                  | Implemented; verification in progress |
| PL06G5-01 | P3       | [src/features/spaces/components/space-cursors.tsx](../../src/features/spaces/components/space-cursors.tsx)                                                                                        | Implemented; verification in progress |
| PL07-01   | P1       | [src/features/keybindings/lib/combo.ts](../../src/features/keybindings/lib/combo.ts)                                                                                                              | Implemented; verification in progress |
| PL07-02   | P3       | [src/features/menu/lib/use-native-menu.ts](../../src/features/menu/lib/use-native-menu.ts)                                                                                                        | Implemented; verification in progress |
| PL07-03   | P3       | [src/features/pull-requests/components/pull-request-review-thread.tsx](../../src/features/pull-requests/components/pull-request-review-thread.tsx)                                                | Implemented; verification in progress |
| PL07-04   | P3       | [src-tauri/src/commands/updater_macos.rs](../../src-tauri/src/commands/updater_macos.rs)                                                                                                          | Implemented; verification in progress |
| PL08-01   | P1       | [src-tauri/src/commands/session_projects.rs](../../src-tauri/src/commands/session_projects.rs)                                                                                                    | Implemented; verification in progress |
| PL08-03   | P3       | [src-tauri/src/commands/clipboard.rs](../../src-tauri/src/commands/clipboard.rs)                                                                                                                  | Implemented; verification in progress |
| PL08-04   | P3       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| PL08-05   | P3       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| PL08G1-01 | P2       | [src-tauri/src/commands/updater_macos.rs](../../src-tauri/src/commands/updater_macos.rs)                                                                                                          | Implemented; verification in progress |
| PL09-01   | P1       | [crates/atlas-terminal/src/command.rs](../../crates/atlas-terminal/src/command.rs)                                                                                                                | Implemented; verification in progress |
| PL09-02   | P2       | [crates/atlas-agent-servers/src/connection.rs](../../crates/atlas-agent-servers/src/connection.rs)                                                                                                | Implemented; verification in progress |
| PL09-03   | P1       | [crates/atlas-thread-metadata/src/paths.rs](../../crates/atlas-thread-metadata/src/paths.rs)                                                                                                      | Implemented; verification in progress |
| PL09-04   | P3       | [crates/atlas-agent-servers/src/host_env.rs](../../crates/atlas-agent-servers/src/host_env.rs)                                                                                                    | Implemented; verification in progress |
| PL11-01   | P3       | [crates/atlas-native-agent/src/linux_sandbox.rs](../../crates/atlas-native-agent/src/linux_sandbox.rs)                                                                                            | Implemented; verification in progress |
| PL12-01   | P1       | [src/features/editor/components/codemirror-file-view.tsx](../../src/features/editor/components/codemirror-file-view.tsx)                                                                          | Implemented; verification in progress |
| PL12-02   | P1       | [src/features/explorer/lib/project-tree-model.ts](../../src/features/explorer/lib/project-tree-model.ts)                                                                                          | Implemented; verification in progress |
| PL12-03   | P3       | [src/lib/open-file.ts](../../src/lib/open-file.ts)                                                                                                                                                | Implemented; verification in progress |
| PL12-04   | P1       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| PL12-05   | P3       | [src/features/ui-actions/lib/scope.ts](../../src/features/ui-actions/lib/scope.ts)                                                                                                                | Implemented; verification in progress |
| PL12G1-01 | P3       | [src-tauri/src/commands/recent_files.rs](../../src-tauri/src/commands/recent_files.rs)                                                                                                            | Implemented; verification in progress |
| PL13-01   | P1       | [src-tauri/src/commands/git_watcher.rs](../../src-tauri/src/commands/git_watcher.rs)                                                                                                              | Implemented; verification in progress |
| PL13-02   | P3       | [src-tauri/src/commands/fileindex.rs](../../src-tauri/src/commands/fileindex.rs)                                                                                                                  | Implemented; verification in progress |
| PL13-03   | P2       | [src-tauri/src/commands/fileindex.rs](../../src-tauri/src/commands/fileindex.rs)                                                                                                                  | Implemented; verification in progress |
| PL14-02   | P1       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| PL14-03   | P3       | [crates/atlas-terminal/src/lib.rs](../../crates/atlas-terminal/src/lib.rs)                                                                                                                        | Implemented; verification in progress |
| PL14-04   | P3       | [src-tauri/src/commands/git_autofetch.rs](../../src-tauri/src/commands/git_autofetch.rs)                                                                                                          | Implemented; verification in progress |
| PL14-06   | P3       | [src-tauri/src/commands/fs.rs](../../src-tauri/src/commands/fs.rs)                                                                                                                                | Implemented; verification in progress |
| PL14G1-01 | P2       | [src-tauri/src/commands/project_sources.rs](../../src-tauri/src/commands/project_sources.rs)                                                                                                      | Implemented; verification in progress |
| PL15-03   | P2       | [crates/atlas-terminal/src/lib.rs](../../crates/atlas-terminal/src/lib.rs)                                                                                                                        | Implemented; verification in progress |
| PL15-04   | P2       | [src-tauri/src/commands/terminal.rs](../../src-tauri/src/commands/terminal.rs)                                                                                                                    | Implemented; verification in progress |
| PL15-05   | P3       | [crates/atlas-terminal/src/lib.rs](../../crates/atlas-terminal/src/lib.rs)                                                                                                                        | Implemented; verification in progress |
| PL16-01   | P1       | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)                                                                                                                                                | Implemented; verification in progress |
| PL16-02   | P1       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| PL16-03   | P1       | [src-tauri/src/commands/byok.rs](../../src-tauri/src/commands/byok.rs)                                                                                                                            | Implemented; verification in progress |
| PL16-04   | P3       | [src-tauri/src/commands/agent_secrets.rs](../../src-tauri/src/commands/agent_secrets.rs)                                                                                                          | Implemented; verification in progress |
| PL16G1-01 | P2       | [src-tauri/src/commands/auth.rs](../../src-tauri/src/commands/auth.rs)                                                                                                                            | Implemented; verification in progress |
| PL17-01   | P1       | [src-tauri/src/menu.rs](../../src-tauri/src/menu.rs)                                                                                                                                              | Implemented; verification in progress |
| PL17-02   | P1       | [src-tauri/src/notifier/mod.rs](../../src-tauri/src/notifier/mod.rs)                                                                                                                              | Implemented; verification in progress |
| PL17-03   | P2       | [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)                                                                                                                                                | Implemented; verification in progress |
| PL18-01   | P1       | [crates/atlas-terminal/src/lib.rs](../../crates/atlas-terminal/src/lib.rs)                                                                                                                        | Implemented; verification in progress |
| PL18-02   | P1       | [engine/sandboxing/src/bwrap.rs](../../vendor/atlas-engine/sandboxing/src/bwrap.rs)                                                                                                               | Implemented; verification in progress |
| PL19-02   | P1       | [src-tauri/src/commands/updater_macos.rs](../../src-tauri/src/commands/updater_macos.rs)                                                                                                          | Implemented; verification in progress |
| PL19-03   | P2       | [src-tauri/src/commands/updater_macos.rs](../../src-tauri/src/commands/updater_macos.rs)                                                                                                          | Implemented; verification in progress |
| PL19-04   | P2       | [src-tauri/src/commands/updater_download.rs](../../src-tauri/src/commands/updater_download.rs)                                                                                                    | Implemented; verification in progress |
| PL19G1-01 | P3       | [src/features/notifications/lib/deliver.ts](../../src/features/notifications/lib/deliver.ts)                                                                                                      | Implemented; verification in progress |
| PL20-02   | P1       | [scripts/linux/runtime-deps.sh](../../scripts/linux/runtime-deps.sh)                                                                                                                              | Implemented; verification in progress |
