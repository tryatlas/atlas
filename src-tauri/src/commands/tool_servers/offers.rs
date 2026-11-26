//! Handing the tool servers to sessions.
//!
//! On each session request the host asks every tenant, in registration order,
//! whether this session is offered it ([`SessionOffers`]). The tenants that
//! are go out as MCP entries on one token. An agent in another process —
//! every ACP agent, whatever it advertised — gets each as a stdio server, the
//! Atlas binary's own `mcp-bridge` forwarding to the loopback listener
//! (ADR-0019), with the token in a private file the entry names, never in the
//! entry itself: an adapter may put the entry on a command line (ADR-0020).
//! The native agent, in this process, gets each as a StreamableHttp entry
//! with the token in its header. The token is minted for the *request*,
//! before a new session's id exists, and bound to the id once the agent
//! answers; an offer that never binds is revoked. Each decision is logged,
//! one line per tenant per session request.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{AskFirst, SessionMcpOffer, SessionMcpRequest, SessionMcpServers};

use super::host::ToolServerHost;
use super::tenant::{OfferDecision, Tenant, Transport};
use super::tokens::Grant;
use crate::commands::memory_bridge::TokenFiles;

/// The argument that makes the Atlas binary the stdio bridge.
pub const BRIDGE_ARG: &str = "mcp-bridge";

/// How often a running bridge checks that its session is still alive.
pub const BRIDGE_REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Resolves once `token_file` is gone. The file goes when the session it was
/// written for ends ([`TokenFiles::session_ended`]), or when the offer is
/// released unbound, so its absence is the bridge's signal that nothing will
/// ever use it again. An error other than "not found" counts as present: a
/// bridge is never reaped on a guess.
pub async fn token_file_removed(token_file: &std::path::Path, every: std::time::Duration) {
    loop {
        if matches!(tokio::fs::try_exists(token_file).await, Ok(false)) {
            return;
        }
        tokio::time::sleep(every).await;
    }
}

/// Runs `bridge` until it ends, or until its session does
/// ([`token_file_removed`]). An agent that never sends `session/close`, or
/// keeps its MCP children alive past it, would otherwise hold one bridge
/// process per ended session for as long as the agent itself runs.
pub async fn bridge_until_session_ends(
    bridge: impl std::future::Future<Output = anyhow::Result<()>>,
    token_file: &std::path::Path,
    every: std::time::Duration,
) -> anyhow::Result<()> {
    tokio::select! {
        result = bridge => result,
        () = token_file_removed(token_file, every) => Ok(()),
    }
}

/// `name` at `url` as a stdio server: `<this binary> mcp-bridge <url> <token
/// file>`. Nothing in the entry is secret: an adapter may put all of it,
/// `env` included, on a command line (ADR-0020).
fn bridge_entry(
    exe: &std::path::Path,
    name: &str,
    url: String,
    token_file: &std::path::Path,
) -> acp::McpServer {
    acp::McpServer::Stdio(acp::McpServerStdio::new(name, exe.to_path_buf()).args(vec![
        BRIDGE_ARG.to_string(),
        url,
        token_file.to_string_lossy().into_owned(),
    ]))
}

/// Offers each session the host's tool servers ([`SessionMcpServers`],
/// installed on every agent connection): one decision per tenant, one token
/// for all of them. One offer decides them all because they all ride one
/// token: the token table holds one token per session, so two offers minting
/// two tokens would revoke each other.
pub struct SessionOffers {
    host: Arc<ToolServerHost>,
    token_files: Arc<TokenFiles>,
    /// Pretend this binary's path cannot be found, so nothing can be bridged.
    #[cfg(test)]
    no_bridge: bool,
}

/// What one session request is offered, before anything is minted.
pub(crate) struct Decided<'a> {
    /// How the agent is reached.
    transport: Transport,
    /// Every tenant's decision, in registration order.
    pub(crate) decisions: Vec<(&'a Tenant, OfferDecision)>,
    /// The grant the session's token will carry, stamped by the tenants that
    /// are included.
    grant: Grant,
}

