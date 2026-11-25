// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use std::sync::Arc;

use anyhow::Result;
use anyhow::bail;
use rmcp::transport::AuthorizationManager;
use rmcp::transport::AuthorizationRequest;
use rmcp::transport::AuthorizationSession;
use rmcp::transport::auth::OAuthHttpClient;
use rmcp::transport::auth::OAuthState;

/// OAuth client-registration strategy for one interactive HTTP MCP login.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum McpOAuthClientRegistration {
    /// Register Atlas with the authorization server's advertised DCR endpoint.
    #[default]
    Auto,
    /// Require an Atlas-hosted Client ID Metadata Document (currently unavailable).
    Cimd,
    /// Require the authorization server's Dynamic Client Registration endpoint.
    Dcr,
}

pub(crate) async fn start_authorization(
    server_url: &str,
    http_client: Arc<dyn OAuthHttpClient>,
    scopes: &[&str],
    redirect_uri: &str,
    _callback_id: &str,
    client_registration: McpOAuthClientRegistration,
) -> Result<OAuthState> {
    if client_registration == McpOAuthClientRegistration::Cimd {
        bail!(
            "Atlas does not provide a hosted MCP client metadata document; use automatic or dynamic client registration"
        );
    }
    let mut auth_manager =
        AuthorizationManager::new_with_oauth_http_client(server_url, http_client).await?;
    auth_manager.set_allow_missing_issuer(true);
    let metadata = auth_manager.resolve_metadata().await?.metadata;

    // CIMD requires our own hosted HTTPS metadata, including the exact client ID
    // and redirect URI. Atlas currently has no such service. Register a distinct
    // Atlas client rather than identifying this application as upstream Codex.
    // Pre-registered clients are handled before this interactive registration path.
    // https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
    auth_manager.set_metadata(metadata);
    let request = AuthorizationRequest::new(redirect_uri)
        .with_scopes(scopes.iter().copied())
        .with_client_name("Atlas Agent");
    let session = AuthorizationSession::new(auth_manager, request)
        .await
        .map_err(|(_auth_manager, error)| error)?;

    Ok(OAuthState::Session(session))
}

#[cfg(test)]
#[path = "oauth_client_registration_tests.rs"]
mod tests;
