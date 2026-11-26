//! The session registry: one owner for a session's lifecycle.
//!
//! [`AgentManager`] keeps each open session's thread. Everything else a host
//! keeps per session used to sit in maps of its own, each cleared by hand
//! wherever a session ended: who opened it and where, who is holding it open
//! without its tab, the turn it is on, and whatever the host hangs off it
//! (its prompt queue, its remote-control seat). This module is those maps
//! and the manager's table behind one interface, so that a session is bound
//! in one place and ended in one place.
//!
//! # Ending
//!
//! A session ends one of three ways ([`EndKind`]), and each is one call:
//!
//! - [`SessionRegistry::close`]: the window let it go. A held session is only
//!   marked; the last hold's [`SessionRegistry::release`] finishes it.
//! - [`SessionRegistry::end_agent`]: its agent is going or gone, and every
//!   session on it with it.
//! - [`SessionRegistry::end_all`]: the app is quitting.
//!
//! Each call does the whole of the registry's part in one step, under one
//! lock, and then the manager's:
//!
//! 1. the session's record goes, and its holds with it;
//! 2. its [`SessionExtra`] is asked what survives ([`SessionExtra::survives`])
//!    and dropped if nothing does;
//! 3. every bind still in flight that the end covers is cancelled, so the
//!    session it would have opened is refused when it lands
//!    ([`SessionRegistry::bind`]);
//! 4. the manager lets go: of the one thread (`close`), of the connection and
//!    every thread on it (`end_agent`), or of everything (`end_all`).
//!
//! What is left is work only the caller can do, because it lives above this
//! crate: the wire projection, the history store, whoever listens for a
//! session's end, the agent's own `session/close`. It is handed back as
//! [`Ended::follow_ups`], **in the order it must be done**, and the caller
//! does exactly that list. No call site decides the order, or which steps
//! apply; a step that must not happen for one kind of end is absent from
//! that kind's list.
//!
//! | step                         | `close` | `end_agent`       | `end_all` |
//! | ---------------------------- | ------- | ----------------- | --------- |
//! | [`FollowUp::NoticeDisconnected`] | no  | first, if given   | no        |
//! | [`FollowUp::AnnounceEnded`]  | 1st     | last              | only      |
//! | [`FollowUp::ForgetHistoryBinding`] | 2nd | no (the rebind needs it) | no |
//! | [`FollowUp::CloseProjection`] | 3rd    | after the notice  | no (the caller empties the projector whole) |
//! | [`FollowUp::CloseOnAgent`]   | last, for a bound thread | no (the process is going) | no |
//!
//! Ending twice is a no-op: the second call finds no record and returns
//! nothing to do.
//!
//! # Locks
//!
//! Two, both private to this module. `state` is taken first; `binds` and the
//! manager's own table locks are taken under it and never the other way
//! round (the manager knows nothing of this module, so it cannot).
//!
//! - `state` holds the records and the extras together. They were three maps
//!   under three locks (records, turn controllers, seats), and every reader
//!   that needed two took them one after the other; behind one lock a hold,
//!   a queue and a seat cannot disagree about whether their session exists.
//!   None of them is on the streaming path: a streamed chunk goes through
//!   the projector and never asks the registry anything. What does take the
//!   lock is per turn or per command (a send, a queue edit, a snapshot).
//! - `binds` is separate only so that a dropped [`BindTicket`] can take
//!   itself out without knowing the registry's type.
//!
//! An end holds `state` across its manager step (dropping a thread, a
//! connection, or everything), and a bind takes its ticket and lands under
//! `state` too. That is what makes an end one step to everyone else: a bind
//! either began before the end, and is refused when it lands, or begins
//! after all of it, on whatever connection is there then. Those manager
//! calls only edit its tables; none waits, and none calls back.
//!
//! `state` is never held across anything that can wait or call back: not a
//! thread's lock, not an RPC, not the caller. The one closure that runs
//! under it is the one given to [`SessionRegistry::with_extra`] /
//! [`SessionRegistry::extra_mut`], which must only touch the extra it is
//! handed: no I/O, no call back into the registry.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::SystemTime;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThreadHandle, AgentConnection};

