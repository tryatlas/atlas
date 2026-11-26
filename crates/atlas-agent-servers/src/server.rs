//! The launcher layer.
//!
//! There is exactly **one** launcher, [`CustomAgentServer`], and it is generic.
//! There are no per-agent server types: an agent
//! exists because the user installed it, and this layer only knows how to start
//! whatever command the store resolves for it.
//!
//! It has no per-agent knowledge at all: what one agent needs set to behave
//! well in Atlas is written into that agent's Variables at install
//! (`atlas_agent_store::launch_defaults`).

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AgentConnection, AgentId};
use futures::future::BoxFuture;

use crate::connection::{
    AcpConnection, AcpConnectionDefaults, AgentServerCommand, RequestElicitationSink,
    ThreadEventSink,
};

/// Resolves the command for one installed agent.
///
/// Implemented by `atlas-agent-store`; this crate only consumes it,
/// which is what keeps the transport independent of how a binary got onto disk.
pub trait ExternalAgentServer: Send + Sync {
    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>>;

    fn version(&self) -> Option<Arc<str>> {
        None
    }

    /// Bring a copy this agent already has on disk up to [`Self::version`],
    /// without starting anything. `Ok(true)` when it installed something.
    ///
    /// For updates only: an agent never fetched stays lazy, so installing one
    /// from the marketplace still costs nothing until its first chat. This is
    /// what lets a registry bump download in the background, so the restart
    /// that follows is instant instead of the next message waiting on npm.
    /// The default has nothing on disk to update.
    fn prefetch_update(&self) -> BoxFuture<'static, Result<bool>> {
        Box::pin(async { Ok(false) })
    }

    /// Whether [`Self::prefetch_update`] would install something: a copy on
    /// disk that is behind [`Self::version`]. Installs nothing itself — this is
    /// how a running agent's staleness is found, since its update has to wait
    /// for the restart. The default has nothing on disk to be behind.
    fn update_pending(&self) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    /// Whether this agent's last start ran an earlier copy than
    /// [`Self::version`] because the update was still downloading when it
    /// was asked for. Such an agent wants an idle restart once the download
    /// lands; [`Self::update_pending`] cannot see it, since by then the copy
    /// on disk is current. The default never starts behind.
    fn running_behind(&self) -> bool {
        false
    }
}

/// What a connect attempt is given: the resolver for this agent, plus the
/// channels the UI watches while it starts.
///
/// The store is reduced to the one trait this layer needs, plus two
/// `watch::Sender`s for the UI.
///
/// `server` is optional because an in-process agent has no command to resolve,
/// so its connect path ignores the delegate.
pub struct AgentServerDelegate {
    pub server: Option<Arc<dyn ExternalAgentServer>>,
    pub new_version_available: Option<tokio::sync::watch::Sender<Option<String>>>,
    pub loading_status: Option<tokio::sync::watch::Sender<Option<String>>>,
}

impl AgentServerDelegate {
    pub fn new(server: Arc<dyn ExternalAgentServer>) -> Self {
        Self {
            server: Some(server),
            new_version_available: None,
            loading_status: None,
        }
    }

    /// A delegate for an agent that runs in-process: no command to resolve, no
    /// binary to download, so nothing to report on either channel.
    pub fn native() -> Self {
        Self {
            server: None,
            new_version_available: None,
            loading_status: None,
        }
    }

    pub fn with_version_channel(mut self, tx: tokio::sync::watch::Sender<Option<String>>) -> Self {
        self.new_version_available = Some(tx);
        self
    }

    pub fn with_loading_status(mut self, tx: tokio::sync::watch::Sender<Option<String>>) -> Self {
        self.loading_status = Some(tx);
        self
    }
}

/// Everything about *this host* that a connect attempt needs.
///
/// The release channel, app version, settings and MCP config are parameters
/// rather than globals, so this crate stays leaf-level and testable.
#[derive(Clone)]
pub struct ConnectOptions {
    pub root_dir: Option<PathBuf>,
    pub defaults: AcpConnectionDefaults,
    pub thread_events: ThreadEventSink,
    /// Where a connection's REQUEST-scoped elicitations are announced.
    ///
    /// The counterpart to `thread_events` for the elicitations that belong to
    /// no session. They are the ones that arrive during sign-in — a device
    /// code to enter, a URL to visit — so they can predate every session the
    /// connection will ever have, and without a sink they are raised into
    /// silence and the agent waits for an answer nobody was shown.
    pub request_elicitation_events: RequestElicitationSink,
    /// Decides the MCP servers each session is handed (the memory tool
    /// server, today). `None` hands every session an empty list.
    pub session_mcp: Option<Arc<dyn crate::session_mcp::SessionMcpServers>>,
    pub client_name: &'static str,
    pub client_version: String,
}

