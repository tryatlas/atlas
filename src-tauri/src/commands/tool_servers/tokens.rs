//! Session tokens: who is calling the memory tools, and for which scope.
//!
//! One bearer token per (session, scope). A session runs in one launch
//! directory, hence one scope, so the table is keyed by session — by its
//! agent and its id, since ACP scopes a session id to its connection and two
//! agents can both mint `"1"` (#86); a session
//! rebound elsewhere gets a fresh token for the new scope and the old one is
//! revoked. A token is minted when the session starts and revoked when it
//! ends, through the [`SessionLifecycle`] hook that also records the session
//! in shared memory. Every HTTP request is checked against the live tokens,
//! so a revoked token stops working at once, even on an MCP session it
//! opened. The token says who is calling: its session, that session's agent
//! (the source of its writes) and its launch directory (which scope's record).

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use parking_lot::Mutex;

use crate::commands::agent_host::SessionLifecycle;
use crate::commands::org_server::OrgScope;

/// What a token grants: tool access to one scope's memory, as one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub session_id: String,
    /// The durable agent id owning the session; the source of its writes.
    pub agent: String,
    /// The session's launch directory; resolves to the scope's record.
    pub cwd: String,
    /// The organisation and Workspace the session's Project is bound to,
    /// resolved when the offer that minted this token was decided (ADR-0014).
    /// `None` for a session not handed the organisation tool server — and for
    /// a token the session lifecycle minted, which never carries one: a
    /// session that moved to another directory moved to another Project, and
    /// is not in the organisation it was offered until it is offered again.
    /// The organisation tools act in this one and in no other.
    pub org: Option<OrgScope>,
    /// Whether the offer that minted this token included the UI tool server
    /// (ADR-0012). One token opens every service on the listener, so the UI
    /// tools check this rather than trusting that only an offered session
    /// would find `/ui`: an ACP session's memory token must not drive the
    /// window. `false` for a token the session lifecycle minted, as for `org`.
    pub ui: bool,
}

/// A session's key in the table: its agent's durable id and its session id.
type SessionKey = (String, String);

fn key(agent: &str, session_id: &str) -> SessionKey {
    (agent.to_string(), session_id.to_string())
}

#[derive(Default)]
struct TokenTable {
    by_token: HashMap<String, Grant>,
    by_session: HashMap<SessionKey, String>,
}

impl TokenTable {
    /// The one session holding the bare `session_id`; `None` when no agent's
    /// or several agents' sessions do.
    fn sole_session(&self, session_id: &str) -> Option<&String> {
        let mut holders = self
            .by_session
            .iter()
            .filter(|((_, id), _)| id == session_id)
            .map(|(_, token)| token);
        let token = holders.next()?;
        holders.next().is_none().then_some(token)
    }
}

/// The live bearer tokens: one per session, minted at session start and
/// revoked at session end. Cheap to share (`Arc`).
#[derive(Default)]
pub struct SessionTokens {
    table: Mutex<TokenTable>,
}