use crate::manager::{Agent, AgentManager};

/// The way a session ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndKind {
    /// The session itself was closed: its tab went and nothing holds it.
    Closed,
    /// Its agent's process is going or gone. The session can come back: a
    /// tab rebinds it (respawn, then `session/load`) on its next send.
    AgentGone,
    /// The app is quitting.
    Quit,
}

/// What a host hangs off a session beyond its record: state that may outlive
/// the record (a prompt queue waiting for the rebind), so it is kept beside
/// it rather than in it.
pub trait SessionExtra: Default + Send + 'static {
    /// The session ended. Trim whatever does not survive that kind of end,
    /// and answer whether anything is left worth keeping; `false` drops the
    /// extra. Not asked for [`EndKind::Quit`], which keeps nothing.
    fn survives(&mut self, end: EndKind) -> bool;
}

impl SessionExtra for () {
    fn survives(&mut self, _end: EndKind) -> bool {
        false
    }
}

/// What a session is bound with.
#[derive(Clone, Debug)]
pub struct SessionMeta {
    pub agent: Agent,
    /// The agent's durable id, as history and capture label a session.
    pub plugin_id: String,
    pub cwd: String,
}

/// One open session, as a caller reads it.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub agent: Agent,
    pub plugin_id: String,
    pub cwd: String,
    /// The model the user picked through the host, if they picked one.
    pub current_model: Option<String>,
    /// The turn the session is on; see [`SessionRegistry::next_turn_seq`].
    pub turn_seq: u64,
    pub created_at: SystemTime,
    /// Whether any hold keeps it open without its tab.
    pub held: bool,
}

struct Record {
    agent: Agent,
    plugin_id: String,
    cwd: String,
    current_model: Option<String>,
    turn_seq: u64,
    created_at: SystemTime,
    /// Who is keeping this session open without its tab.
    holds: BTreeSet<String>,
    /// The window let this session go while it was held. The last hold's
    /// release finishes the close.
    released_by_window: bool,
}

/// One thing left to do for a session that ended. See the module docs for
/// which kinds of end produce which, and in what order.
#[derive(Clone)]
pub enum FollowUp {
    /// Tell the session's clients its agent is gone, and why. First, because
    /// it travels on the projection a later step closes.
    NoticeDisconnected { reason: String },
    /// Tell whoever records or watches session ends that this one ended.
    AnnounceEnded,
    /// Drop the live binding between the session and its history row.
    ForgetHistoryBinding,
    /// Drop the wire projection, which owns the thread and through it the
    /// connection.
    CloseProjection,
    /// Release the connection's local session handle. `release_session` also
    /// asks the agent to close its side when it advertised `session/close`.
    CloseOnAgent {
        connection: Arc<dyn AgentConnection>,
    },
}

impl std::fmt::Debug for FollowUp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoticeDisconnected { reason } => write!(f, "NoticeDisconnected({reason:?})"),
            Self::AnnounceEnded => f.write_str("AnnounceEnded"),
            Self::ForgetHistoryBinding => f.write_str("ForgetHistoryBinding"),
            Self::CloseProjection => f.write_str("CloseProjection"),
            Self::CloseOnAgent { .. } => f.write_str("CloseOnAgent"),
        }
    }
}

/// A session that ended, and what is left to do about it.
#[derive(Clone, Debug)]
pub struct Ended {
    pub session_id: String,
    pub agent: Agent,
    pub kind: EndKind,
    /// In the order they must be done.
    pub follow_ups: Vec<FollowUp>,
}

/// What became of a [`SessionRegistry::close`].
#[derive(Debug)]
pub enum Closed {
    /// No such session: never bound, or already ended.
    Unknown,
    /// A hold keeps it running. The close is remembered, and the last hold's
    /// release finishes it.
    Held,
    Ended(Ended),
}

