//! The tool server host at its interface: what a session is offered, by which
//! transport, on which token, under which session policy — decided once here
//! for every tenant, so no tenant's own tests have to prove it again.

use std::borrow::Cow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpRequest, SessionMcpServers};
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ErrorData as McpError, RoleClient, ServiceExt};
use serde_json::json;

use super::offers::offered_entries;
use super::OfferDecision::{Included, IncludedViaBridge, Omitted};
use super::*;
use crate::commands::code_server::{self, CodeTools, CODE_PATH, CODE_SERVER_NAME};
use crate::commands::memory_server::{self, MCP_PATH, MEMORY_SERVER_NAME};
use crate::commands::org_server::tests::{acme, FakeOrganisation, FakeSessionOrgs};
use crate::commands::org_server::{
    self, OrgScope, OrgTools, EVERY_TIME_TOOLS, ORG_PATH, ORG_SERVER_NAME, OUTWARD_TOOLS,
};
use crate::commands::ui_server::{self, UiBridge, UiTools, UI_PATH, UI_SERVER_NAME};

// ── The four tenants, as the app registers them ──────────────────────────────

/// Everything a tenant's admission reads, each switchable.
#[derive(Clone, Copy)]
struct Settings {
    sharing: bool,
    navigation: bool,
    org_access: bool,
    signed_in: bool,
    /// Whether the Project is bound to a Workspace.
    bound: bool,
    code_tools: bool,
}

const ALL_ON: Settings = Settings {
    sharing: true,
    navigation: true,
    org_access: true,
    signed_in: true,
    bound: true,
    code_tools: true,
};

/// How often each tenant's setting was read.
#[derive(Default)]
struct Reads {
    sharing: Arc<AtomicUsize>,
    navigation: Arc<AtomicUsize>,
    org_access: Arc<AtomicUsize>,
    code_tools: Arc<AtomicUsize>,
    /// The account and the binding, which the organisation tenant reads after
    /// its setting.
    orgs: Option<Arc<FakeSessionOrgs>>,
}

impl Reads {
    fn of(&self, tenant: &str) -> usize {
        let setting = match tenant {
            MEMORY_SERVER_NAME => &self.sharing,
            UI_SERVER_NAME => &self.navigation,
            ORG_SERVER_NAME => &self.org_access,
            CODE_SERVER_NAME => &self.code_tools,
            other => panic!("no setting for {other}"),
        };
        setting.load(Ordering::SeqCst)
    }
}

fn counted(on: bool, reads: &Arc<AtomicUsize>) -> Arc<dyn Fn(&str) -> bool + Send + Sync> {
    let reads = reads.clone();
    Arc::new(move |_: &str| {
        reads.fetch_add(1, Ordering::SeqCst);
        on
    })
}

/// Memory, UI, organisation and code, in the app's order, behind `settings`.
fn four_tenants(settings: Settings) -> (Vec<Tenant>, Reads) {
    let mut reads = Reads::default();
    let window = Arc::new(UiBridge::new(Arc::new(|_| Err("no window".into()))));
    let orgs = FakeSessionOrgs::new(
        settings.signed_in,
        Some(OrgScope {
            workspace_id: settings.bound.then(|| "ws-atlas".to_string()),
            ..acme()
        }),
    );
    reads.orgs = Some(orgs.clone());
    let tenants = vec![
        memory_server::test_tenant(counted(settings.sharing, &reads.sharing)),
        ui_server::tenant(UiTools::new(
            window,
            counted(settings.navigation, &reads.navigation),
        )),
        org_server::tenant(OrgTools::new(
            Arc::new(FakeOrganisation::default()),
            counted(settings.org_access, &reads.org_access),
            orgs,
        )),
        code_server::tenant(CodeTools::new(counted(
            settings.code_tools,
            &reads.code_tools,
        ))),
    ];
    (tenants, reads)
}

const NAMES: [&str; 4] = [
    MEMORY_SERVER_NAME,
    UI_SERVER_NAME,
    ORG_SERVER_NAME,
    CODE_SERVER_NAME,
];
const PATHS: [&str; 4] = [MCP_PATH, UI_PATH, ORG_PATH, CODE_PATH];