impl SessionOffers {
    /// Offers the tenants registered on `host`. Bridged sessions' token files
    /// go to a fresh temporary directory until
    /// [`with_token_files`](Self::with_token_files) names the app's own.
    pub fn new(host: Arc<ToolServerHost>) -> Self {
        Self {
            host,
            token_files: Arc::new(TokenFiles::in_temp()),
            #[cfg(test)]
            no_bridge: false,
        }
    }

    /// Write bridged sessions' token files with `files` (ADR-0020), shared
    /// with whatever removes a session's file when the session ends.
    pub fn with_token_files(mut self, files: Arc<TokenFiles>) -> Self {
        self.token_files = files;
        self
    }

    /// As if this binary's own path could not be found.
    #[cfg(test)]
    pub(crate) fn without_bridge(mut self) -> Self {
        self.no_bridge = true;
        self
    }

    /// How `request`'s agent is reached. Only an agent in this process may
    /// hold the token in its entry: any other may put the entry on a command
    /// line (ADR-0020), so it reaches the servers through this binary as a
    /// stdio bridge (ADR-0019) that reads the token from a private file.
    /// Without a path to the binary, it gets none.
    fn transport(&self, request: &SessionMcpRequest) -> Transport {
        if request.in_process && request.http_mcp {
            return Transport::Http;
        }
        #[cfg(test)]
        if self.no_bridge {
            return Transport::None;
        }
        match std::env::current_exe() {
            Ok(exe) => Transport::Bridge(exe),
            Err(_) => Transport::None,
        }
    }

    /// Decide every tenant for `request`. Mints nothing.
    pub(crate) fn decide(&self, request: &SessionMcpRequest) -> Decided<'_> {
        let transport = self.transport(request);
        let running = self.host.is_running();
        let mut grant = Grant {
            session_id: String::new(),
            agent: request.agent_id.as_str().to_string(),
            cwd: request.cwd.to_string_lossy().into_owned(),
            org: None,
            ui: false,
        };
        let decisions = self
            .host
            .tenants()
            .iter()
            .map(|tenant| {
                let decision = tenant.decide(request, &transport, running, &mut grant);
                (tenant, decision)
            })
            .collect();
        Decided {
            transport,
            decisions,
            grant,
        }
    }
}