/// What became of a [`SessionRegistry::release`].
#[derive(Debug)]
pub enum Released {
    /// That hold was not taken, or the session is gone.
    NotHeld,
    /// Another hold is still taken.
    StillHeld,
    /// The last hold went and the window still has the session.
    Last,
    /// The last hold went after the window had let the session go, so it
    /// ended with it.
    LastAndEnded(Ended),
}

/// How an agent's sessions are ended ([`SessionRegistry::end_agent`]).
#[derive(Clone, Debug)]
pub struct AgentEnd {
    /// What each session's clients are told, when they are told anything.
    pub notice: Option<String>,
    /// Whether the connection is still to be dropped. `false` when the
    /// manager already dropped it (the process exited): dropping "the
    /// agent's connection" then could only take a newer one, started since.
    pub drop_connection: bool,
}

impl AgentEnd {
    /// The agent is being stopped: drop its connection.
    pub fn stopping() -> Self {
        Self {
            notice: None,
            drop_connection: true,
        }
    }

    /// The agent's process already exited and the manager dropped its
    /// connection.
    pub fn exited() -> Self {
        Self {
            notice: None,
            drop_connection: false,
        }
    }

    /// Tell every session on it why, before its projection closes.
    pub fn with_notice(mut self, reason: impl Into<String>) -> Self {
        self.notice = Some(reason.into());
        self
    }
}

/// A bind in flight: taken before the agent is asked to open a session,
/// redeemed by [`SessionRegistry::bind`] once it has.
///
/// The gap between the two is an RPC, and a session can be ended across it:
/// its agent killed, the tab that asked for it closed. The ticket is how the
/// registry remembers that, so the session the agent eventually opens is
/// refused instead of bound into a table that already gave it up. Dropping a
/// ticket (the open failed) takes it out of the registry.
pub struct BindTicket {
    id: u64,
    binds: Weak<Mutex<Binds>>,
}

impl Drop for BindTicket {
    fn drop(&mut self) {
        if let Some(binds) = self.binds.upgrade() {
            lock(&binds).in_flight.remove(&self.id);
        }
    }
}

/// A bind that landed after its session was ended. The session the agent
/// opened is not bound, and nothing was set up for it: a host asks the
/// registry before it writes anything of its own for the session. What a host
/// holds under this session id may belong to a newer bind of it, which is why
/// a refusal never asks for anything to be undone by id.
#[derive(Debug)]
pub struct BindRefused {
    /// The end that covered the bind.
    pub ended_by: EndKind,
    /// [`FollowUp::CloseOnAgent`] or nothing: the agent's side of the session
    /// it opened is all there is to discard.
    pub follow_ups: Vec<FollowUp>,
}

impl std::fmt::Display for BindRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.ended_by {
            EndKind::Closed => "the session was closed while it was opening",
            EndKind::AgentGone => "the agent was stopped while the session was opening",
            EndKind::Quit => "Atlas is quitting",
        })
    }
}

impl std::error::Error for BindRefused {}

/// Everything the registry and the manager still hold for one session id.
/// For tests and diagnostics: a session that ended reads as the default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Residue {
    pub bound: bool,
    pub holds: Vec<String>,
    pub released_by_window: bool,
    /// Whether a [`SessionExtra`] is kept for it.
    pub extra: bool,
    /// Binds in flight that named this session id.
    pub binds_in_flight: usize,
    /// Whether the manager still has a thread under this id, for any agent.
    pub manager_handle: bool,
}

/// A record's key: ACP scopes a session id to its connection, so two agents
/// can both answer `"1"` (#86). A lookup by the bare id answers only when
/// exactly one agent holds it ([`State::scope_of`]).
type Scope = (Agent, String);

struct State<X> {
    records: HashMap<Scope, Record>,
    /// By bare id: an extra can outlive its record (a queue waiting for the
    /// rebind), and then there is no agent to file it under. Ending one
    /// agent's session never drops an extra another agent's live session by
    /// the same id still uses ([`SessionRegistry::end_locked`]).
    extras: HashMap<String, X>,
}

