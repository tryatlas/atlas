// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
//! Process entry point for the version-skew harness; uses the production executor.
use std::sync::Arc;

use atlas_engine_api::AuthProvider;
use atlas_engine_exec_server::{
    ExecServerRuntimePaths, RemoteEnvironmentConfig, run_remote_environment,
};
use atlas_engine_http_client::{HttpClientFactory, OutboundProxyPolicy};
use http::HeaderMap;
use http::HeaderValue;

struct HarnessAuth(HeaderValue);
impl AuthProvider for HarnessAuth {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        headers.insert(http::header::AUTHORIZATION, self.0.clone());
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = std::env::args().skip(1);
    let mut remote = None;
    let mut environment_id = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--remote" => remote = args.next(),
            "--environment-id" => environment_id = args.next(),
            _ => return Err(format!("unexpected executor argument: {arg}").into()),
        }
    }
    let token = std::env::var("ATLAS_AGENT_API_KEY")?;
    let config = RemoteEnvironmentConfig::new(
        remote.ok_or("--remote is required")?,
        environment_id.ok_or("--environment-id is required")?,
        Arc::new(HarnessAuth(HeaderValue::from_str(&format!(
            "Bearer {token}"
        ))?)),
        HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
    )?;
    let helper = std::env::var_os("ATLAS_AGENT_TEST_APP_SERVER")
        .ok_or("ATLAS_AGENT_TEST_APP_SERVER is required")?;
    run_remote_environment(config, ExecServerRuntimePaths::new(helper.into(), None)?).await?;
    Ok(())
}