// ── A fifth tenant ───────────────────────────────────────────────────────────

/// A tool server that exists only here: one tool, which answers with the
/// session its caller's token names. Everything it says about itself is in
/// this handler and the one `Tenant::new` line that registers it.
#[derive(Clone)]
struct Echo;

const ECHO_NAME: &str = "atlas_echo";
const ECHO_PATH: &str = "/echo";

impl ServerHandler for Echo {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Call whoami.")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools_list(vec![Tool::new(
            Cow::Borrowed("whoami"),
            Cow::Borrowed("The session this call is made in."),
            Arc::new(JsonObject::new()),
        )]))
    }

    async fn call_tool(
        &self,
        _request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = require_grant(&context)?;
        Ok(CallToolResult::success(vec![Content::text(grant.session_id)]).into())
    }
}

fn echo() -> Tenant {
    Tenant::new(ECHO_NAME, ECHO_PATH, Echo)
}

// ── Requests and clients ─────────────────────────────────────────────────────

/// What a connection carries. Never which agent it is: the id below follows
/// `in_process` only so the log lines read like the real ones.
#[derive(Clone, Copy)]
struct Connection {
    in_process: bool,
    http_mcp: bool,
    ui_control: bool,
    org_access: bool,
}

/// The native agent: in this process, carrying both properties.
const NATIVE: Connection = Connection {
    in_process: true,
    http_mcp: true,
    ui_control: true,
    org_access: true,
};

/// An ACP agent that advertised HTTP MCP: another process, carrying neither.
const ACP: Connection = Connection {
    in_process: false,
    http_mcp: true,
    ui_control: false,
    org_access: false,
};

fn request(connection: Connection) -> SessionMcpRequest {
    let agent = if connection.in_process {
        "atlas-agent"
    } else {
        "claude-code"
    };
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new(agent),
        http_mcp: connection.http_mcp,
        ui_control: connection.ui_control,
        org_access: connection.org_access,
        in_process: connection.in_process,
        cwd: std::path::PathBuf::from("/p"),
        session_id: None,
    }
}

async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

// ── The offer matrix ─────────────────────────────────────────────────────────

/// One session request and what the host makes of it.
struct Case {
    what: &'static str,
    connection: Connection,
    settings: Settings,
    /// Whether this binary's path can be found, for the stdio bridge.
    bridge: bool,
    /// Whether the listener has bound.
    running: bool,
    /// Each tenant's decision, in [`NAMES`] order.
    expect: [OfferDecision; 4],
}

impl Case {
    fn new(what: &'static str, connection: Connection, expect: [OfferDecision; 4]) -> Self {
        Self {
            what,
            connection,
            settings: ALL_ON,
            bridge: true,
            running: true,
            expect,
        }
    }

    fn with(mut self, change: impl FnOnce(&mut Settings)) -> Self {
        change(&mut self.settings);
        self
    }
}

const NO_HTTP: OfferDecision = Omitted("agent did not advertise mcpCapabilities.http");
const NO_UI_CONTROL: OfferDecision = Omitted("connection does not carry UI control");
const NO_ORG_ACCESS: OfferDecision = Omitted("connection does not carry organisation access");
const NO_TRANSPORT: OfferDecision = Omitted("no transport reaches the agent");
const NOT_RUNNING: OfferDecision = Omitted("tool server host is not running");