impl<X> State<X> {
    /// The one record holding this bare id; `None` when none or several do.
    fn scope_of(&self, session_id: &str) -> Option<Scope> {
        let mut holders = self.records.keys().filter(|(_, id)| id == session_id);
        let scope = holders.next()?.clone();
        if holders.next().is_some() {
            tracing::warn!(
                session = %session_id,
                "two agents hold this session id; naming the agent is required"
            );
            return None;
        }
        Some(scope)
    }

    fn record_mut(&mut self, session_id: &str) -> Option<&mut Record> {
        let scope = self.scope_of(session_id)?;
        self.records.get_mut(&scope)
    }

    fn record(&self, session_id: &str) -> Option<&Record> {
        self.records.get(&self.scope_of(session_id)?)
    }
}

#[derive(Default)]
struct Binds {
    next: u64,
    in_flight: HashMap<u64, BindInFlight>,
}

struct BindInFlight {
    agent: Agent,
    /// The session id asked for, when the bind reopens a stored session. A
    /// new session has none until the agent mints it.
    session_id: Option<String>,
    /// Set by the end that covered this bind.
    ended_by: Option<EndKind>,
}

/// See the module docs.
pub struct SessionRegistry<X: SessionExtra = ()> {
    manager: Arc<AgentManager>,
    state: Mutex<State<X>>,
    binds: Arc<Mutex<Binds>>,
}

impl<X: SessionExtra> SessionRegistry<X> {
    pub fn new(manager: Arc<AgentManager>) -> Self {
        Self {
            manager,
            state: Mutex::new(State {
                records: HashMap::new(),
                extras: HashMap::new(),
            }),
            binds: Arc::default(),
        }
    }

    // ---- binding ---------------------------------------------------------

    /// Note that a session is about to be opened on `agent`. `session_id` is
    /// the stored id being reopened, when there is one.
    pub fn begin_bind(&self, agent: &Agent, session_id: Option<&str>) -> BindTicket {
        // Under `state`, so a ticket is taken either before an end (and
        // marked by it) or after the whole of it, manager step included.
        let _state = lock(&self.state);
        let mut binds = lock(&self.binds);
        binds.next += 1;
        let id = binds.next;
        binds.in_flight.insert(
            id,
            BindInFlight {
                agent: agent.clone(),
                session_id: session_id.map(str::to_owned),
                ended_by: None,
            },
        );
        BindTicket {
            id,
            binds: Arc::downgrade(&self.binds),
        }
    }

    /// Register the session the agent opened on `thread`.
    ///
    /// Call it before setting up anything else for the session (a wire
    /// projection, a history binding): a refusal leaves all of that alone,
    /// because by then it may be a newer bind's.
    ///
    /// Refused when an end covered the bind while it was in flight: the
    /// manager's handle on the thread is dropped here, and the agent is
    /// asked to close its side unless a newer bind of the session is live on
    /// it. A session already bound under this id is replaced, holds and all,
    /// exactly as a second `session/load` of it replaces the thread
    /// underneath.
    pub fn bind(
        &self,
        ticket: BindTicket,
        thread: &AcpThreadHandle,
        meta: SessionMeta,
    ) -> Result<(), BindRefused> {
        let session_id = lock(thread).session_id().clone();
        let (ended_by, rebound) = {
            let mut state = lock(&self.state);
            let ended_by = lock(&self.binds)
                .in_flight
                .remove(&ticket.id)
                .and_then(|bind| bind.ended_by);
            match ended_by {
                None => {
                    self.manager
                        .settle_session(&meta.agent, &session_id, thread, true);
                    // Keyed by agent too: another agent's session that
                    // happens to share the id is another session, not this
                    // one's previous bind (#86).
                    state.records.insert(
                        (meta.agent.clone(), session_id.to_string()),
                        Record {
                            agent: meta.agent,
                            plugin_id: meta.plugin_id,
                            cwd: meta.cwd,
                            current_model: None,
                            turn_seq: 0,
                            created_at: SystemTime::now(),
                            holds: BTreeSet::new(),
                            released_by_window: false,
                        },
                    );
                    return Ok(());
                }
                Some(ended_by) => {
                    // Only this bind's own thread: a newer bind of the same
                    // id may have registered since, and that one is live.
                    self.manager
                        .settle_session(&meta.agent, &session_id, thread, false);
                    // A newer bind of the id is live on this agent, or opened
                    // there and on its way to its own bind: either way the
                    // agent's one session by this id is that bind's now.
                    let rebound = state
                        .records
                        .contains_key(&(meta.agent.clone(), session_id.to_string()))
                        || self.manager.holds_session(&meta.agent, &session_id);
                    (ended_by, rebound)
                }
            }
        };
        let mut follow_ups = Vec::new();
        // An agent that is going is not asked to close anything. Nor is one
        // a newer bind of this session is live on: the agent knows one
        // session by this id, and closing it would close that one.
        if ended_by == EndKind::Closed && !rebound {
            follow_ups.push(release_on_agent(thread));
        }
        Err(BindRefused {
            ended_by,
            follow_ups,
        })
    }

