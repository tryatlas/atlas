//! The **tool server host**: the one place Atlas's MCP tool servers are
//! served from and handed to sessions. Each server — memory, UI, organisation,
//! code — is a [`Tenant`] that supplies only what is its own; the host owns
//! everything they share.
//!
//! **A tenant supplies** ([`Tenant`]): its name and path, its handler (tools
//! and instructions), which connections it is for ([`Audience`]), its own
//! admission rule — the setting that turns it on ([`Admit`]) — and, if some
//! of its tools reach another person, which ask first ([`OutwardCalls`]).
//!
//! **The host owns**:
//! - **the listener** ([`ToolServer`]): one per app, bound to `127.0.0.1` on
//!   a port the OS picks, started at setup on the async runtime so the main
//!   thread never waits on it ([`ToolServerHost::start`]);
//! - **the token** ([`SessionTokens`]): one bearer token per session, minted
//!   when the session is offered its servers, revoked when it ends, checked
//!   on every request, and handed to the tool as the session's [`Grant`]
//!   ([`grant_of`]). One token opens every tenant, so a tenant not offered to
//!   a session checks the grant rather than trusting the path;
//! - **the session policy**: every tenant is mounted on a session manager the
//!   host makes, so none idles out and none can differ;
//! - **the offer** ([`SessionOffers`]): one loop over the tenants per session
//!   request, the transport choice (HTTP for an agent in this process, this
//!   binary's stdio bridge for every other, ADR-0019), the token file a
//!   bridged entry names (ADR-0020), and one log line per decision;
//! - **the `tools/list` cache rule** ([`tools_list`]).

mod host;
pub(crate) mod offers;
mod tenant;
#[cfg(test)]
mod tests;
mod tokens;

use rmcp::model::{CacheScope, ListToolsResult, Tool};
use rmcp::service::{RequestContext, RoleServer};

#[allow(unused_imports)]
pub use host::{ToolServer, ToolServerHost};
#[allow(unused_imports)]
pub use offers::{bridge_until_session_ends, SessionOffers, BRIDGE_ARG, BRIDGE_REAP_INTERVAL};
#[allow(unused_imports)]
pub use tenant::{Admit, Audience, OfferDecision, OutwardCalls, Tenant};
#[allow(unused_imports)]
pub use tokens::{Grant, SessionTokens};

/// How long a client may treat a `tools/list` answer as fresh. The tools
/// never change while the app runs.
pub(crate) const TOOLS_LIST_TTL_MS: u64 = 60 * 60 * 1000;

/// A tenant's `tools/list` answer.
///
/// MCP 2026-07-28 makes `ttlMs` and `cacheScope` required on list results,
/// and rmcp leaves them out unless set. Claude Code negotiates that version
/// and rejects a list without them, so it connected, failed `tools/list`
/// three times and dropped every tool. `private`: each answer is served under
/// one session's token.
pub(crate) fn tools_list(tools: Vec<Tool>) -> ListToolsResult {
    ListToolsResult::with_all_items(tools)
        .with_ttl_ms(TOOLS_LIST_TTL_MS)
        .with_cache_scope(CacheScope::Private)
}

/// The names in a `tools/list` answer: what a tenant declares it advertises
/// ([`Tenant::advertising`]), taken from the same answer its server serves so
/// the two cannot drift.
pub(crate) fn tool_names(list: &ListToolsResult) -> Vec<String> {
    list.tools
        .iter()
        .map(|tool| tool.name.to_string())
        .collect()
}

/// The grant of the session making this request, as the listener's token
/// check left it. `None` only for a request that did not come through the
/// listener.
pub(crate) fn grant_of(context: &RequestContext<RoleServer>) -> Option<Grant> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Grant>())
        .cloned()
}

/// [`grant_of`], or the error a tool call without one is answered with.
pub(crate) fn require_grant(
    context: &RequestContext<RoleServer>,
) -> Result<Grant, rmcp::ErrorData> {
    grant_of(context).ok_or_else(|| rmcp::ErrorData::invalid_request("no session token", None))
}