fn cases() -> Vec<Case> {
    vec![
        // Transport × what the connection carries, every setting on.
        Case::new(
            "the native agent is offered all four over HTTP",
            NATIVE,
            [Included; 4],
        ),
        Case::new(
            "an ACP agent is offered memory and code through the bridge, though it advertised HTTP",
            ACP,
            [
                IncludedViaBridge,
                NO_UI_CONTROL,
                NO_ORG_ACCESS,
                IncludedViaBridge,
            ],
        ),
        Case::new(
            "an ACP agent without HTTP MCP is bridged the same",
            Connection {
                http_mcp: false,
                ..ACP
            },
            [IncludedViaBridge, NO_HTTP, NO_HTTP, IncludedViaBridge],
        ),
        Case::new(
            "UI control alone brings the UI server, not the organisation's",
            Connection {
                org_access: false,
                ..NATIVE
            },
            [Included, Included, NO_ORG_ACCESS, Included],
        ),
        Case::new(
            "organisation access alone brings the organisation server, not the UI's",
            Connection {
                ui_control: false,
                ..NATIVE
            },
            [Included, NO_UI_CONTROL, Included, Included],
        ),
        Case::new(
            "an in-process connection carrying neither gets memory and code over HTTP",
            Connection {
                ui_control: false,
                org_access: false,
                ..NATIVE
            },
            [Included, NO_UI_CONTROL, NO_ORG_ACCESS, Included],
        ),
        Case::new(
            "an in-process agent without HTTP MCP is bridged, and a connection property needs HTTP",
            Connection {
                http_mcp: false,
                ..NATIVE
            },
            [IncludedViaBridge, NO_HTTP, NO_HTTP, IncludedViaBridge],
        ),
        // No connection is like this today (ADR-0012, ADR-0014: only the
        // in-process one carries either property). The rule is the
        // connection's properties all the same, never where the agent runs.
        Case::new(
            "a connection in another process that carried both would be bridged all four",
            Connection {
                in_process: false,
                ..NATIVE
            },
            [IncludedViaBridge; 4],
        ),
        // Each tenant's own admission, one switch at a time.
        Case::new(
            "shared memory off leaves memory out, and only memory",
            NATIVE,
            [
                Omitted("shared memory is off for this project"),
                Included,
                Included,
                Included,
            ],
        )
        .with(|s| s.sharing = false),
        Case::new(
            "navigation off leaves the UI server out",
            NATIVE,
            [
                Included,
                Omitted("agent navigation is off in Settings"),
                Included,
                Included,
            ],
        )
        .with(|s| s.navigation = false),
        Case::new(
            "organisation access off leaves the organisation server out",
            NATIVE,
            [
                Included,
                Included,
                Omitted("organisation access is off in Settings"),
                Included,
            ],
        )
        .with(|s| s.org_access = false),
        Case::new(
            "signed out, the organisation server is left out",
            NATIVE,
            [Included, Included, Omitted("not signed in"), Included],
        )
        .with(|s| s.signed_in = false),
        Case::new(
            "a Project bound to no Workspace is left out of the organisation",
            NATIVE,
            [
                Included,
                Included,
                Omitted("project is not bound to a cloud Workspace"),
                Included,
            ],
        )
        .with(|s| s.bound = false),
        Case::new(
            "code tools off leaves the code server out",
            NATIVE,
            [
                Included,
                Included,
                Included,
                Omitted("code tools are off in Settings"),
            ],
        )
        .with(|s| s.code_tools = false),
        Case::new(
            "for an ACP agent, shared memory off still leaves code (ADR-0015)",
            ACP,
            [
                Omitted("shared memory is off for this project"),
                NO_UI_CONTROL,
                NO_ORG_ACCESS,
                IncludedViaBridge,
            ],
        )
        .with(|s| s.sharing = false),
        Case::new(
            "for an ACP agent, everything off offers nothing",
            ACP,
            [
                Omitted("shared memory is off for this project"),
                NO_UI_CONTROL,
                NO_ORG_ACCESS,
                Omitted("code tools are off in Settings"),
            ],
        )
        .with(|s| {
            s.sharing = false;
            s.code_tools = false;
        }),
        // The host's own two reasons.
        Case {
            bridge: false,
            ..Case::new(
                "an agent in another process, and no path to this binary: nothing",
                ACP,
                [NO_TRANSPORT; 4],
            )
        },
        Case {
            bridge: false,
            ..Case::new("the native agent needs no bridge", NATIVE, [Included; 4])
        },
        Case {
            running: false,
            ..Case::new(
                "before the listener binds, nothing is offered",
                NATIVE,
                [NOT_RUNNING; 4],
            )
        },
        Case {
            running: false,
            ..Case::new(
                "before the listener binds, a tenant's own reason still comes first",
                ACP,
                [NOT_RUNNING, NO_UI_CONTROL, NO_ORG_ACCESS, NOT_RUNNING],
            )
        },
    ]
}