    // ---- reads -----------------------------------------------------------

    /// Whether any agent has a session bound by this id.
    pub fn contains(&self, session_id: &str) -> bool {
        lock(&self.state)
            .records
            .keys()
            .any(|(_, id)| id == session_id)
    }

    /// The session by its bare id; `None` when two agents share the id
    /// (see [`Self::info_of`]).
    pub fn info(&self, session_id: &str) -> Option<SessionInfo> {
        lock(&self.state).record(session_id).map(SessionInfo::of)
    }

    /// One agent's session by this id.
    pub fn info_of(&self, agent: &Agent, session_id: &str) -> Option<SessionInfo> {
        lock(&self.state)
            .records
            .get(&(agent.clone(), session_id.to_owned()))
            .map(SessionInfo::of)
    }

    /// How many agents have a session bound by this id. More than one is a
    /// collision only the agent can tell apart.
    pub fn holders(&self, session_id: &str) -> usize {
        lock(&self.state)
            .records
            .keys()
            .filter(|(_, id)| id == session_id)
            .count()
    }
}

impl SessionInfo {
    fn of(record: &Record) -> Self {
        Self {
            agent: record.agent.clone(),
            plugin_id: record.plugin_id.clone(),
            cwd: record.cwd.clone(),
            current_model: record.current_model.clone(),
            turn_seq: record.turn_seq,
            created_at: record.created_at,
            held: !record.holds.is_empty(),
        }
    }
}

impl<X: SessionExtra> SessionRegistry<X> {
    /// Every session bound on `agent`.
    pub fn sessions_of(&self, agent: &Agent) -> Vec<String> {
        lock(&self.state)
            .records
            .iter()
            .filter(|(_, record)| &record.agent == agent)
            .map(|((_, id), _)| id.clone())
            .collect()
    }

    /// Every session a hold keeps open.
    pub fn held_sessions(&self) -> Vec<String> {
        lock(&self.state)
            .records
            .iter()
            .filter(|(_, record)| !record.holds.is_empty())
            .map(|((_, id), _)| id.clone())
            .collect()
    }

    pub fn is_held(&self, session_id: &str) -> bool {
        lock(&self.state)
            .record(session_id)
            .is_some_and(|record| !record.holds.is_empty())
    }

    // ---- the record's own fields ----------------------------------------

    /// Record the model the user picked. `false` for a session not bound.
    pub fn set_current_model(&self, session_id: &str, model: String) -> bool {
        match lock(&self.state).record_mut(session_id) {
            Some(record) => {
                record.current_model = Some(model);
                true
            }
            None => false,
        }
    }

    /// Start the session's next turn and answer its number; `None` for a
    /// session not bound. A turn's deltas carry the number, so a client can
    /// drop what belongs to a turn that was superseded.
    pub fn next_turn_seq(&self, session_id: &str) -> Option<u64> {
        let mut state = lock(&self.state);
        let record = state.record_mut(session_id)?;
        record.turn_seq = record.turn_seq.wrapping_add(1);
        Some(record.turn_seq)
    }