pub trait AgentServer: Send + Sync {
    fn agent_id(&self) -> AgentId;

    fn connect(
        &self,
        delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>>;

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;

    fn default_mode(&self) -> Option<acp::SessionModeId> {
        None
    }

    /// This agent's model catalogue, for when it is NOT running: a refresh
    /// then has no connection to ask, and still has a list to fetch and
    /// store for the next connect. A running agent is asked through
    /// [`AgentConnection::model_catalogue`] instead, which can also say what
    /// the new list means for the connection.
    fn model_catalogue(&self) -> Option<Arc<dyn atlas_acp_thread::AgentModelCatalogue>> {
        None
    }
}

impl dyn AgentServer {
    pub fn downcast<T: 'static + AgentServer + Sized>(self: Arc<Self>) -> Option<Arc<T>> {
        self.into_any().downcast().ok()
    }
}

/// The one launcher.
pub struct CustomAgentServer {
    id: AgentId,
    default_mode: Option<acp::SessionModeId>,
}

impl CustomAgentServer {
    pub fn new(id: AgentId) -> Self {
        Self {
            id,
            default_mode: None,
        }
    }

    pub fn with_default_mode(mut self, mode: Option<acp::SessionModeId>) -> Self {
        self.default_mode = mode;
        self
    }
}

impl AgentServer for CustomAgentServer {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn connect(
        &self,
        delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        let agent_id = self.id.clone();
        Box::pin(async move {
            // Nothing here is per agent (ADR-0002): what an agent needs set
            // to behave well in Atlas is written into its Variables when it
            // is installed (`atlas_agent_store::launch_defaults`), and those
            // are the store's settings layer.
            let extra_env = load_proxy_env();

            let server = delegate
                .server
                .clone()
                .ok_or_else(|| anyhow::anyhow!("no command resolver for agent `{agent_id}`"))?;
            let command = server.get_command(Vec::new(), extra_env).await?;

            let connection = AcpConnection::stdio(
                agent_id,
                command,
                options.root_dir,
                options.defaults,
                options.thread_events,
                options.request_elicitation_events,
                options.client_name,
                options.client_version,
            )
            .await?
            .with_session_mcp(options.session_mcp);

            Ok(Arc::new(connection) as Arc<dyn AgentConnection>)
        })
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }

    fn default_mode(&self) -> Option<acp::SessionModeId> {
        self.default_mode.clone()
    }
}

/// Proxy variables to pass through to the agent.
///
/// Atlas's settings live above this crate, so the process environment is the
/// source here.
pub fn load_proxy_env() -> HashMap<String, String> {
    let mut env = HashMap::new();

    let proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().map(|value| (key, value)));

    if let Some((key, value)) = proxy {
        let canonical = if key.to_ascii_lowercase().starts_with("https") {
            "HTTPS_PROXY"
        } else {
            "HTTP_PROXY"
        };
        env.insert(canonical.to_owned(), value);
    }

    if let Ok(no_proxy) = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")) {
        env.insert("NO_PROXY".to_owned(), no_proxy);
    } else if !env.is_empty() {
        // Local MCP servers must not go through the proxy.
        env.insert("NO_PROXY".to_owned(), "localhost,127.0.0.1".to_owned());
    }

    env
}

/// Whether Atlas's shared memory is the only memory in Atlas sessions (the
/// `atlasOnlyMemory` setting, default on). Mirrors the setting for code
/// that has no app handle; the launch defaults that turn an agent's own
/// memory off are conditional on it (`atlas_agent_store::launch_defaults`).
static ATLAS_ONLY_MEMORY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Set from the app's settings at startup and whenever they change.
pub fn set_atlas_only_memory(on: bool) {
    ATLAS_ONLY_MEMORY.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The current `atlasOnlyMemory` setting.
pub fn atlas_only_memory() -> bool {
    ATLAS_ONLY_MEMORY.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod launcher_tests {
    /// The launcher treats every agent alike (ADR-0002): it once branched on
    /// two ids no install has, so the workarounds never
    /// ran. What an agent needs now lives in its Variables, seeded at install
    /// from `atlas_agent_store::launch_defaults`. The ids are assembled here
    /// so this test doesn't trip on itself.
    #[test]
    fn the_launcher_names_no_agent() {
        let source = include_str!("server.rs");
        for id in [
            ["claude", "-code"].concat(),
            ["claude", "-acp"].concat(),
            format!("{q}codex{q}", q = '"'),
            ["co", "dex-acp"].concat(),
            format!("{q}gemini{q}", q = '"'),
        ] {
            assert!(!source.contains(&id), "server.rs names {id}");
        }
    }
}