/// Transport × what the connection carries × each tenant's admission → which
/// tenants a session is offered, how, on what grant, and asking what first.
#[tokio::test(flavor = "multi_thread")]
async fn what_a_session_is_offered() {
    for case in cases() {
        let what = case.what;
        let (tenants, reads) = four_tenants(case.settings);
        let host = if case.running {
            ToolServerHost::running(tenants).await
        } else {
            ToolServerHost::registered(tenants)
        };
        let mut offers = SessionOffers::new(host.clone());
        if !case.bridge {
            offers = offers.without_bridge();
        }
        let request = request(case.connection);

        // The decisions, tenant by tenant.
        let decided = offers.decide(&request);
        let got: Vec<(&str, OfferDecision)> = decided
            .decisions
            .iter()
            .map(|(tenant, decision)| (tenant.name(), *decision))
            .collect();
        let expected: Vec<(&str, OfferDecision)> = NAMES.into_iter().zip(case.expect).collect();
        assert_eq!(got, expected, "{what}");

        // A setting is read only for a connection that could use the tenant.
        for (name, decision) in &expected {
            let outside = matches!(
                *decision,
                NO_HTTP | NO_UI_CONTROL | NO_ORG_ACCESS | NO_TRANSPORT
            );
            assert_eq!(
                reads.of(name) == 0,
                outside,
                "{what}: {name}'s setting read {} time(s)",
                reads.of(name)
            );
        }
        let orgs = reads.orgs.as_ref().expect("the organisation's account");
        if matches!(
            case.expect[2],
            NO_HTTP | NO_UI_CONTROL | NO_ORG_ACCESS | NO_TRANSPORT
        ) || !case.settings.org_access
        {
            assert_eq!(
                orgs.reads.load(Ordering::SeqCst),
                0,
                "{what}: neither the account nor the binding was read"
            );
        }

        // The entries: the included tenants, in order, each at its own path,
        // all by one transport and on one token.
        let offer = offers.offer(&request);
        let entries = offered_entries(&offer);
        let included: Vec<(&str, &str)> = NAMES
            .into_iter()
            .zip(PATHS)
            .zip(case.expect)
            .filter(|(_, decision)| decision.includes())
            .map(|(tenant, _)| tenant)
            .collect();
        assert_eq!(
            entries
                .iter()
                .map(|(name, url, _)| (name.clone(), Some(url.clone())))
                .collect::<Vec<_>>(),
            included
                .iter()
                .map(|(name, path)| (name.to_string(), host.url_at(path)))
                .collect::<Vec<_>>(),
            "{what}"
        );
        let over_http = case.expect.contains(&Included);
        for server in offer.servers() {
            assert_eq!(
                matches!(server, acp::McpServer::Http(_)),
                over_http,
                "{what}: {server:?}"
            );
            assert_eq!(
                matches!(server, acp::McpServer::Stdio(_)),
                !over_http,
                "{what}: {server:?}"
            );
        }
        let Some((_, _, token)) = entries.first() else {
            assert_eq!(offer.ask_first(), &atlas_agent_servers::AskFirst::none());
            continue;
        };
        assert!(
            entries.iter().all(|(_, _, t)| t == token),
            "{what}: one token for every entry"
        );

        // The grant carries what the included tenants stamped, and nothing
        // from the rest.
        let grant = host.tokens().grant(token).expect("a live token");
        assert_eq!(grant.ui, case.expect[1].includes(), "{what}");
        assert_eq!(
            grant.org,
            case.expect[2].includes().then(acme),
            "{what}: the organisation the Project is bound to"
        );

        // Only the organisation's outward actions ask first, and only while
        // it is offered.
        let asking: Vec<&str> = offer.ask_first().tools_on(ORG_SERVER_NAME).collect();
        if case.expect[2].includes() {
            assert_eq!(asking, OUTWARD_TOOLS, "{what}");
            for tool in EVERY_TIME_TOOLS {
                assert!(offer.ask_first().asks_every_time(ORG_SERVER_NAME, tool));
            }
        } else {
            assert!(asking.is_empty(), "{what}");
            assert_eq!(offer.ask_first().every_time_tools().count(), 0, "{what}");
        }
    }
}