impl SessionTokens {
    /// Mint `session_id`'s token, revoking any earlier one it had (a session
    /// rebound in another directory gets a token for that scope).
    // Outside tests only the lifecycle mints (through `mint_locked`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mint(&self, session_id: &str, agent: &str, cwd: &str) -> String {
        Self::mint_locked(&mut self.table.lock(), session_id, agent, cwd)
    }

    fn mint_locked(table: &mut TokenTable, session_id: &str, agent: &str, cwd: &str) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        if let Some(old) = table.by_session.remove(&key(agent, session_id)) {
            table.by_token.remove(&old);
        }
        table.by_token.insert(
            token.clone(),
            Grant {
                session_id: session_id.to_string(),
                agent: agent.to_string(),
                cwd: cwd.to_string(),
                org: None,
                ui: false,
            },
        );
        table
            .by_session
            .insert(key(agent, session_id), token.clone());
        token
    }

    /// Mint a token for a session request whose session id is not known yet
    /// (a new session's arrives with the agent's answer). Live at once, so an
    /// agent that connects while opening the session is admitted; it names no
    /// session until [`bind`](Self::bind). `org` is the organisation the offer
    /// resolved from the session's Project binding, carried from the first
    /// request, so an organisation tool called before the bind already knows
    /// where it acts.
    pub fn mint_unbound(&self, agent: &str, cwd: &str, org: Option<OrgScope>, ui: bool) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.table.lock().by_token.insert(
            token.clone(),
            Grant {
                session_id: String::new(),
                agent: agent.to_string(),
                cwd: cwd.to_string(),
                org,
                ui,
            },
        );
        token
    }

    /// [`mint`](Self::mint), for a session offered the UI tool server.
    #[cfg(test)]
    pub fn mint_with_ui(&self, session_id: &str, agent: &str, cwd: &str) -> String {
        let mut table = self.table.lock();
        let token = Self::mint_locked(&mut table, session_id, agent, cwd);
        if let Some(grant) = table.by_token.get_mut(&token) {
            grant.ui = true;
        }
        token
    }

    /// Make `token` the token of `session_id` — of the agent the token was
    /// minted for — revoking any other that session had. Another agent's
    /// session by the same id keeps its own (#86). Does nothing for a token
    /// that is no longer live.
    pub fn bind(&self, token: &str, session_id: &str) {
        let mut table = self.table.lock();
        let Some(grant) = table.by_token.get_mut(token) else {
            return;
        };
        grant.session_id = session_id.to_string();
        let session = key(&grant.agent, session_id);
        if let Some(old) = table.by_session.insert(session, token.to_string()) {
            if old != token {
                table.by_token.remove(&old);
            }
        }
    }

    /// Revoke one token, whichever session (if any) it belongs to. Idempotent.
    pub fn revoke_token(&self, token: &str) {
        let mut table = self.table.lock();
        if let Some(grant) = table.by_token.remove(token) {
            let session = key(&grant.agent, &grant.session_id);
            if table.by_session.get(&session).is_some_and(|t| t == token) {
                table.by_session.remove(&session);
            }
        }
    }

    /// The live token of `session_id`, if it has one — what the session's MCP
    /// server entry carries.
    ///
    /// Also the honest test for "was this session given memory at all".
    /// By the bare id: answers only when one agent's session holds it.
    #[cfg(test)]
    pub fn token_for(&self, session_id: &str) -> Option<String> {
        self.table.lock().sole_session(session_id).cloned()
    }

    /// [`token_for`](Self::token_for), for one agent's session.
    #[cfg(test)]
    pub fn token_of(&self, agent: &str, session_id: &str) -> Option<String> {
        self.table
            .lock()
            .by_session
            .get(&key(agent, session_id))
            .cloned()
    }

    /// What `session_id`'s live token grants, if it has one — the grant a
    /// call from that session is answered under, read without its token: the
    /// native seam asks about a waiting call by session (an outward action's
    /// approval card, ADR-0014). By the bare id, so `None` when two agents'
    /// sessions share it: guessing would answer under the wrong grant.
    pub fn grant_for_session(&self, session_id: &str) -> Option<Grant> {
        let table = self.table.lock();
        let token = table.sole_session(session_id)?;
        table.by_token.get(token).cloned()
    }

    /// Revoke `agent`'s session `session_id`'s token. Idempotent.
    pub fn revoke(&self, agent: &str, session_id: &str) {
        let mut table = self.table.lock();
        if let Some(token) = table.by_session.remove(&key(agent, session_id)) {
            table.by_token.remove(&token);
        }
    }

    /// What `token` grants, if it is live.
    pub fn grant(&self, token: &str) -> Option<Grant> {
        self.table.lock().by_token.get(token).cloned()
    }
}

/// A session gets its token when it starts and loses it when it ends.
impl SessionLifecycle for SessionTokens {
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        if cwd.is_empty() {
            return;
        }
        // A rebind of a live session in the same place keeps its token — and
        // so does the start reported right after an offer was bound to it:
        // that token is the one the agent holds. Compared as paths, so a
        // trailing separator is not a move.
        let mut table = self.table.lock();
        let same = table
            .by_session
            .get(&key(agent, session_id))
            .and_then(|t| table.by_token.get(t))
            .is_some_and(|g| {
                std::path::Path::new(&g.cwd) == std::path::Path::new(cwd) && g.agent == agent
            });
        if !same {
            Self::mint_locked(&mut table, session_id, agent, cwd);
        }
    }

    fn session_ended(&self, session_id: &str, agent: &str) {
        self.revoke(agent, session_id);
    }
}

/// Admit a request only with `Authorization: Bearer <live token>`; hand the
/// token's [`Grant`] to the tool handler through the request extensions.
pub(super) async fn require_token(
    State(tokens): State<Arc<SessionTokens>>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let grant = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| tokens.grant(token.trim()));
    match grant {
        Some(grant) => {
            request.extensions_mut().insert(grant);
            Ok(next.run(request).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}
