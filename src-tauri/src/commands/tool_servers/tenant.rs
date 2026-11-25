//! A **tenant** of the tool server host: one MCP tool server, described by
//! the facts that are its own. Everything else — the listener, the token, the
//! transport, the session policy, the log line — is the host's.

use std::sync::Arc;

use atlas_agent_servers::{AskFirst, CallDescription, CallToApprove, SessionMcpRequest};
use futures::future::BoxFuture;
use rmcp::handler::server::ServerHandler;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};

use super::tokens::Grant;

/// Which connections a tenant is for. A property of the connection, never of
/// which agent it is (ADR-0002).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audience {
    /// Every agent a transport reaches.
    Everyone,
    /// Only a connection that carries UI control (ADR-0012).
    UiControl,
    /// Only a connection that carries organisation access (ADR-0014).
    OrgAccess,
}

impl Audience {
    /// Why `request`'s connection is outside this audience, if it is. A
    /// connection property is only ever carried by a connection that speaks
    /// HTTP MCP, so the restricted audiences ask for that first.
    fn excludes(self, request: &SessionMcpRequest) -> Option<&'static str> {
        let (carried, missing) = match self {
            Self::Everyone => return None,
            Self::UiControl => (request.ui_control, "connection does not carry UI control"),
            Self::OrgAccess => (
                request.org_access,
                "connection does not carry organisation access",
            ),
        };
        if !request.http_mcp {
            Some("agent did not advertise mcpCapabilities.http")
        } else if !carried {
            Some(missing)
        } else {
            None
        }
    }

    /// The connection property this audience turns on, as the log line names
    /// it, and whether `request` carries it.
    fn property(self, request: &SessionMcpRequest) -> Option<(&'static str, bool)> {
        match self {
            Self::Everyone => None,
            Self::UiControl => Some(("ui_control", request.ui_control)),
            Self::OrgAccess => Some(("org_access", request.org_access)),
        }
    }
}

/// A tenant's own admission rule for a session in `cwd`: the setting that
/// turns it on, and whatever else must hold of the session's project. `Err`
/// is the reason it is left out. On `Ok` it may stamp the session's grant
/// with what its tools will need (the organisation the project is bound to,
/// say); the stamp is kept only if the tenant is then offered.
pub type Admit = Arc<dyn Fn(&str, &mut Grant) -> Result<(), &'static str> + Send + Sync>;

/// A tenant's tools that reach another person, which ask the user first
/// (ADR-0014). The host declares them on the offer and routes the two
/// questions the connection asks about a waiting call to the tenant that
/// will answer it.
pub trait OutwardCalls: Send + Sync {
    /// The tools that ask first.
    fn ask_first(&self) -> &'static [&'static str];
    /// The subset that asks on every call, with no allowance for the rest of
    /// the session.
    fn ask_every_time(&self) -> &'static [&'static str];
    /// What the approval card says about a waiting call to `tool`, made under
    /// `grant`.
    fn describe(
        &self,
        grant: Grant,
        tool: String,
        arguments: serde_json::Value,
    ) -> BoxFuture<'static, Option<CallDescription>>;
    /// The user approved `call`; record it where the tool will look.
    fn approved(&self, call: CallToApprove<'_>);
}

/// Mounts the tenant's service at its path, on the session manager the host
/// hands it.
type Mount = Arc<dyn Fn(Arc<LocalSessionManager>) -> axum::Router + Send + Sync>;

/// Whether one session request is handed one tenant, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferDecision {
    /// Included over HTTP: the agent runs in this process.
    Included,
    /// Included as a stdio server through `atlas mcp-bridge`: the agent runs
    /// in another process (ADR-0019, ADR-0020).
    IncludedViaBridge,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OfferDecision {
    pub fn includes(self) -> bool {
        matches!(self, Self::Included | Self::IncludedViaBridge)
    }

    /// The one log line per tenant per session request: the agent, what its
    /// connection carries, and whether the tenant was included (and if not,
    /// why).
    pub fn log_line(self, tenant: &Tenant, request: &SessionMcpRequest) -> String {
        let label = tenant.label();
        let mut head = format!(
            "{label} tool server offer: agent={} http_mcp={}",
            request.agent_id.as_str(),
            request.http_mcp
        );
        if let Some((property, carried)) = tenant.audience.property(request) {
            head.push_str(&format!(" {property}={carried}"));
        }
        match self {
            Self::Included => format!("{head} {label}_server=included"),
            Self::IncludedViaBridge => format!("{head} {label}_server=included_via_bridge"),
            Self::Omitted(reason) => format!("{head} {label}_server=omitted reason=\"{reason}\""),
        }
    }
}

/// How the host reaches the agent behind one session request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Transport {
    /// HTTP, the token in the entry's header: the agent runs in this process.
    Http,
    /// This binary as a stdio bridge, the token in a private file.
    Bridge(std::path::PathBuf),
    /// Neither: an agent in another process, and no path to this binary.
    None,
}