/// One line per tenant per session request: the agent, what its connection
/// carries that the tenant turns on, and the outcome. ADR-0020 quotes it.
#[test]
fn each_decision_is_one_log_line() {
    let (tenants, _) = four_tenants(ALL_ON);
    let [memory, ui, org, code] = tenants.as_slice() else {
        panic!("four tenants")
    };
    let no_http = Connection {
        http_mcp: false,
        ..ACP
    };
    for (tenant, decision, connection, line) in [
        (
            memory,
            Included,
            NATIVE,
            "memory tool server offer: agent=atlas-agent http_mcp=true memory_server=included",
        ),
        // An ACP agent that advertised HTTP is bridged all the same.
        (
            memory,
            IncludedViaBridge,
            ACP,
            "memory tool server offer: agent=claude-code http_mcp=true memory_server=included_via_bridge",
        ),
        (
            memory,
            IncludedViaBridge,
            no_http,
            "memory tool server offer: agent=claude-code http_mcp=false memory_server=included_via_bridge",
        ),
        (
            memory,
            Omitted("shared memory is off for this project"),
            NATIVE,
            "memory tool server offer: agent=atlas-agent http_mcp=true memory_server=omitted \
             reason=\"shared memory is off for this project\"",
        ),
        (
            ui,
            Included,
            NATIVE,
            "ui tool server offer: agent=atlas-agent http_mcp=true ui_control=true ui_server=included",
        ),
        (
            ui,
            NO_UI_CONTROL,
            ACP,
            "ui tool server offer: agent=claude-code http_mcp=true ui_control=false ui_server=omitted \
             reason=\"connection does not carry UI control\"",
        ),
        (
            org,
            Included,
            NATIVE,
            "org tool server offer: agent=atlas-agent http_mcp=true org_access=true org_server=included",
        ),
        (
            org,
            NO_ORG_ACCESS,
            ACP,
            "org tool server offer: agent=claude-code http_mcp=true org_access=false org_server=omitted \
             reason=\"connection does not carry organisation access\"",
        ),
        (
            code,
            IncludedViaBridge,
            ACP,
            "code tool server offer: agent=claude-code http_mcp=true code_server=included_via_bridge",
        ),
        (
            code,
            Omitted("x"),
            no_http,
            "code tool server offer: agent=claude-code http_mcp=false code_server=omitted reason=\"x\"",
        ),
    ] {
        assert_eq!(decision.log_line(tenant, &request(connection)), line);
    }
}

// ── The session policy ───────────────────────────────────────────────────────

/// Every tenant is mounted on a session manager the host made, so all of
/// them keep an idle session, and a tenant cannot be mounted on another: it
/// never makes one. rmcp's default would drop a session idle for five
/// minutes (`SessionConfig::DEFAULT_KEEP_ALIVE`).
#[tokio::test(flavor = "multi_thread")]
async fn no_tenants_sessions_idle_out() {
    let (mut tenants, _) = four_tenants(ALL_ON);
    tenants.push(echo());
    let host = ToolServerHost::running(tenants).await;
    for name in NAMES.into_iter().chain([ECHO_NAME]) {
        assert_eq!(
            host.server().keep_alive_of(name),
            Some(None),
            "{name} keeps an idle session"
        );
    }
    assert_eq!(host.server().keep_alive_of("atlas_absent"), None);
}

// ── One token per session ────────────────────────────────────────────────────