    // ---- holds -----------------------------------------------------------

    /// Take a hold: keep the session open without its tab. Answers whether
    /// it is the first hold taken; `None` for a session not bound.
    /// By the bare id; `None` when two agents share it (see [`Self::hold_of`]).
    pub fn hold(&self, session_id: &str, holder: &str) -> Option<bool> {
        let mut state = lock(&self.state);
        let record = state.record_mut(session_id)?;
        let first = record.holds.is_empty();
        record.holds.insert(holder.to_owned());
        Some(first)
    }

    /// [`Self::hold`], for one agent's session.
    pub fn hold_of(&self, agent: &Agent, session_id: &str, holder: &str) -> Option<bool> {
        let mut state = lock(&self.state);
        let record = state
            .records
            .get_mut(&(agent.clone(), session_id.to_owned()))?;
        let first = record.holds.is_empty();
        record.holds.insert(holder.to_owned());
        Some(first)
    }

    /// Let go of a hold. If it was the last and the window had already let
    /// the session go, the session ends here, as its close would have.
    ///
    /// By the bare id; nothing is released when two agents share it (see
    /// [`Self::release_of`]).
    pub fn release(&self, session_id: &str, holder: &str) -> Released {
        let Some((agent, _)) = lock(&self.state).scope_of(session_id) else {
            return Released::NotHeld;
        };
        self.release_of(&agent, session_id, holder)
    }

    /// [`Self::release`], for one agent's session.
    pub fn release_of(&self, agent: &Agent, session_id: &str, holder: &str) -> Released {
        let ended = {
            let mut state = lock(&self.state);
            let scope = (agent.clone(), session_id.to_owned());
            let Some(record) = state.records.get_mut(&scope) else {
                return Released::NotHeld;
            };
            if !record.holds.remove(holder) {
                return Released::NotHeld;
            }
            if !record.holds.is_empty() {
                return Released::StillHeld;
            }
            if !record.released_by_window {
                return Released::Last;
            }
            self.close_locked(&mut state, &scope)
        };
        match ended {
            Some(ended) => Released::LastAndEnded(ended.into_ended(session_id)),
            None => Released::Last,
        }
    }

    /// The window is showing a bound session again. Answers whether the
    /// session is bound; if it was let go while held, it is the window's
    /// again, so a later release does not end it under the tab.
    pub fn reclaim_for_window(&self, session_id: &str) -> bool {
        match lock(&self.state).record_mut(session_id) {
            Some(record) => {
                record.released_by_window = false;
                true
            }
            None => false,
        }
    }

    // ---- the extra -------------------------------------------------------

    /// Change the session's extra, creating it first if there is none. The
    /// closure runs under the registry's lock: see the module docs.
    pub fn with_extra<R>(&self, session_id: &str, f: impl FnOnce(&mut X) -> R) -> R {
        let mut state = lock(&self.state);
        f(state.extras.entry(session_id.to_owned()).or_default())
    }

    /// Read or change the session's extra if it has one. The closure runs
    /// under the registry's lock: see the module docs.
    pub fn extra_mut<R>(&self, session_id: &str, f: impl FnOnce(Option<&mut X>) -> R) -> R {
        let mut state = lock(&self.state);
        f(state.extras.get_mut(session_id))
    }

    // ---- ending ----------------------------------------------------------

    /// The window lets a session go. Idempotent: a tab can close twice.
    ///
    /// A held session keeps running: the close is remembered, and the last
    /// hold's [`Self::release`] finishes it. A bind still in flight for this
    /// id is cancelled either way, so the session it opens is refused.
    ///
    /// By the bare id; when two agents share it, nothing is closed (see
    /// [`Self::close_of`]).
    pub fn close(&self, session_id: &str) -> Closed {
        let scope = {
            let state = lock(&self.state);
            match state.scope_of(session_id) {
                Some(scope) => scope,
                None if state.records.keys().any(|(_, id)| id == session_id) => {
                    return Closed::Unknown;
                }
                None => {
                    self.cancel_binds(EndKind::Closed, |bind| {
                        bind.session_id.as_deref() == Some(session_id)
                    });
                    return Closed::Unknown;
                }
            }
        };
        self.close_of(&scope.0, session_id)
    }

