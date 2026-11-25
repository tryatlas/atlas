// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! Real executor process for remote HTTP tests, independent of an installed CLI.

use atlas_engine_exec_server::ExecServerRuntimePaths;
use atlas_engine_http_client::HttpClientFactory;
use atlas_engine_http_client::OutboundProxyPolicy;
use std::ffi::OsStr;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let argv1 = std::env::args_os().nth(1);
    #[cfg(unix)]
    if argv1.as_deref()
        == Some(OsStr::new(
            atlas_engine_exec_server::ATLAS_AGENT_ARG0_EXEC_HELPER_ARG1,
        ))
    {
        atlas_engine_exec_server::run_arg0_exec_helper_main();
    }
    if argv1.as_deref()
        == Some(OsStr::new(
            atlas_engine_exec_server::ATLAS_AGENT_FS_HELPER_ARG1,
        ))
    {
        atlas_engine_exec_server::run_fs_helper_main();
    }

    let runtime_paths = ExecServerRuntimePaths::new(std::env::current_exe()?, None)?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(atlas_engine_exec_server::run_main(
            "ws://127.0.0.1:0",
            runtime_paths,
            HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
        ))
}