/// #86: ACP scopes a session id to its connection, so two agents can both
/// answer `"1"`. Each one's offer binds its own token: the second bind is not
/// a rebind of the first agent's session, and the first agent's session
/// ending revokes only its own token.
#[tokio::test(flavor = "multi_thread")]
async fn two_agents_with_the_same_session_id_keep_their_own_mcp_tokens() {
    let (tenants, _) = four_tenants(ALL_ON);
    let host = ToolServerHost::running(tenants).await;
    let offers = SessionOffers::new(host.clone());
    let session = acp::SessionId::new("1");

    let native = offers.offer(&request(NATIVE));
    let native_token = offered_entries(&native)[0].2.clone();
    native.bind(&session);
    let acp_offer = offers.offer(&request(ACP));
    let acp_token = offered_entries(&acp_offer)[0].2.clone();
    acp_offer.bind(&session);

    assert_ne!(native_token, acp_token);
    let tokens = host.tokens();
    assert_eq!(
        tokens.token_of("atlas-agent", "1"),
        Some(native_token.clone()),
        "the second agent's bind left the first agent's token live"
    );
    assert_eq!(tokens.token_of("claude-code", "1"), Some(acp_token.clone()));
    assert!(tokens.grant(&native_token).is_some());
    assert_eq!(
        tokens.grant_for_session("1"),
        None,
        "a bare id two agents share answers under neither grant"
    );

    crate::commands::agent_host::SessionLifecycle::session_ended(&**tokens, "1", "claude-code");
    assert!(
        tokens.grant(&acp_token).is_none(),
        "its own token is revoked"
    );
    assert!(
        tokens.grant(&native_token).is_some(),
        "the other agent's session keeps its token"
    );
}

/// The session's one token opens every tenant; a token the host never minted
/// opens none; and when the session ends its token stops working on all of
/// them at once, even on a connection it already opened.
#[tokio::test(flavor = "multi_thread")]
async fn every_tenant_admits_the_sessions_token_and_no_other() {
    let (mut tenants, _) = four_tenants(ALL_ON);
    tenants.push(echo());
    let host = ToolServerHost::running(tenants).await;
    let offers = SessionOffers::new(host.clone());
    let offer = offers.offer(&request(NATIVE));
    let token = offered_entries(&offer)[0].2.clone();
    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(host.tokens().token_for("s1"), Some(token.clone()));
    // Another session's token is another token, live on its own.
    let other = host.tokens().mint("s2", "claude-code", "/q");

    let mut open = Vec::new();
    for path in PATHS.into_iter().chain([ECHO_PATH]) {
        let url = host.url_at(path).expect("the host is running");
        assert!(
            connect(&url, "not-a-token").await.is_err(),
            "{path} admitted a token nobody minted"
        );
        let client = connect(&url, &token)
            .await
            .unwrap_or_else(|e| panic!("{path} refused the session's token: {e}"));
        let tools = client.list_all_tools().await.unwrap();
        let tool = tools.first().expect("a tenant has tools").name.to_string();
        open.push((path, url, client, tool));
    }

    host.tokens().revoke("atlas-agent", "s1");
    for (path, url, client, tool) in open {
        // A call, not a list: the client answers a list from its cache.
        let refused = client
            .call_tool(CallToolRequestParams::new(tool).with_arguments(JsonObject::new()))
            .await;
        assert!(
            refused.is_err(),
            "{path} still answers a revoked token on an open connection: {refused:?}"
        );
        assert!(
            connect(&url, &token).await.is_err(),
            "{path} admitted a revoked token"
        );
        // Revoking one session's token leaves another's alone.
        let theirs = connect(&url, &other)
            .await
            .unwrap_or_else(|e| panic!("{path} refused another live session: {e}"));
        theirs.cancel().await.ok();
    }
}

/// No `Authorization`, or anything but `Bearer <live token>`, is a 401 before
/// any MCP handling, on every tenant's path.
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_non_bearer_authorization_is_refused_on_every_path() {
    let (mut tenants, _) = four_tenants(ALL_ON);
    tenants.push(echo());
    let host = ToolServerHost::running(tenants).await;
    let token = host.tokens().mint("s1", "atlas-agent", "/p");
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } });
    let http = reqwest::Client::new();
    for path in PATHS.into_iter().chain([ECHO_PATH]) {
        for auth in [
            None,
            Some(format!("Basic {token}")),
            Some(token.clone()),
            Some("Bearer ".to_string()),
        ] {
            let mut req = http
                .post(host.url_at(path).unwrap())
                .header("Accept", "application/json, text/event-stream")
                .json(&init);
            if let Some(auth) = &auth {
                req = req.header("Authorization", auth);
            }
            let status = req.send().await.unwrap().status();
            assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED, "{path} {auth:?}");
        }
    }
}