    /// [`Self::close`], for one agent's session.
    pub fn close_of(&self, agent: &Agent, session_id: &str) -> Closed {
        let scope = (agent.clone(), session_id.to_owned());
        let ended = {
            let mut state = lock(&self.state);
            match state.records.get_mut(&scope) {
                None => {
                    self.cancel_binds(EndKind::Closed, |bind| {
                        &bind.agent == agent && bind.session_id.as_deref() == Some(session_id)
                    });
                    return Closed::Unknown;
                }
                Some(record) if !record.holds.is_empty() => {
                    record.released_by_window = true;
                    return Closed::Held;
                }
                Some(_) => self.close_locked(&mut state, &scope),
            }
        };
        match ended {
            Some(ended) => Closed::Ended(ended.into_ended(session_id)),
            None => Closed::Unknown,
        }
    }

    /// End every session on `agent`: its process is going, or gone.
    ///
    /// Holds do not survive this: there is nothing left to keep running.
    /// Every bind in flight on the agent is cancelled, and with
    /// [`AgentEnd::drop_connection`] the manager drops the connection, which
    /// stops a connect still in flight too.
    pub fn end_agent(&self, agent: &Agent, how: AgentEnd) -> Vec<Ended> {
        let ended: Vec<String> = {
            let mut state = lock(&self.state);
            let ended: Vec<String> = state
                .records
                .iter()
                .filter(|(_, record)| &record.agent == agent)
                .map(|((_, id), _)| id.clone())
                .collect();
            for session_id in &ended {
                self.end_locked(
                    &mut state,
                    &(agent.clone(), session_id.clone()),
                    EndKind::AgentGone,
                );
            }
            self.cancel_binds(EndKind::AgentGone, |bind| &bind.agent == agent);
            if how.drop_connection {
                self.manager.drop_connection(agent);
            }
            // Whether or not there was a connection left to drop: a thread
            // registered on one that is already gone pins it just the same.
            self.manager.forget_sessions_for(agent);
            ended
        };
        ended
            .into_iter()
            .map(|session_id| {
                let mut follow_ups = Vec::with_capacity(3);
                if let Some(reason) = &how.notice {
                    follow_ups.push(FollowUp::NoticeDisconnected {
                        reason: reason.clone(),
                    });
                }
                follow_ups.push(FollowUp::CloseProjection);
                follow_ups.push(FollowUp::AnnounceEnded);
                Ended {
                    session_id,
                    agent: agent.clone(),
                    kind: EndKind::AgentGone,
                    follow_ups,
                }
            })
            .collect()
    }

    /// End everything: the app is quitting. The manager is shut down, which
    /// drops every connection and stops every connect still in flight.
    pub fn end_all(&self) -> Vec<Ended> {
        let ended: Vec<(String, Agent)> = {
            let mut state = lock(&self.state);
            state.extras.clear();
            self.cancel_binds(EndKind::Quit, |_| true);
            let ended = state
                .records
                .drain()
                .map(|((_, id), record)| (id, record.agent))
                .collect();
            self.manager.shutdown();
            ended
        };
        ended
            .into_iter()
            .map(|(session_id, agent)| Ended {
                session_id,
                agent,
                kind: EndKind::Quit,
                follow_ups: vec![FollowUp::AnnounceEnded],
            })
            .collect()
    }