impl SessionMcpServers for SessionOffers {
    /// A waiting outward call, described by the tenant that will answer it,
    /// under the grant the session's token carries — so the card reads the
    /// same organisation and Workspace the call acts in.
    fn describe_call(
        &self,
        call: atlas_agent_servers::CallToApprove<'_>,
    ) -> futures::future::BoxFuture<'static, Option<atlas_agent_servers::CallDescription>> {
        let outward = self
            .host
            .tenant(call.server)
            .and_then(Tenant::outward)
            .cloned();
        let grant = self
            .host
            .tokens()
            .grant_for_session(&call.session_id.to_string());
        let tool = call.tool.to_string();
        let arguments = call.arguments.clone();
        Box::pin(async move {
            let (outward, grant) = (outward?, grant?);
            outward.describe(grant, tool, arguments).await
        })
    }

    /// An approved outward call, recorded where the tenant that answers it
    /// checks for the user's approval (ADR-0014).
    fn approved_call(&self, call: atlas_agent_servers::CallToApprove<'_>) {
        if let Some(outward) = self.host.tenant(call.server).and_then(Tenant::outward) {
            outward.approved(call);
        }
    }

    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let Decided {
            transport,
            decisions,
            grant,
        } = self.decide(request);
        let session = request
            .session_id
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default();
        let mut entries: Vec<(&str, String)> = Vec::new();
        // The tenants' outward actions ask first (ADR-0014); the host
        // declares them, the connection projects them.
        let mut ask_first = AskFirst::none();
        for (tenant, decision) in decisions {
            tracing::info!(
                target: "atlas::tool_servers",
                session = session,
                "{}",
                decision.log_line(tenant, request),
            );
            if let (true, Some(url)) = (decision.includes(), self.host.url_at(tenant.path())) {
                entries.push((tenant.name(), url));
                ask_first = tenant.declare_ask_first(ask_first);
            }
        }
        if entries.is_empty() {
            return SessionMcpOffer::none();
        }
        // Minted once, after every decision, for every entry, carrying what
        // the included tenants stamped on the grant and nothing from the rest.
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&grant.agent, &grant.cwd, grant.org, grant.ui);
        // A bridged session's entries name one file holding the token.
        let bridge = match transport {
            Transport::Bridge(exe) => {
                match self
                    .token_files
                    .write(&token, |t| tokens.grant(t).is_some())
                {
                    Ok(file) => Some((exe, file)),
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas::tool_servers",
                            "no Atlas tool servers for this session: cannot write its token file: {e:#}"
                        );
                        tokens.revoke_token(&token);
                        return SessionMcpOffer::none();
                    }
                }
            }
            _ => None,
        };
        let servers = entries
            .into_iter()
            .map(|(name, url)| match &bridge {
                Some((exe, file)) => bridge_entry(exe, name, url, file),
                None => acp::McpServer::Http(acp::McpServerHttp::new(name, url).headers(vec![
                    acp::HttpHeader::new("Authorization", format!("Bearer {token}")),
                ])),
            })
            .collect();
        let token_file = bridge.map(|(_, file)| file);
        let token_files = self.token_files.clone();
        // Bound per agent: the token table and the token files key a session
        // by its agent and id, since two agents can share an id (#86).
        let agent = grant.agent;
        SessionMcpOffer::new(servers, move |session| match session {
            Some(id) => {
                let id = id.to_string();
                tokens.bind(&token, &id);
                // Its file goes when the session ends.
                if let Some(file) = &token_file {
                    token_files.bind(file, &agent, &id);
                }
            }
            None => {
                tokens.revoke_token(&token);
                if let Some(file) = &token_file {
                    token_files.remove(file);
                }
            }
        })
        .asking_first(ask_first)
    }
}

/// Every entry `offer` carries, as `(name, url, bearer token)`: the token
/// from an HTTP entry's header, or from the file a bridged entry names.
#[cfg(test)]
pub fn offered_entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    offer
        .servers()
        .iter()
        .map(|server| match server {
            acp::McpServer::Http(http) => {
                let token = http
                    .headers
                    .iter()
                    .find(|h| h.name == "Authorization")
                    .and_then(|h| h.value.strip_prefix("Bearer "))
                    .expect("a bearer token")
                    .to_string();
                (http.name.clone(), http.url.clone(), token)
            }
            acp::McpServer::Stdio(stdio) => {
                let [arg, url, file] = stdio.args.as_slice() else {
                    panic!("mcp-bridge <url> <token file>: {:?}", stdio.args)
                };
                assert_eq!(arg, BRIDGE_ARG);
                let token = crate::commands::memory_bridge::read_token_file(file.as_ref())
                    .expect("a readable token file");
                (stdio.name.clone(), url.clone(), token)
            }
            other => panic!("{other:?}"),
        })
        .collect()
}

#[cfg(test)]
mod reap_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_bridge_whose_session_ended_exits_with_its_input_still_open() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "t").unwrap();
        // A bridge whose agent never closes its stdin: it would run forever.
        let forever = std::future::pending::<anyhow::Result<()>>();
        let removed = file.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            std::fs::remove_file(removed).unwrap();
        });
        tokio::time::timeout(
            Duration::from_secs(5),
            bridge_until_session_ends(forever, &file, Duration::from_millis(10)),
        )
        .await
        .expect("the bridge is reaped once its session's token file is gone")
        .unwrap();
    }

    #[tokio::test]
    async fn a_live_session_leaves_the_bridge_to_finish_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "t").unwrap();
        let ends = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Err(anyhow::anyhow!("its own ending"))
        };
        let result = bridge_until_session_ends(ends, &file, Duration::from_millis(5)).await;
        assert_eq!(result.unwrap_err().to_string(), "its own ending");
        assert!(file.exists());
    }
}