// ── A fifth tenant ───────────────────────────────────────────────────────────

/// A new tool server is its handler and one line: the host gives it the
/// listener, the token, the grant in its handler, both transports and the
/// log line.
#[tokio::test(flavor = "multi_thread")]
async fn a_fifth_tenant_registers_with_only_its_own_facts() {
    let (mut tenants, _) = four_tenants(ALL_ON);
    tenants.push(echo());
    let host = ToolServerHost::running(tenants).await;
    let offers = SessionOffers::new(host.clone());

    // Offered to the native agent over HTTP, after the four.
    let offer = offers.offer(&request(NATIVE));
    let entries = offered_entries(&offer);
    let (name, url, token) = entries.last().unwrap().clone();
    assert_eq!(entries.len(), 5);
    assert_eq!(
        (name.as_str(), Some(url.clone())),
        (ECHO_NAME, host.url_at(ECHO_PATH))
    );
    offer.bind(&acp::SessionId::new("s-native"));

    // Its handler is handed the session's grant.
    let client = connect(&url, &token).await.unwrap();
    let list = client.list_tools(Default::default()).await.unwrap();
    assert_eq!(list.ttl_ms, Some(TOOLS_LIST_TTL_MS));
    let answer = client
        .call_tool(CallToolRequestParams::new("whoami"))
        .await
        .unwrap();
    assert_eq!(
        answer.content[0].as_text().map(|t| t.text.as_str()),
        Some("s-native")
    );
    client.cancel().await.ok();

    // And to an ACP agent through the bridge, on that session's one token.
    let offer = offers.offer(&request(ACP));
    let entries = offered_entries(&offer);
    assert_eq!(
        entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        [MEMORY_SERVER_NAME, CODE_SERVER_NAME, ECHO_NAME]
    );
    assert!(offer
        .servers()
        .iter()
        .all(|s| matches!(s, acp::McpServer::Stdio(_))));
    assert_eq!(entries[0].2, entries[2].2);

    let decided = offers.decide(&request(ACP));
    let (tenant, decision) = decided.decisions.last().unwrap();
    assert_eq!(
        decision.log_line(tenant, &request(ACP)),
        "echo tool server offer: agent=claude-code http_mcp=true echo_server=included_via_bridge"
    );
}

/// What a tenant may narrow: who it is for, and when it is on.
#[tokio::test(flavor = "multi_thread")]
async fn a_tenant_narrows_its_own_audience_and_admission() {
    let off: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(|_| false);
    let host = ToolServerHost::running(vec![
        echo().only_for(Audience::UiControl),
        Tenant::new("atlas_quiet", "/quiet", Echo).gated_by(off, "quiet is off"),
    ])
    .await;
    let offers = SessionOffers::new(host);
    let decisions = |connection| {
        offers
            .decide(&request(connection))
            .decisions
            .iter()
            .map(|(_, decision)| *decision)
            .collect::<Vec<_>>()
    };
    assert_eq!(decisions(NATIVE), [Included, Omitted("quiet is off")]);
    assert_eq!(decisions(ACP), [NO_UI_CONTROL, Omitted("quiet is off")]);
}

/// Two tenants at one path, or under one name, would shadow each other; the
/// listener refuses to start instead.
#[tokio::test(flavor = "multi_thread")]
async fn two_tenants_cannot_share_a_name_or_a_path() {
    let tokens = Arc::new(SessionTokens::default());
    for clash in [
        Tenant::new(ECHO_NAME, "/elsewhere", Echo),
        Tenant::new("atlas_other", ECHO_PATH, Echo),
    ] {
        let started = ToolServer::start(tokens.clone(), &[echo(), clash]).await;
        assert!(started.is_err());
    }
}