/// One tool server on the host.
#[derive(Clone)]
pub struct Tenant {
    name: &'static str,
    path: &'static str,
    audience: Audience,
    admit: Admit,
    outward: Option<Arc<dyn OutwardCalls>>,
    /// The tools its server advertises ([`advertising`](Self::advertising)).
    tools: Vec<String>,
    mount: Mount,
}

impl Tenant {
    /// `handler`'s tools and instructions, known to agents as `name`
    /// (`atlas_code`) and served at `path` (`/code`). Offered to every agent
    /// until [`only_for`](Self::only_for) or [`admitted_by`](Self::admitted_by)
    /// narrows it.
    pub fn new<H>(name: &'static str, path: &'static str, handler: H) -> Self
    where
        H: ServerHandler + Clone + Send + Sync + 'static,
    {
        Self {
            name,
            path,
            audience: Audience::Everyone,
            admit: Arc::new(|_, _| Ok(())),
            outward: None,
            tools: Vec::new(),
            mount: Arc::new(move |sessions| {
                let handler = handler.clone();
                let service = StreamableHttpService::new(
                    move || Ok(handler.clone()),
                    sessions,
                    StreamableHttpServerConfig::default(),
                );
                axum::Router::new().nest_service(path, service)
            }),
        }
    }

    /// Offer it only to connections in `audience`.
    #[must_use]
    pub fn only_for(mut self, audience: Audience) -> Self {
        self.audience = audience;
        self
    }

    /// Offer it only to a session `admit` lets in ([`Admit`]).
    #[must_use]
    pub fn admitted_by(
        mut self,
        admit: impl Fn(&str, &mut Grant) -> Result<(), &'static str> + Send + Sync + 'static,
    ) -> Self {
        self.admit = Arc::new(admit);
        self
    }

    /// Offer it only while `gate` — a setting, read for the session's launch
    /// directory — is on; `off` is the reason given when it is not.
    #[must_use]
    pub fn gated_by(
        self,
        gate: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        off: &'static str,
    ) -> Self {
        self.admitted_by(move |cwd, _| if gate(cwd) { Ok(()) } else { Err(off) })
    }

    /// Some of its tools ask the user first ([`OutwardCalls`]).
    #[must_use]
    pub fn asking_first(mut self, outward: Arc<dyn OutwardCalls>) -> Self {
        self.outward = Some(outward);
        self
    }

    /// Its server advertises exactly `tools` — taken from the server's own
    /// `tools/list` answer ([`super::tool_names`]). Only these are
    /// pre-approved for an agent that takes pre-approval by tool name
    /// (`atlas_agent_servers::session_mcp::claude_code_meta`); a tenant that
    /// declares none has none pre-approved.
    #[must_use]
    pub fn advertising(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }

    /// The name the server goes by in an agent's MCP configuration.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Where it is served on the listener.
    pub fn path(&self) -> &'static str {
        self.path
    }

    /// The short name the log line uses: `atlas_ui` is `ui`.
    fn label(&self) -> &'static str {
        self.name.strip_prefix("atlas_").unwrap_or(self.name)
    }

    pub(super) fn outward(&self) -> Option<&Arc<dyn OutwardCalls>> {
        self.outward.as_ref()
    }

    /// The service, routed at [`path`](Self::path), on `sessions`.
    pub(super) fn mount(&self, sessions: Arc<LocalSessionManager>) -> axum::Router {
        (self.mount)(sessions)
    }

    /// Its advertised and ask-first tools, added to `ask_first` under its
    /// name.
    pub(super) fn declare_ask_first(&self, ask_first: AskFirst) -> AskFirst {
        let ask_first = ask_first.advertising(self.name, &self.tools);
        match &self.outward {
            Some(outward) => ask_first
                .on(self.name, outward.ask_first())
                .every_time(self.name, outward.ask_every_time()),
            None => ask_first,
        }
    }

    /// Decide for one request, in the one order every tenant shares: a
    /// transport must reach the agent, the connection must be in the audience,
    /// the tenant must admit the session, and the host must be running. Each
    /// later question is asked only when the earlier ones passed, so a
    /// connection that cannot use the tenant never reads its setting.
    pub(super) fn decide(
        &self,
        request: &SessionMcpRequest,
        transport: &Transport,
        running: bool,
        grant: &mut Grant,
    ) -> OfferDecision {
        if *transport == Transport::None {
            return OfferDecision::Omitted("no transport reaches the agent");
        }
        if let Some(reason) = self.audience.excludes(request) {
            return OfferDecision::Omitted(reason);
        }
        let mut stamped = grant.clone();
        let cwd = grant.cwd.clone();
        if let Err(reason) = (self.admit)(&cwd, &mut stamped) {
            return OfferDecision::Omitted(reason);
        }
        if !running {
            return OfferDecision::Omitted("tool server host is not running");
        }
        *grant = stamped;
        match transport {
            Transport::Http => OfferDecision::Included,
            _ => OfferDecision::IncludedViaBridge,
        }
    }
}