    /// The registry's own part of one session's end, under `state`: the
    /// record, the extra, and any bind in flight for the id. Answers the
    /// agent it was bound on; `None` when it was not bound.
    fn end_locked(
        &self,
        state: &mut MutexGuard<'_, State<X>>,
        scope: &Scope,
        kind: EndKind,
    ) -> Option<Agent> {
        let record = state.records.remove(scope)?;
        let (agent, session_id) = scope;
        // Another agent's live session by the same id is still using the
        // extra filed under it: leave it be.
        let shared = state.records.keys().any(|(_, id)| id == session_id);
        if !shared {
            let keep = state
                .extras
                .get_mut(session_id)
                .is_some_and(|extra| extra.survives(kind));
            if !keep {
                state.extras.remove(session_id);
            }
        }
        if kind == EndKind::Closed {
            self.cancel_binds(kind, |bind| {
                &bind.agent == agent && bind.session_id.as_deref() == Some(session_id.as_str())
            });
        }
        Some(record.agent)
    }

    /// One session's close, under `state`: the registry's part, then the
    /// manager's handle on its thread. `None` when it was not bound.
    fn close_locked(
        &self,
        state: &mut MutexGuard<'_, State<X>>,
        scope: &Scope,
    ) -> Option<ClosedLocked> {
        let agent = self.end_locked(state, scope, EndKind::Closed)?;
        let thread = self
            .manager
            .forget_session(&agent, &acp::SessionId::new(scope.1.as_str()))
            .map(|handle| handle.thread);
        Some(ClosedLocked { agent, thread })
    }

    /// Mark every bind in flight that `covers` selects as ended. Called with
    /// `state` held (the order is `state`, then `binds`).
    fn cancel_binds(&self, kind: EndKind, covers: impl Fn(&BindInFlight) -> bool) {
        for bind in lock(&self.binds).in_flight.values_mut() {
            if bind.ended_by.is_none() && covers(bind) {
                bind.ended_by = Some(kind);
            }
        }
    }

    // ---- diagnostics -----------------------------------------------------

    /// Everything still held for `session_id`. A session that ended, with
    /// nothing kept, reads as [`Residue::default`].
    pub fn residue(&self, session_id: &str) -> Residue {
        let (bound, holds, released_by_window, extra) = {
            let state = lock(&self.state);
            let record = state.record(session_id);
            (
                record.is_some(),
                record.map_or_else(Vec::new, |r| r.holds.iter().cloned().collect()),
                record.is_some_and(|r| r.released_by_window),
                state.extras.contains_key(session_id),
            )
        };
        let binds_in_flight = lock(&self.binds)
            .in_flight
            .values()
            .filter(|bind| bind.session_id.as_deref() == Some(session_id))
            .count();
        Residue {
            bound,
            holds,
            released_by_window,
            extra,
            binds_in_flight,
            manager_handle: self
                .manager
                .sessions()
                .contains(&acp::SessionId::new(session_id)),
        }
    }

    /// How many records, extras and binds in flight the registry holds.
    pub fn counts(&self) -> (usize, usize, usize) {
        let state = lock(&self.state);
        let binds = lock(&self.binds).in_flight.len();
        (state.records.len(), state.extras.len(), binds)
    }
}

/// A close whose tables are settled; what is left needs the thread's own
/// lock, which is not taken under `state`.
struct ClosedLocked {
    agent: Agent,
    thread: Option<AcpThreadHandle>,
}

impl ClosedLocked {
    fn into_ended(self, session_id: &str) -> Ended {
        let mut follow_ups = vec![
            FollowUp::AnnounceEnded,
            FollowUp::ForgetHistoryBinding,
            FollowUp::CloseProjection,
        ];
        follow_ups.extend(self.thread.as_ref().map(release_on_agent));
        Ended {
            session_id: session_id.to_owned(),
            agent: self.agent,
            kind: EndKind::Closed,
            follow_ups,
        }
    }
}

/// Local session release is unconditional; the connection decides whether
/// an advertised `session/close` RPC is needed as part of that release.
fn release_on_agent(thread: &AcpThreadHandle) -> FollowUp {
    let connection = lock(thread).connection().clone();
    FollowUp::CloseOnAgent { connection }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
