//! The steering entry and the turn controller.
//!
//! Everything that *changes* a session from outside the agent — a prompt, a
//! stop, an answer to a permission or an elicitation, a mode, a model, a
//! config knob — enters here, once, whoever asked. The window's IPC verbs in
//! `commands/agents.rs` are one-liners onto these methods, and a remote driver
//! (Universal RC) calls the same methods with a remote [`Origin`]. So a prompt
//! is captured, transcribed, recorded in history and registered for shared
//! memory the same way whether it was typed in the window or sent from a phone,
//! and a refusal ("mode can't change mid-turn") comes back to whichever caller
//! asked.
//!
//! Before this, the send's side effects lived in the `agents_send` command,
//! above the host: a caller that went straight to the host reached the agent
//! and skipped all four.
//!
//! # The turn controller
//!
//! Each session has a [`TurnControl`]: the prompt queue, whether a turn this
//! host dispatched is still in flight, and whether the window has paused
//! draining. It lives here, in Rust, because the session does — the queue used
//! to be React state, which a remote driver could not reach and a closed tab
//! took with it.
//!
//! - **Submit** either starts a turn now ([`SubmitPolicy::Now`] — the window's
//!   direct send, which supersedes a running turn exactly as it always has) or
//!   parks the prompt behind the running turn ([`SubmitPolicy::QueueIfBusy`] —
//!   what a remote driver gets).
//! - When a dispatched turn ends, the head of the queue goes next, unless the
//!   queue is paused (the window's send gates: a resume still loading, a
//!   session live elsewhere, no AI grant, an agent switch waiting on
//!   `/remember`).
//! - **Stop** discards the queue and cancels the turn.
//! - **Send now** takes one queued prompt and runs it next, interrupting the
//!   running turn but keeping the rest of the queue.
//!
//! Every change to a queue is announced as a whole-queue `queue_changed`
//! delta, and a snapshot carries the queue too, so the window's queued-message
//! strip and any remote view are mirrors of this one list. The queue is
//! bounded ([`QUEUE_MAX`]) and each item's text is cut to
//! [`QUEUE_WIRE_TEXT_MAX`] on the delta, marked `truncated` — the full prompt
//! stays here and is what the agent is sent, and a snapshot carries all of
//! it, so a reader that must hand the prompt on (an edit, an agent switch, a
//! restart onto a new session) never takes the head for the whole.
//!
//! # The seat
//!
//! Universal RC has one Driver per room, and the owner is a person like any
//! other: once they hand the seat to Ada, *only Ada* prompts — from her phone
//! — until the owner takes it back. The room's host task tells this host who
//! drives ([`AgentHost::set_remote_driver`]); while that is someone else,
//! every **local** steering verb here — submit, enqueue, send-now, mode,
//! model, config, elicitation answers — is refused with a message the
//! composer shows ("Ada is driving — take over"). Two things stay the
//! owner's whoever drives: `stop` (the master's kill switch) and answering a
//! permission card on this machine (consent for an action that runs here).
//! Remote callers never hit this gate: the relay and the room's own gate
//! (`atlas-remote-control::gate`) decide for them.
//!
//! The seat is held by a *person*, and the queue follows it (R4, "only A can
//! prompt"): only the seated person's parked prompts drain — the owner's
//! (typed here, or sent from their own phone) while the owner holds the seat,
//! the driver's alone while someone else does — and the rest wait. When the
//! seat changes hands, prompts parked by a remote principal who no longer
//! drives (kicked, superseded, released) are discarded rather than run
//! under the next driver's name; the owner's own wait.

use std::collections::VecDeque;

use atlas_acp_thread::prompt::{self, ImageAttachment, PastedText, ResourceLinkSpec};
use atlas_agent_manager::{EndKind, Released, SessionExtra};
use atlas_agent_wire::{Origin, QueuedPrompt};

use super::*;

/// One prompt, as a steering caller hands it to the host.
#[derive(Debug, Clone, Default)]
pub struct Prompt {
    /// What the agent is sent. The window may have expanded mentions and
    /// appended hidden directives to what the user typed; this is the result.
    pub text: String,
    /// What a queued-message chip shows for it, and what "edit" hands back to
    /// the composer — what the user typed. `None` means `text`.
    pub display: Option<String>,
    pub images: Vec<ImageAttachment>,
    pub resource_links: Vec<ResourceLinkSpec>,
    /// Large pastes the composer kept as chips. Each goes in full: an embedded
    /// resource when the agent takes embedded context, a text block otherwise.
    pub pastes: Vec<PastedText>,
    /// An id the sender minted, echoed on the prompt's `user_message` delta so
    /// a sender that already shows the prompt can match it.
    pub client_message_id: Option<String>,
    /// Sent by Atlas on its own (a pull request watch's wake, a turn continued
    /// after a restart), not by anyone steering the session. It passes the
    /// seat — a driver's hold on the session is a hold on people, not on the
    /// watches the owner set — and it is not announced as a `user_message`:
    /// the window already draws it off `session-prompt-injected`, and a
    /// stamped copy would draw it twice. It still reaches snapshots.
    pub from_atlas: bool,
    /// Restart count belongs to this queued prompt, never the next user turn.
    pub restart_continuations: u32,
}

impl Prompt {
    /// A prompt that is only text.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }

    fn display_text(&self) -> &str {
        self.display.as_deref().unwrap_or(&self.text)
    }
}

/// What to do with a prompt submitted while a turn is running.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitPolicy {
    /// Start a turn now, superseding any running one. The window's direct
    /// send: its composer already queues while a turn runs, so a direct send
    /// is one it decided to make.
    #[default]
    Now,
    /// Start now if the session is idle and nothing is queued ahead; otherwise
    /// park it at the back of the queue. What a remote driver's prompt gets.
    QueueIfBusy,
}

/// What became of a submitted prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Submitted {
    /// A turn started; its deltas carry this `turn_seq`.
    Started { turn_seq: u64 },
    /// Parked; `item_id` names it to `remove_queued` / `send_now`.
    Queued { item_id: String },
}

/// A prompt on its way to the agent, as the send-path side effects see it.
pub struct PromptSent<'a> {
    pub session_id: &'a str,
    pub cwd: &'a str,
    /// The durable plugin id (`atlas-agent` for the native agent) — what
    /// capture and transcripts label a session with, never the per-process
    /// `AgentId`.
    pub plugin_id: &'a str,
    pub model: Option<&'a str>,
    /// Exactly what the agent is sent.
    pub text: &'a str,
    pub origin: &'a Origin,
    /// See [`Prompt::from_atlas`]: recorded like any prompt, but not as the
    /// user's interaction with the session.
    pub from_atlas: bool,
}

/// The side effects every prompt has on its way to the agent: session capture,
/// Atlas's own transcript, and the shared-memory session registration.
///
/// Installed by the app at startup (`install_manager`), the way
/// [`SessionLifecycle`] is; `None` in tests that do not care. Called on every
/// dispatch — a direct send, a drained queue item, a remote prompt — before
/// the turn opens, so capture binds the turn to its prompt first.
pub trait PromptHooks: Send + Sync {
    fn prompt_sent(&self, sent: &PromptSent<'_>);
}

/// A permission prompt still open, as a snapshot hands it out: the same three
/// fields its `permission_request` delta carried.
#[derive(Debug, Clone, Serialize)]
pub struct PendingPermissionWire {
    pub request_id: Uuid,
    pub tool_call: serde_json::Value,
    pub options: serde_json::Value,
}

/// An elicitation still waiting, in its `elicitation_requested` delta's fields.
#[derive(Debug, Clone, Serialize)]
pub struct PendingElicitationWire {
    pub request_id: Uuid,
    pub mode: String,
    pub message: String,
    pub requested_schema: Option<serde_json::Value>,
    pub url: Option<String>,
}

impl From<atlas_agent_delta::PendingPermission> for PendingPermissionWire {
    fn from(p: atlas_agent_delta::PendingPermission) -> Self {
        Self {
            request_id: p.request_id,
            tool_call: p.tool_call,
            options: p.options,
        }
    }
}

impl From<atlas_agent_delta::PendingElicitation> for PendingElicitationWire {
    fn from(p: atlas_agent_delta::PendingElicitation) -> Self {
        Self {
            request_id: p.request_id,
            mode: p.mode,
            message: p.message,
            requested_schema: p.requested_schema,
            url: p.url,
        }
    }
}

/// One session's turn controller state (see the module docs).
#[derive(Debug)]
pub(super) struct TurnControl {
    queue: VecDeque<QueuedItem>,
    /// The window's send gate is closed: nothing drains until it opens.
    paused: bool,
    /// The `turn_seq` of the turn this host dispatched and has not yet seen
    /// come back. [`RESERVED`] while a drain is between popping an item and
    /// starting its turn, so a second drain cannot start another.
    running: Option<u64>,
    /// `send_now` asked for the head to run next: the next drain goes ahead
    /// even if paused, once.
    force_next: bool,
    /// The last turn failed (an error, a refusal, a token limit) with prompts
    /// still parked: they were typed to follow a turn that went well, so they
    /// wait for the user rather than running into the same wall (audit #77).
    /// Kept apart from `paused`, which the window owns and overwrites. Lifted
    /// by [`AgentHost::resume_queue`], a `send_now`, a turn that ends well,
    /// or the queue emptying.
    halted: bool,
    /// Preparation may touch disk, but never on an IPC/runtime worker. It is
    /// ordered within this session and remains cancellable before agent send.
    preparation: Arc<tokio::sync::Semaphore>,
    cancel: Option<tokio::sync::watch::Sender<bool>>,
}

impl Default for TurnControl {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            paused: false,
            running: None,
            force_next: false,
            halted: false,
            preparation: Arc::new(tokio::sync::Semaphore::new(1)),
            cancel: None,
        }
    }
}

impl TurnControl {
    fn has_queue(&self) -> bool {
        !self.queue.is_empty()
    }
}

/// What the steering entry keeps for a session, beside its record in the
/// session registry: the turn controller and the remote-control seat. One
/// value under the registry's one lock, so a queue is pruned by the seat
/// that was just set and drained by the seat that is there.
#[derive(Debug, Default)]
pub(in crate::commands::agent_host) struct Steering {
    control: TurnControl,
    seat: Option<Seat>,
}

impl SessionExtra for Steering {
    fn survives(&mut self, end: EndKind) -> bool {
        if let Some(cancel) = &self.control.cancel {
            cancel.send_replace(true);
        }
        match end {
            // The session is over: the queue was typed for it and the seat
            // was a seat in it. Nothing is left to steer.
            EndKind::Closed | EndKind::Quit => false,
            // The process went, the session did not: the tab's rebind brings
            // it back under the same id. A queue with prompts still parked
            // waits for that, and so does the seat, because the room that
            // set it is still open and names its driver only on a change. An
            // empty controller has nothing to carry over.
            EndKind::AgentGone => {
                if !self.control.has_queue() {
                    self.control = TurnControl::default();
                }
                self.control.has_queue() || self.seat.is_some()
            }
        }
    }
}

#[cfg(test)]
impl Steering {
    /// Whether a turn this host dispatched has not come back yet.
    pub(in crate::commands::agent_host) fn turn_running(&self) -> bool {
        self.control.running.is_some()
    }

    /// Whether anything of a turn controller is kept: a queue, a running
    /// turn, a closed gate.
    pub(in crate::commands::agent_host) fn has_control(&self) -> bool {
        self.control.has_queue()
            || self.control.running.is_some()
            || self.control.paused
            || self.control.force_next
            || self.control.halted
    }

    /// Whether a failed turn halted the queue.
    pub(in crate::commands::agent_host) fn queue_halted(&self) -> bool {
        self.control.halted
    }

    pub(in crate::commands::agent_host) fn has_seat(&self) -> bool {
        self.seat.is_some()
    }
}

/// `TurnControl::running` while a drain is dispatching.
const RESERVED: u64 = u64::MAX;

/// The most prompts one session parks. A remote driver's `submit` is refused
/// past this (the window's composer queues one at a time); without a bound,
/// every `queue_changed` delta — which carries the whole queue — grows with
/// each prompt a disconnected phone keeps sending.
pub const QUEUE_MAX: usize = 16;

/// The most of a queued prompt's text that travels on `queue_changed`, which
/// carries the whole queue on every change. The whole prompt stays here and is
/// what the agent gets; the delta marks a cut item `truncated`, and a snapshot
/// carries it whole.
pub const QUEUE_WIRE_TEXT_MAX: usize = 2 * 1024;

#[derive(Debug, Clone)]
struct QueuedItem {
    id: String,
    prompt: Prompt,
    origin: Origin,
}

impl QueuedItem {
    /// As a `queue_changed` delta carries it: the head of a long text.
    fn wire(&self) -> QueuedPrompt {
        let text = self.prompt.display_text();
        let head = head_of(text, QUEUE_WIRE_TEXT_MAX);
        QueuedPrompt {
            id: self.id.clone(),
            truncated: (head.len() < text.len()).then_some(true),
            text: head,
            origin: self.origin.clone(),
        }
    }

    /// As a snapshot carries it: the whole text.
    fn whole(&self) -> QueuedPrompt {
        QueuedPrompt {
            id: self.id.clone(),
            text: self.prompt.display_text().to_string(),
            origin: self.origin.clone(),
            truncated: None,
        }
    }
}

/// The first `max_bytes` of `text`, cut on a character boundary.
fn head_of(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Who holds a session's remote-control seat when it is not this desktop's
/// account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDriver {
    pub id: String,
    /// A display name, for the refusal and the composer.
    pub name: Option<String>,
}

impl RemoteDriver {
    fn label(&self) -> &str {
        self.name.as_deref().unwrap_or("Someone else")
    }
}

/// A session's remote-control seat, as the steering entry keeps it: whose
/// account the room is, and who drives when that is not this desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Seat {
    owner_id: String,
    driver: Option<RemoteDriver>,
    /// A remote driver whose room link is down (offline, reconnecting): not
    /// seated — the window steers meanwhile — but their parked prompts are
    /// kept, unrun, for when the link comes back with them still driving.
    held: Option<String>,
}

impl Seat {
    /// Whether a prompt from `origin` is the seated person's: the window's
    /// composer and the owner's own remote surfaces while the owner holds the
    /// seat; the driver's remote surfaces alone while someone else does.
    fn admits(&self, origin: &Origin) -> bool {
        match (&self.driver, origin) {
            (None, Origin::Local) => true,
            (None, Origin::Remote { id, .. }) => *id == self.owner_id,
            (Some(driver), Origin::Remote { id, .. }) => *id == driver.id,
            (Some(_), Origin::Local) => false,
        }
    }

    /// Whether a parked prompt survives the seat changing to this. The
    /// owner's own prompts, typed or from their phone, always wait their
    /// turn; another remote principal's go with their seat.
    fn keeps(&self, origin: &Origin) -> bool {
        match origin {
            Origin::Local => true,
            Origin::Remote { id, .. } => {
                *id == self.owner_id
                    || self.driver.as_ref().is_some_and(|d| d.id == *id)
                    || self.held.as_deref() == Some(id.as_str())
            }
        }
    }
}

/// Note who steered what. Remote steering is always worth a line; the window's
/// own clicks are not.
/// Which optional per-session controls an agent advertises
/// ([`AgentHost::session_controls`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionControls {
    pub modes: bool,
    pub models: bool,
    pub config: bool,
}

/// Whether a turn ended in a way the prompts queued behind it were not typed
/// for: an error (rate limit, auth, a dead agent), or the agent refusing or
/// running out of room. A cancel is not a failure — Stop discards the queue
/// itself, and `send_now` cancels to run the head.
fn turn_failed(outcome: &anyhow::Result<acp::StopReason>) -> bool {
    match outcome {
        Err(_) => true,
        Ok(reason) => matches!(
            reason,
            acp::StopReason::Refusal
                | acp::StopReason::MaxTokens
                | acp::StopReason::MaxTurnRequests
        ),
    }
}

fn note_steer(verb: &str, session_id: &str, origin: &Origin) {
    match origin {
        Origin::Local => tracing::debug!(target: "atlas::steering", verb, session = session_id),
        Origin::Remote { id, .. } => {
            tracing::info!(target: "atlas::steering", verb, session = session_id, remote = %id);
        }
    }
}

impl AgentHost {
    /// Install the send-path side effects (see [`PromptHooks`]).
    pub fn set_prompt_hooks(&self, hooks: Arc<dyn PromptHooks>) {
        *lock(&self.prompt_hooks) = Some(hooks);
    }

    fn prompt_hooks(&self) -> Option<Arc<dyn PromptHooks>> {
        lock(&self.prompt_hooks).clone()
    }

    // ---- the seat --------------------------------------------------------

    /// Record who holds a session's remote-control seat: `owner_id` is the
    /// room's account (this desktop's), `driver` is `Some` while someone else
    /// holds the seat and `None` when the owner does (or the room is gone).
    /// Set by the room's host task from the roster, and on the room's end.
    ///
    /// The queue follows the seat (module docs): prompts parked by a remote
    /// principal who no longer drives are discarded and the queue announced,
    /// and the seat coming back to the owner lets the window's parked prompts
    /// drain.
    pub fn set_remote_driver(
        self: &Arc<Self>,
        session_id: &str,
        owner_id: &str,
        driver: Option<RemoteDriver>,
    ) {
        self.set_remote_seat(session_id, owner_id, driver, None);
    }

    /// [`Self::set_remote_driver`], while the room's link is down: `held` is
    /// the remote driver the room last named, whose parked prompts survive
    /// the blip — kept and not run — rather than being discarded as a former
    /// driver's. Whoever the room names once it is back decides their fate.
    pub fn set_remote_seat(
        self: &Arc<Self>,
        session_id: &str,
        owner_id: &str,
        driver: Option<RemoteDriver>,
        held: Option<String>,
    ) {
        let seat = Seat {
            owner_id: owner_id.to_owned(),
            driver,
            held,
        };
        let pruned = self.sessions.with_extra(session_id, |steering| {
            if steering.seat.as_ref() == Some(&seat) {
                return None;
            }
            let queue = &mut steering.control.queue;
            let before = queue.len();
            queue.retain(|item| seat.keeps(&item.origin));
            let pruned = queue.len() != before;
            steering.seat = Some(seat);
            Some(pruned)
        });
        let Some(pruned) = pruned else {
            return;
        };
        if pruned {
            tracing::info!(target: "atlas::steering", session = session_id, "a former driver's queued prompts were discarded");
            self.announce_queue(session_id);
        }
        self.maybe_drain(session_id);
    }

    /// Who drives the session remotely, if not this desktop's account.
    pub fn remote_driver(&self, session_id: &str) -> Option<RemoteDriver> {
        self.sessions.extra_mut(session_id, |steering| {
            steering?.seat.as_ref()?.driver.clone()
        })
    }

    /// Refuse local steering while someone else holds the seat. Remote
    /// origins pass: the room's gate decided for them.
    pub(super) fn seat(&self, session_id: &str, origin: &Origin) -> Result<()> {
        if !matches!(origin, Origin::Local) {
            return Ok(());
        }
        match self.remote_driver(session_id) {
            None => Ok(()),
            Some(driver) => Err(HostError::new(
                format!(
                    "{} is driving this session from remote control. Take over to steer it from here.",
                    driver.label()
                ),
                ErrorClass::Fatal,
            )),
        }
    }

    // ---- prompts ---------------------------------------------------------

    /// Submit a prompt to a session — the one way a prompt reaches an agent.
    ///
    /// Returns as soon as the turn is running (or the prompt is parked): a turn
    /// runs for minutes, and its outcome travels on the wire, not back here.
    pub fn submit(
        self: &Arc<Self>,
        key: &SessionKey,
        prompt: Prompt,
        origin: Origin,
        policy: SubmitPolicy,
    ) -> Result<Submitted> {
        note_steer("submit", &key.session_id, &origin);
        if !prompt.from_atlas {
            self.seat(&key.session_id, &origin)?;
        }
        match policy {
            SubmitPolicy::Now => self
                .dispatch(&key.session_id, prompt, origin)
                .map(|turn_seq| Submitted::Started { turn_seq }),
            SubmitPolicy::QueueIfBusy => {
                let item_id = self.park(&key.session_id, prompt, origin)?;
                match self.maybe_drain(&key.session_id) {
                    Some((started, turn_seq)) if started == item_id => {
                        Ok(Submitted::Started { turn_seq })
                    }
                    _ => Ok(Submitted::Queued { item_id }),
                }
            }
        }
    }

    /// Park a prompt at the back of the queue without draining it — the
    /// window's "queue this" (typed while a turn runs, or `/queue`). It goes
    /// when the running turn ends, or when the window releases the queue.
    pub fn enqueue(&self, key: &SessionKey, prompt: Prompt, origin: Origin) -> Result<String> {
        note_steer("enqueue", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        self.park(&key.session_id, prompt, origin)
    }

    /// Take a parked prompt out of the queue. `false` when it is not there
    /// (already started, or never was).
    pub fn remove_queued(&self, key: &SessionKey, item_id: &str, origin: Origin) -> Result<bool> {
        note_steer("remove_queued", &key.session_id, &origin);
        self.known_session(&key.session_id)?;
        let removed = self.sessions.extra_mut(&key.session_id, |steering| {
            let Some(steering) = steering else {
                return false;
            };
            let control = &mut steering.control;
            let before = control.queue.len();
            control.queue.retain(|item| item.id != item_id);
            if control.queue.is_empty() {
                control.halted = false;
            }
            control.queue.len() != before
        });
        if removed {
            self.announce_queue(&key.session_id);
        }
        Ok(removed)
    }

    /// Discard every parked prompt, leaving any running turn alone.
    pub fn clear_queue(&self, key: &SessionKey, origin: Origin) -> Result<()> {
        note_steer("clear_queue", &key.session_id, &origin);
        self.known_session(&key.session_id)?;
        self.discard_queue(&key.session_id);
        Ok(())
    }

    /// Close (`true`) or open the queue's drain gate. Opening it starts the
    /// head now if the session is idle.
    pub fn set_queue_paused(self: &Arc<Self>, key: &SessionKey, paused: bool) -> Result<()> {
        self.known_session(&key.session_id)?;
        self.sessions
            .with_extra(&key.session_id, |steering| steering.control.paused = paused);
        if !paused {
            self.maybe_drain(&key.session_id);
        }
        Ok(())
    }

    /// Start the head of the queue if the session is idle and not paused.
    /// Answers the turn it started, if any. Safe to call any time: busy, empty
    /// or paused is simply nothing to do.
    pub fn drain_queue(self: &Arc<Self>, key: &SessionKey) -> Result<Option<u64>> {
        self.known_session(&key.session_id)?;
        Ok(self
            .maybe_drain(&key.session_id)
            .map(|(_, turn_seq)| turn_seq))
    }

    /// Lift the halt a failed turn put on the queue (audit #77) and start the
    /// head if the session is idle and the window's gate is open. The
    /// window's "resume queue"; a no-op on a queue that is not halted.
    pub fn resume_queue(self: &Arc<Self>, key: &SessionKey, origin: Origin) -> Result<Option<u64>> {
        note_steer("resume_queue", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        self.known_session(&key.session_id)?;
        self.sessions.extra_mut(&key.session_id, |steering| {
            if let Some(steering) = steering {
                steering.control.halted = false;
            }
        });
        Ok(self
            .maybe_drain(&key.session_id)
            .map(|(_, turn_seq)| turn_seq))
    }

    /// Run one parked prompt next: it moves to the head, and a running turn is
    /// interrupted (the rest of the queue stays). Idle, it starts at once.
    pub fn send_now(
        self: &Arc<Self>,
        key: &SessionKey,
        item_id: &str,
        origin: Origin,
    ) -> Result<Submitted> {
        note_steer("send_now", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        self.known_session(&key.session_id)?;
        let busy = self.sessions.with_extra(&key.session_id, |steering| {
            let control = &mut steering.control;
            let at = control.queue.iter().position(|item| item.id == item_id)?;
            let item = control.queue.remove(at).expect("position is in range");
            control.queue.push_front(item);
            control.force_next = true;
            Some(control.running.is_some())
        });
        let Some(busy) = busy else {
            return Err(HostError::new(
                "that prompt is no longer queued",
                ErrorClass::Fatal,
            ));
        };
        self.announce_queue(&key.session_id);
        if busy {
            // The turn's end drains the head, which is now this prompt.
            self.cancel_turn(&key.session_id);
            return Ok(Submitted::Queued {
                item_id: item_id.to_string(),
            });
        }
        match self.maybe_drain(&key.session_id) {
            Some((started, turn_seq)) if started == item_id => Ok(Submitted::Started { turn_seq }),
            _ => Ok(Submitted::Queued {
                item_id: item_id.to_string(),
            }),
        }
    }

    /// The session's queue, as a snapshot carries it: every text whole.
    pub fn queue_of(&self, session_id: &str) -> Vec<QueuedPrompt> {
        self.queue_as(session_id, QueuedItem::whole)
    }

    /// The session's queue, as `queue_changed` carries it: long texts cut.
    fn queue_on_wire(&self, session_id: &str) -> Vec<QueuedPrompt> {
        self.queue_as(session_id, QueuedItem::wire)
    }

    fn queue_as(
        &self,
        session_id: &str,
        each: fn(&QueuedItem) -> QueuedPrompt,
    ) -> Vec<QueuedPrompt> {
        self.sessions.extra_mut(session_id, |steering| {
            steering
                .map(|steering| steering.control.queue.iter().map(each).collect())
                .unwrap_or_default()
        })
    }

    /// Stop the session: discard its queue and cancel the running turn. Safe
    /// when nothing is running.
    ///
    /// Discarding is what Stop has always meant in the window — a queued
    /// message was typed for the turn being stopped. A prompt submitted after
    /// this, while the cancelled turn winds down, queues and runs as usual.
    ///
    /// Stop also drops any wake held for the session and ends its pull
    /// request watches, so nothing Atlas sends on its own starts the agent
    /// straight back up. The order matters: the held wakes go first, so the
    /// cancelled turn's end finds none to send.
    pub fn stop(&self, key: &SessionKey, origin: Origin) -> Result<()> {
        note_steer("stop", &key.session_id, &origin);
        self.forget_wakes(&key.session_id);
        if let Some(history) = self.history() {
            let session_id = acp::SessionId::new(key.session_id.as_str());
            let thread_id = match self.plugin_id_for_agent(key.agent_id) {
                Some(plugin_id) => {
                    history.thread_for_agent(&plugin_id.as_str().into(), &session_id)
                }
                None => history.thread_for(&session_id),
            };
            if let Some(thread_id) = thread_id {
                history.store().end_pull_request_watches(thread_id);
            }
        }
        self.discard_queue(&key.session_id);
        self.cancel_turn(&key.session_id);
        Ok(())
    }

    /// Cancel the turn without the user asking it to stop: the tab closed,
    /// the project is going away, a guide run was cancelled. Held wakes are
    /// dropped so the cancelled turn does not hand straight over to one, but
    /// the queue and the session's watches stay on — a watch outlives its
    /// tab, and the next thing it hears opens the session again.
    pub fn interrupt(&self, key: &SessionKey) -> Result<()> {
        self.forget_wakes(&key.session_id);
        self.cancel_turn(&key.session_id);
        Ok(())
    }

    fn cancel_turn(&self, session_id: &str) {
        self.sessions.extra_mut(session_id, |steering| {
            if let Some(cancel) = steering.and_then(|s| s.control.cancel.as_ref()) {
                cancel.send_replace(true);
            }
        });
        self.manager.cancel(&acp::SessionId::new(session_id));
    }

    fn discard_queue(&self, session_id: &str) {
        let had = self.sessions.extra_mut(session_id, |steering| {
            let Some(steering) = steering else {
                return false;
            };
            let control = &mut steering.control;
            control.force_next = false;
            control.halted = false;
            let had = !control.queue.is_empty();
            control.queue.clear();
            had
        });
        if had {
            self.announce_queue(session_id);
        }
    }

    fn park(&self, session_id: &str, prompt: Prompt, origin: Origin) -> Result<String> {
        self.known_session(session_id)?;
        let id = format!("q-{}", Uuid::new_v4().simple());
        let item = QueuedItem {
            id: id.clone(),
            prompt,
            origin,
        };
        let parked = self.sessions.with_extra(session_id, |steering| {
            let queue = &mut steering.control.queue;
            if queue.len() >= QUEUE_MAX {
                return false;
            }
            queue.push_back(item);
            true
        });
        if !parked {
            return Err(HostError::new(
                format!("the queue is full ({QUEUE_MAX} prompts); wait for a turn to finish"),
                ErrorClass::Fatal,
            ));
        }
        self.announce_queue(session_id);
        Ok(id)
    }

    /// Open the queue's drain gate for a session the window let go while it
    /// was held: with no tab there is no send gate to honour, and a remote
    /// driver's parked prompts would otherwise wait for a tab that never
    /// comes back.
    pub(super) fn unpause_queue(self: &Arc<Self>, session_id: &str) {
        let was_paused = self.sessions.extra_mut(session_id, |steering| {
            steering.is_some_and(|steering| std::mem::replace(&mut steering.control.paused, false))
        });
        if was_paused {
            tracing::info!(target: "atlas::steering", session = session_id, "held session's queue released with its tab");
        }
        self.maybe_drain(session_id);
    }

    fn announce_queue(&self, session_id: &str) {
        let queue = self.queue_on_wire(session_id);
        self.projector
            .note_queue_changed(&acp::SessionId::new(session_id), queue);
    }

    fn known_session(&self, session_id: &str) -> Result<()> {
        if self.sessions.contains(session_id) {
            Ok(())
        } else {
            Err(HostError::unknown_session())
        }
    }

    /// Start the first prompt the seat admits if nothing this host dispatched
    /// is running and the queue may drain; the rest stay parked. Answers the
    /// item started and its turn.
    fn maybe_drain(self: &Arc<Self>, session_id: &str) -> Option<(String, u64)> {
        let (item, at) = self.sessions.extra_mut(session_id, |steering| {
            let Steering { control, seat } = steering?;
            if control.running.is_some()
                || ((control.paused || control.halted) && !control.force_next)
            {
                return None;
            }
            let at = control
                .queue
                .iter()
                .position(|item| seat.as_ref().is_none_or(|seat| seat.admits(&item.origin)))?;
            let item = control.queue.remove(at).expect("position is in range");
            if control.force_next {
                // The user picked this one to run: the queue is theirs again.
                control.halted = false;
            }
            control.force_next = false;
            control.running = Some(RESERVED);
            Some((item, at))
        })?;
        self.announce_queue(session_id);
        match self.dispatch(session_id, item.prompt.clone(), item.origin.clone()) {
            Ok(turn_seq) => Some((item.id, turn_seq)),
            Err(e) => {
                // Put it back where it was: a prompt that could not start (the
                // agent went away) is still what the user asked for, and the
                // window's rebind drains it.
                tracing::warn!(target: "atlas::steering", session = session_id, "queued prompt did not start: {e}");
                self.sessions.with_extra(session_id, |steering| {
                    let control = &mut steering.control;
                    if control.running == Some(RESERVED) {
                        control.running = None;
                    }
                    let at = at.min(control.queue.len());
                    control.queue.insert(at, item);
                });
                self.announce_queue(session_id);
                None
            }
        }
    }

    /// A turn this host dispatched came back. If it is still the one the
    /// controller is waiting on, the queue may move — unless the turn
    /// `failed`, which halts a non-empty queue instead (audit #77).
    fn turn_returned(self: &Arc<Self>, session_id: &str, turn_seq: u64, failed: bool) {
        let ours = self.sessions.extra_mut(session_id, |steering| {
            let Some(steering) = steering else {
                return false;
            };
            if steering.control.running != Some(turn_seq) {
                // Superseded by a newer dispatch: that one's return drains.
                return false;
            }
            let control = &mut steering.control;
            control.running = None;
            control.cancel = None;
            control.halted = failed && control.has_queue();
            if control.halted {
                tracing::info!(target: "atlas::steering", session = session_id, "a failed turn halted the queue");
            }
            true
        });
        if ours {
            self.maybe_drain(session_id);
        }
    }

    /// What the send path records a prompt against: the session's plugin, its
    /// directory, and the model it runs on (the user's pick, else the agent's
    /// own default — the picker's value).
    fn send_meta(&self, session_id: &str) -> Result<(String, String, Option<String>)> {
        let info = self
            .sessions
            .info(session_id)
            .ok_or_else(HostError::unknown_session)?;
        let model = info
            .current_model
            .or_else(|| self.default_model(session_id));
        Ok((info.plugin_id, info.cwd, model))
    }

    /// Start a turn: the side effects, the turn's identity, the stamp that
    /// announces the prompt, then the turn itself on a task of its own.
    fn dispatch(self: &Arc<Self>, session_id: &str, prompt: Prompt, origin: Origin) -> Result<u64> {
        let (plugin_id, cwd, model) = self.send_meta(session_id)?;

        // Every lookup that can fail comes before the side effects: a dispatch
        // that fails after them is put back on the queue (`maybe_drain`), and
        // its next attempt would record the same prompt twice.
        let embedded_context =
            !prompt.pastes.is_empty() && self.prompt_embedded_context(session_id)?;
        let turn_seq = self
            .sessions
            .next_turn_seq(session_id)
            .ok_or_else(HostError::unknown_session)?;

        let (cancel_tx, mut cancelled) = tokio::sync::watch::channel(false);
        let preparation = self.sessions.with_extra(session_id, |steering| {
            if let Some(previous) = steering.control.cancel.replace(cancel_tx) {
                previous.send_replace(true);
            }
            steering.control.running = Some(turn_seq);
            steering.control.preparation.clone()
        });
        self.begin_atlas_turn(session_id);
        let this = self.clone();
        let session_key = session_id.to_owned();
        // The session's own agent, for every history write below: two agents
        // can share a session id (#86).
        let history_agent: atlas_acp_thread::AgentId = plugin_id.as_str().into();
        tauri::async_runtime::spawn(async move {
            let acp_id = acp::SessionId::new(session_key.clone());
            let thread = this
                .history()
                .and_then(|history| history.thread_for_agent(&history_agent, &acp_id));
            let sent = async {
                let prepared = preparation.acquire().await?;
                if this.sessions.info(&session_key).is_none() {
                    return Ok(acp::StopReason::Cancelled);
                }
                if let Some(hooks) = this.prompt_hooks() {
                    let key = session_key.clone();
                    let cwd = cwd.clone();
                    let prompt = prompt.clone();
                    let origin = origin.clone();
                    tokio::task::spawn_blocking(move || {
                        hooks.prompt_sent(&PromptSent {
                            session_id: &key,
                            cwd: &cwd,
                            plugin_id: &plugin_id,
                            model: model.as_deref(),
                            text: &prompt.text,
                            origin: &origin,
                            from_atlas: prompt.from_atlas,
                        });
                    })
                    .await
                    .map_err(|e| anyhow::anyhow!("prompt preparation failed: {e}"))?;
                }
                let content = prompt::with_pasted_texts(
                    prompt::with_resource_links(
                        prompt::compose(prompt.text, prompt.images),
                        prompt.resource_links,
                    ),
                    prompt.pastes,
                    embedded_context,
                );
                this.refresh_branch(&history_agent, &acp_id, &cwd);
                this.refresh_model(&history_agent, &acp_id);
                this.projector.set_turn_seq(&acp_id, turn_seq);
                if !content.is_empty() && !prompt.from_atlas {
                    this.projector
                        .stamp_user_message(&acp_id, origin, prompt.client_message_id);
                }
                // A Stop during preparation records a cancelled local turn,
                // without starting the agent after Stop already returned.
                let cancelled_before_send = || -> anyhow::Result<acp::StopReason> {
                    if let Ok(handle) = this.thread(&session_key) {
                        let mut thread = lock_thread(&handle);
                        thread.push_user_prompt(None, content.iter().cloned());
                        let turn = thread.begin_turn();
                        thread.end_turn_unless_superseded(turn, acp::StopReason::Cancelled);
                    }
                    Ok(acp::StopReason::Cancelled)
                };
                if *cancelled.borrow() {
                    return cancelled_before_send();
                }
                if let Some(thread) = thread {
                    this.open_turns.begin(thread, prompt.restart_continuations);
                }
                // The thread this turn is sent on, held so the turn can still
                // be cancelled once its session's record is gone: the
                // registry's end forgets the manager's handle, and the id
                // then names nothing to cancel (audit #85).
                let sent_on = this.thread(&session_key).ok();
                let send = this.manager.send(&acp_id, content.clone());
                tokio::pin!(send);
                let started = std::sync::atomic::AtomicBool::new(false);
                let mut prepared = Some(prepared);
                let result = {
                    use std::future::Future;
                    let polling = std::future::poll_fn(|cx| {
                        started.store(true, std::sync::atomic::Ordering::Release);
                        // The first poll synchronously opens the manager's turn
                        // before yielding to its connection. Only then may a
                        // newer preparation stamp another turn's metadata.
                        let result = send.as_mut().poll(cx);
                        prepared.take();
                        result
                    });
                    tokio::pin!(polling);
                    tokio::select! {
                        biased;
                        _ = cancelled.changed() => None,
                        result = &mut polling => Some(result),
                    }
                };
                match result {
                    Some(result) => result,
                    None if !started.load(std::sync::atomic::Ordering::Acquire) => {
                        cancelled_before_send()
                    }
                    None => {
                        if this.is_current_turn(&session_key, turn_seq) {
                            this.manager.cancel(&acp_id);
                        } else if this.sessions.info(&session_key).is_none() {
                            // The session ended under the turn. A newer turn
                            // would have a record; with none, this turn is
                            // the thread's last and nothing else stops it.
                            if let Some(thread) = &sent_on {
                                lock_thread(thread).cancel();
                            }
                        }
                        send.await
                    }
                }
            }
            .await;
            // Every way out of the turn ends it, a superseded one included:
            // each send counted itself in, so each counts itself out.
            this.end_atlas_turn(&session_key);
            // A superseded turn's end must not write out the turn that
            // replaced it. A session closed meanwhile ended its turn with it.
            if let Some(thread) = thread {
                let superseded = this
                    .sessions
                    .info(&session_key)
                    .is_some_and(|info| info.turn_seq != turn_seq);
                if !superseded {
                    this.open_turns.end(thread);
                }
            }
            // A wake held for this turn goes out once the session is idle.
            this.drain_wakes_later(&session_key);
            // A turn cut short by its session ending (the agent went) is not
            // the turn failing: the rebind runs what was queued behind it.
            let failed = turn_failed(&sent) && this.sessions.contains(&session_key);
            if let Err(e) = sent {
                // A send that was superseded reports back late, and its failure
                // belongs to a turn that is already over. Announcing it anyway
                // stamps the error with whatever turn is current — so the
                // cancelled turn's error lands on the live one, and the chat
                // shows a failure for a turn that is still streaming. Same
                // omission as the thread's own turn guard one layer down
                // (ATL-229).
                if this.is_current_turn(&session_key, turn_seq) {
                    let message = format!("{e:#}");
                    let class = classify_message(&message);
                    // A failure is a raised hand: a snoozed session wakes for it.
                    if let Some(history) = this.history() {
                        history.note_failure(&history_agent, &acp_id, Utc::now());
                    }
                    this.projector.note_turn_failed(
                        &acp_id,
                        message,
                        Some(class.wire_token().to_string()),
                    );
                } else {
                    tracing::debug!(
                        session = %acp_id,
                        turn_seq,
                        "dropping a superseded turn's failure: {e:#}"
                    );
                }
            }
            this.turn_returned(&session_key, turn_seq, failed);
        });
        Ok(turn_seq)
    }

    // ---- answers ---------------------------------------------------------

    /// Answer a permission prompt by the `request_id` its delta carried.
    ///
    /// The first answer wins; a second (the window and a remote driver racing,
    /// or a prompt the agent already withdrew) gets "not pending".
    pub fn answer_permission(
        &self,
        session_id: &str,
        request_id: Uuid,
        decision: PermissionDecision,
        origin: Origin,
    ) -> Result<()> {
        note_steer("answer_permission", session_id, &origin);
        let key = self.projector.permission_key(&request_id).ok_or_else(|| {
            HostError::new("permission request is not pending", ErrorClass::Fatal)
        })?;
        let handle = self.thread_in(key.agent_id, &key.session_id)?;
        match decision {
            PermissionDecision::Selected { option_id } => {
                // The option's kind decides what the thread does with the tool
                // call, so it is read back off the pending request rather than
                // trusted from the caller.
                let kind = pending_option_kind(&handle, &key.tool_call_id, &option_id).ok_or_else(
                    || HostError::new("permission option is not offered", ErrorClass::Fatal),
                )?;
                lock_thread(&handle).authorize_tool_call(
                    key.tool_call_id,
                    SelectedPermissionOutcome::new(acp::PermissionOptionId::new(option_id), kind),
                );
            }
            PermissionDecision::Cancelled => {
                lock_thread(&handle).cancel_tool_call_authorization(&key.tool_call_id);
            }
        }
        Ok(())
    }

    /// Which session a pending permission prompt belongs to — what lets a
    /// room refuse an answer aimed at another session's prompt. `None` when
    /// nothing by that id is pending.
    pub fn permission_session(&self, request_id: Uuid) -> Option<String> {
        self.projector
            .permission_key(&request_id)
            .map(|key| key.session_id.to_string())
    }

    /// Which session a pending elicitation belongs to. `None` when nothing by
    /// that id is pending **or** it is request-scoped (a sign-in prompt,
    /// which belongs to no session and is the desktop's to answer).
    pub fn elicitation_session(&self, request_id: Uuid) -> Option<String> {
        self.projector
            .elicitation_key(&request_id)
            .map(|key| key.session_id.to_string())
    }

    /// The kind of one option on a pending permission prompt — what lets a
    /// remote gate tell a standing (`AllowAlways`) grant from a one-off before
    /// answering. `None` when the prompt or the option is not pending.
    pub fn permission_option_kind(
        &self,
        request_id: Uuid,
        option_id: &str,
    ) -> Option<acp::PermissionOptionKind> {
        let key = self.projector.permission_key(&request_id)?;
        let handle = self.thread_in(key.agent_id, &key.session_id).ok()?;
        pending_option_kind(&handle, &key.tool_call_id, option_id)
    }

    /// Answer an elicitation by the `request_id` its delta (or the sign-in
    /// event) carried. Unknown ids are a no-op: the user can answer a dialog
    /// whose agent already died.
    pub fn answer_elicitation(
        &self,
        request_id: Uuid,
        action: &str,
        content: Option<serde_json::Value>,
        origin: Origin,
    ) -> Result<()> {
        note_steer("answer_elicitation", &request_id.to_string(), &origin);
        // Connection-level first: these belong to no session, so the
        // projector has never heard of them.
        //
        // The lookup is its own statement so the `answered_by` guard is
        // DROPPED before anything else is locked. As an `if let` scrutinee it
        // would live to the end of the block, held across the manager's entry
        // mutexes and the elicitation store's — a lock order nothing else
        // takes, and one that would only ever be discovered by deadlocking.
        //
        // A request-scoped elicitation is a sign-in prompt, and sign-in stays
        // on the desktop (design review §4.4): a remote origin is refused
        // before the entry is taken, so the window can still answer it.
        let request_scoped = {
            let mut answered_by = self
                .request_elicitations
                .answered_by
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if answered_by.contains_key(&request_id) && !matches!(origin, Origin::Local) {
                return Err(HostError::new(
                    "this prompt is answered on the desktop",
                    ErrorClass::Fatal,
                ));
            }
            answered_by.remove(&request_id)
        };
        if let Some((agent_id, entry_id)) = request_scoped {
            let Some(connection) = self.manager.connection_by_agent_id(&agent_id) else {
                return Ok(());
            };
            let Some(store) = connection.request_elicitations() else {
                return Ok(());
            };
            let mut store = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match elicitation_response(action, content)? {
                Some(response) => store.respond_to_elicitation(&entry_id, response),
                None => store.cancel_elicitation(&entry_id),
            }
            return Ok(());
        }
        let Some(key) = self.projector.elicitation_key(&request_id) else {
            return Ok(());
        };
        self.seat(&key.session_id.to_string(), &origin)?;
        let handle = self.thread_in(key.agent_id, &key.session_id)?;
        let mut thread = lock_thread(&handle);
        match elicitation_response(action, content)? {
            Some(response) => thread.respond_to_elicitation(&key.entry_id, response),
            None => thread.cancel_elicitation(&key.entry_id),
        }
        Ok(())
    }

    // ---- per-session settings -------------------------------------------

    /// Switch the session's mode. Capability-gated on the agent advertising
    /// modes; refused mid-turn by the native agent (the running turn keeps
    /// the permissions it started with), which comes back to the caller.
    ///
    /// Announced as `mode_changed` by the host: the native agent records a
    /// mode on its connection and raises no event, so without this a mode set
    /// by one client never reached another. An ACP agent's own echo of the
    /// same mode is deduplicated by the projector.
    pub async fn set_mode(&self, key: &SessionKey, mode_id: String, origin: Origin) -> Result<()> {
        note_steer("set_mode", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let modes = connection
            .session_modes(&session_id)
            .ok_or_else(|| HostError::new("this agent has no session modes", ErrorClass::Fatal))?;
        modes
            .set_mode(acp::SessionModeId::new(mode_id.clone()))
            .await
            .map_err(HostError::from)?;
        self.projector
            .note_mode_changed(&session_id, mode_id, Some(origin));
        Ok(())
    }

    pub async fn set_model(
        &self,
        key: &SessionKey,
        model_id: String,
        origin: Origin,
    ) -> Result<()> {
        note_steer("set_model", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let selector = connection.model_selector(&session_id).ok_or_else(|| {
            HostError::new("this agent has no model selection", ErrorClass::Fatal)
        })?;
        selector
            .select_model(AgentModelId::new(model_id.clone()))
            .await
            .map_err(HostError::from)?;
        self.sessions
            .set_current_model(&key.session_id, model_id.clone());
        // The thread has no event for this, so the host announces it — with
        // who picked it, so the window's pill and a remote viewer can say so.
        self.projector
            .note_model_changed(&session_id, model_id, Some(origin.clone()));
        // A model picked through a config option answers with the full option
        // list, and the options that depend on the model (a reasoning level a
        // new model offers differently) changed with it. The connection keeps
        // that answer; forward it as `set_config_option` does, or those knobs
        // stay stale until the agent happens to say otherwise (audit #38).
        if let Some(options) = connection.session_config_options(&session_id) {
            self.projector.note_config_options(
                &session_id,
                &options.config_options(),
                Some(origin),
            );
        }
        if let Some(plugin_id) = self.plugin_id_for_agent(key.agent_id) {
            self.refresh_model(&plugin_id.as_str().into(), &session_id);
        }
        Ok(())
    }

    pub async fn set_config_option(
        &self,
        key: &SessionKey,
        config_id: String,
        value: serde_json::Value,
        origin: Origin,
    ) -> Result<()> {
        note_steer("set_config_option", &key.session_id, &origin);
        self.seat(&key.session_id, &origin)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        let options = connection
            .session_config_options(&session_id)
            .ok_or_else(|| HostError::new("this agent has no config options", ErrorClass::Fatal))?;
        // A bool maps to the wire's boolean form, anything else to the select
        // form — the same mapping the old stack made.
        let value = match value {
            serde_json::Value::Bool(on) => acp::SessionConfigOptionValue::boolean(on),
            // A string rides as-is; anything else is re-serialized so an agent
            // that advertised, say, a numeric option still gets its own value
            // back rather than a quoted JSON blob.
            other => acp::SessionConfigOptionValue::value_id(
                other
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| other.to_string()),
            ),
        };
        let confirmed = options
            .set_config_option(acp::SessionConfigId::new(config_id), value)
            .await
            .map_err(HostError::from)?;
        // The response is the authoritative echo — a follow-up notification is
        // optional, and most agents never send one. Discarding this list is
        // what made the effort pill snap back: the set WORKED on the agent and
        // nothing ever told the frontend (#32). Same shape as
        // `note_model_changed`, for the same reason.
        self.projector
            .note_config_options(&session_id, &confirmed, Some(origin));
        Ok(())
    }

    /// The semantic category the agent gave one of its config options —
    /// what lets a remote gate tell a thinking-level knob from a sandbox or
    /// approval switch before setting it (ADR-0002: the agent's own tag, not
    /// a table keyed by agent id). `None` when the agent lists no such option,
    /// or lists it with no category: either way it is one the gate cannot
    /// classify, and the gate treats it as owner-only.
    pub fn config_option_category(
        &self,
        key: &SessionKey,
        config_id: &str,
    ) -> Option<acp::SessionConfigOptionCategory> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id).ok()?)
            .connection()
            .clone();
        let options = connection.session_config_options(&session_id)?;
        options
            .config_options()
            .iter()
            .find(|option| option.id.0.as_ref() == config_id)
            .and_then(|option| option.category.clone())
    }

    /// Which per-session controls the agent advertises for `key` — the
    /// connection's word (`session_modes`, `model_selector`,
    /// `session_config_options` returning `Some`), not whether a list happens
    /// to be non-empty at this instant: a native session whose catalogue
    /// fetch failed at start still *has* model selection, and a room opened
    /// then should take a `set_model` once the catalogue is back.
    pub fn session_controls(&self, key: &SessionKey) -> Result<SessionControls> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        Ok(SessionControls {
            modes: connection.session_modes(&session_id).is_some(),
            models: connection.model_selector(&session_id).is_some(),
            config: connection.session_config_options(&session_id).is_some(),
        })
    }

    // ---- holds -----------------------------------------------------------

    /// Keep a session running without needing its tab.
    ///
    /// While any hold is taken, the window dropping the session — its tab
    /// closing, its project discarded from the hot set — leaves it running:
    /// the turn goes on, the queue drains, and reopening the thread rebinds to
    /// the live session and hydrates from its snapshot. `holder` names who
    /// holds it (an RC session id, `"dev"`), so two holders release
    /// independently. Announced as `hold_changed` on the first hold.
    pub fn hold_session(&self, session_id: &str, holder: &str) -> Result<()> {
        self.hold_session_in(None, session_id, holder)
    }

    /// [`Self::hold_session`], for `agent_id`'s session when the caller knows
    /// the agent: two agents can share a session id (#86), and by the bare id
    /// such a session cannot be held.
    pub fn hold_session_in(
        &self,
        agent_id: Option<AgentId>,
        session_id: &str,
        holder: &str,
    ) -> Result<()> {
        let held = match agent_id {
            Some(id) => {
                let agent = self.record_for(id)?.agent;
                self.sessions.hold_of(&agent, session_id, holder)
            }
            None => self.sessions.hold(session_id, holder),
        };
        let first = held.ok_or_else(HostError::unknown_session)?;
        if first {
            tracing::info!(target: "atlas::steering", session = session_id, holder, "session held");
            self.projector
                .note_hold_changed(&acp::SessionId::new(session_id), true);
        }
        Ok(())
    }

    /// Let go of a hold. The last one going is announced as `hold_changed`,
    /// and if the window had already let the session go meanwhile, the
    /// session is torn down now — what the window's drop would have done.
    /// Releasing a hold that is not taken, or on a session already gone, is a
    /// no-op.
    pub async fn release_session(&self, session_id: &str, holder: &str) -> Result<()> {
        self.release_session_in(None, session_id, holder).await
    }

    /// [`Self::release_session`], for `agent_id`'s session when the caller
    /// knows the agent (#86).
    pub async fn release_session_in(
        &self,
        agent_id: Option<AgentId>,
        session_id: &str,
        holder: &str,
    ) -> Result<()> {
        let scoped = match agent_id {
            Some(id) => Some((id, self.record_for(id)?.agent)),
            None => None,
        };
        // Taken before the release, which may end the session and forget
        // the manager's handle with it (audit #85).
        let (thread, released) = match &scoped {
            Some((id, agent)) => (
                self.thread_in(*id, &acp::SessionId::new(session_id)).ok(),
                self.sessions.release_of(agent, session_id, holder),
            ),
            None => (
                self.thread(session_id).ok(),
                self.sessions.release(session_id, holder),
            ),
        };
        let ended = match released {
            Released::NotHeld | Released::StillHeld => return Ok(()),
            Released::Last => None,
            Released::LastAndEnded(ended) => {
                // The window had already let it go: the session ends here,
                // and a turn still running goes with it.
                if let Some(thread) = &thread {
                    lock_thread(thread).cancel();
                }
                Some(ended)
            }
        };
        let window_gone = ended.is_some();
        tracing::info!(target: "atlas::steering", session = session_id, holder, window_gone, "session hold released");
        self.projector
            .note_hold_changed(&acp::SessionId::new(session_id), false);
        match ended {
            Some(ended) => self.finish_close(ended).await,
            None => Ok(()),
        }
    }

    /// Whether any hold is keeping the session open.
    pub fn is_held(&self, session_id: &str) -> bool {
        self.sessions.is_held(session_id)
    }

    /// Held sessions with a turn this host dispatched in flight — what the
    /// sidebar shows as "working" for a held thread with no tab.
    pub(super) fn held_working_sessions(&self) -> std::collections::HashSet<String> {
        self.sessions
            .held_sessions()
            .into_iter()
            .filter(|id| {
                self.sessions.extra_mut(id, |steering| {
                    steering.is_some_and(|steering| steering.control.running.is_some())
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{fresh_host_with_native_and_sink, ScriptedServer};
    use super::*;
    use atlas_acp_thread::test_support::{FakeConnection, FakeHandle};
    use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope};
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<SessionDeltaEnvelope>>);

    impl DeltaSink for Recorder {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            self.0.lock().unwrap().push(envelope);
        }
    }

    impl Recorder {
        fn deltas(&self) -> Vec<SessionDelta> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|e| e.delta.clone())
                .collect()
        }

        fn last_queue(&self) -> Option<Vec<String>> {
            self.last_queue_items()
                .map(|queue| queue.into_iter().map(|q| q.text).collect())
        }

        fn last_queue_items(&self) -> Option<Vec<QueuedPrompt>> {
            self.deltas().into_iter().rev().find_map(|d| match d {
                SessionDelta::QueueChanged { queue } => Some(queue),
                _ => None,
            })
        }
    }

    #[derive(Default)]
    struct SeenPrompts(Mutex<Vec<(String, String, Origin)>>);

    #[derive(Default)]
    struct SlowPreparation {
        entered: std::sync::atomic::AtomicBool,
        timed_out: std::sync::atomic::AtomicBool,
        release: (Mutex<bool>, std::sync::Condvar),
    }

    impl PromptHooks for SlowPreparation {
        fn prompt_sent(&self, _: &PromptSent<'_>) {
            self.entered
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let guard = self.release.0.lock().unwrap();
            let (_released, waited) = self
                .release
                .1
                .wait_timeout_while(guard, Duration::from_secs(5), |released| !*released)
                .unwrap();
            self.timed_out
                .store(waited.timed_out(), std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl PromptHooks for SeenPrompts {
        fn prompt_sent(&self, sent: &PromptSent<'_>) {
            self.0.lock().unwrap().push((
                sent.plugin_id.to_string(),
                sent.text.to_string(),
                sent.origin.clone(),
            ));
        }
    }

    struct Fixture {
        host: Arc<AgentHost>,
        /// The native agent's script: its turns run until released (or
        /// cancelled), and it remembers every prompt it was sent.
        native: FakeHandle,
        recorder: Arc<Recorder>,
        key: SessionKey,
        dir: PathBuf,
    }

    async fn fixture(session_id: &'static str) -> Fixture {
        let native = FakeConnection::builder()
            .agent(ATLAS_AGENT_ID)
            .session_id(session_id)
            .hold_prompts()
            .handle();
        let recorder = Arc::new(Recorder::default());
        let (host, dir) =
            fresh_host_with_native_and_sink(ScriptedServer::new(native.clone()), recorder.clone());
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        let init = host
            .new_session(agent_id, dir.clone(), Vec::new())
            .await
            .expect("a session opens");
        Fixture {
            host,
            native,
            recorder,
            key: init.key,
            dir,
        }
    }

    async fn until(what: &str, check: impl Fn() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// The room's account in these tests.
    const OWNER: &str = "user_owner";

    fn ada() -> Origin {
        Origin::Remote {
            id: "user_member".into(),
            name: Some("Ada".into()),
        }
    }

    fn ada_drives() -> Option<RemoteDriver> {
        Some(RemoteDriver {
            id: "user_member".into(),
            name: Some("Ada".into()),
        })
    }

    /// Wait for the cancelled or released turn to come back, so the next
    /// drain is the controller's and not the turn's tail.
    async fn idle(f: &Fixture) {
        let session_id = f.key.session_id.clone();
        let host = f.host.clone();
        until("the turn returned", move || {
            host.sessions
                .extra_mut(&session_id, |s| s.is_some_and(|s| !s.turn_running()))
        })
        .await;
    }

    #[tokio::test]
    async fn stopping_during_blocking_preparation_never_starts_the_agent() {
        let f = fixture("s-stop-preparation").await;
        let hooks = Arc::new(SlowPreparation::default());
        f.host.set_prompt_hooks(hooks.clone());
        f.host
            .submit(
                &f.key,
                Prompt::text("do not run after Stop"),
                Origin::Local,
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        until("preparation started", || {
            hooks.entered.load(std::sync::atomic::Ordering::SeqCst)
        })
        .await;
        // The synchronous submit and the current-thread runtime both stay
        // responsive while the hook is still waiting on blocking work.
        assert!(!hooks.timed_out.load(std::sync::atomic::Ordering::SeqCst));
        f.host.stop(&f.key, Origin::Local).unwrap();
        *hooks.release.0.lock().unwrap() = true;
        hooks.release.1.notify_all();
        idle(&f).await;
        assert!(
            f.native.prompts().is_empty(),
            "Stop must win before agent dispatch"
        );
        until("the cancelled turn reaches the delta sink", || {
            f.recorder
                .deltas()
                .iter()
                .any(|delta| matches!(delta, SessionDelta::TurnFinished { .. }))
        })
        .await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The room's link dropping is not the driver losing the seat: while it
    /// is down their parked prompts are kept — and not run under nobody's
    /// watch — and they are still there when the link comes back with them
    /// driving. Only a real seat change discards them.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_drivers_queued_prompts_survive_the_rooms_link_dropping() {
        let f = fixture("s-blip").await;
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        f.host
            .submit(
                &f.key,
                Prompt::text("ada one"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the driver prompts");
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .submit(
                &f.key,
                Prompt::text("ada two"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        assert_eq!(f.recorder.last_queue(), Some(vec!["ada two".into()]));

        // The link drops: nobody drives, but Ada's seat is held.
        f.host
            .set_remote_seat(&f.key.session_id, OWNER, None, ada_drives().map(|d| d.id));
        assert_eq!(f.recorder.last_queue(), Some(vec!["ada two".into()]));
        f.native.release_prompt();
        idle(&f).await;
        assert_eq!(f.native.prompts(), ["ada one"], "held, not run");

        // Back, with Ada still driving: her prompt goes.
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        until("ada two runs", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts(), ["ada one", "ada two"]);
        f.native.release_prompt();
        idle(&f).await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A driver who loses the seat — kicked, superseded, released — takes
    /// their parked prompts with them: nothing of theirs runs under the next
    /// driver's name, and the queue delta says so.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_former_drivers_queued_prompts_are_discarded_with_the_seat() {
        let f = fixture("s-kicked").await;
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        f.host
            .submit(
                &f.key,
                Prompt::text("ada one"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the driver prompts");
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for text in ["ada two", "ada three"] {
            let queued = f
                .host
                .submit(&f.key, Prompt::text(text), ada(), SubmitPolicy::QueueIfBusy)
                .unwrap();
            assert!(matches!(queued, Submitted::Queued { .. }));
        }
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["ada two".into(), "ada three".into()])
        );

        // The owner kicks Ada: the seat comes back to the owner.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        assert_eq!(f.recorder.last_queue(), Some(Vec::new()));
        assert!(f.host.snapshot_meta(&f.key).unwrap().queue.is_empty());

        f.native.release_prompt();
        idle(&f).await;
        assert_eq!(f.native.prompts(), ["ada one"], "nothing of Ada's drained");
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Only the seated person's prompts drain: the owner's parked prompt
    /// waits while Ada holds the seat, and goes when the seat returns. The
    /// owner's own phone counts as the owner.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_local_prompt_waits_while_a_remote_driver_holds_the_seat() {
        let f = fixture("s-wait").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .enqueue(&f.key, Prompt::text("mine, later"), Origin::Local)
            .unwrap();
        // The owner's phone, while the owner drives: the owner's too.
        let owners_phone = Origin::Remote {
            id: OWNER.into(),
            name: None,
        };
        f.host
            .submit(
                &f.key,
                Prompt::text("from my phone"),
                owners_phone,
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();

        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        // The seat changing hands keeps the owner's prompts — typed and from
        // their phone alike — parked.
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["mine, later".into(), "from my phone".into()])
        );
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();

        f.native.release_prompt();
        until("ada's prompt ran next", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "ada's", "the driver's went first");
        f.native.release_prompt();
        idle(&f).await;
        assert_eq!(
            f.native.prompts().len(),
            2,
            "the owner's prompts stay parked while Ada drives"
        );
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["mine, later".into(), "from my phone".into()])
        );

        // The seat returns: the owner's prompts drain in order.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        until("the owner's first prompt ran", || {
            f.native.prompts().len() == 3
        })
        .await;
        assert_eq!(f.native.prompts()[2], "mine, later");
        f.native.release_prompt();
        until("then the phone's", || f.native.prompts().len() == 4).await;
        assert_eq!(f.native.prompts()[3], "from my phone");
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The queue is bounded, and a prompt past the bound is refused in the
    /// words the room maps to `in_flight`.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_queue_is_capped() {
        let f = fixture("s-cap").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for n in 0..QUEUE_MAX {
            f.host
                .enqueue(&f.key, Prompt::text(format!("q{n}")), Origin::Local)
                .unwrap_or_else(|e| panic!("prompt {n} parks: {}", e.message));
        }
        let refused = f
            .host
            .submit(
                &f.key,
                Prompt::text("one too many"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap_err();
        assert!(
            refused.message.contains("queue is full"),
            "{}",
            refused.message
        );
        assert_eq!(f.host.queue_of(&f.key.session_id).len(), QUEUE_MAX);
        f.host.stop(&f.key, Origin::Local).unwrap();
        idle(&f).await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A long prompt travels whole to the agent and in the snapshot, and cut
    /// to the wire bound (marked `truncated`) on `queue_changed`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_prompts_text_is_cut_on_the_wire_but_sent_whole() {
        let f = fixture("s-long").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        // Multi-byte, so the cut has a boundary to respect.
        let long = "é".repeat(QUEUE_WIRE_TEXT_MAX);
        assert!(long.len() > QUEUE_WIRE_TEXT_MAX);
        f.host
            .enqueue(&f.key, Prompt::text(long.clone()), Origin::Local)
            .unwrap();
        let on_wire = f.recorder.last_queue().unwrap().remove(0);
        assert!(on_wire.len() <= QUEUE_WIRE_TEXT_MAX, "{}", on_wire.len());
        assert!(long.starts_with(&on_wire));
        // The delta says it is a head, and the snapshot — what an edit, an
        // agent switch or a restart onto a new session reads — has it whole
        // (audit #78).
        assert_eq!(
            f.recorder.last_queue_items().unwrap()[0].truncated,
            Some(true)
        );
        let snapshot = f.host.snapshot_meta(&f.key).unwrap().queue.remove(0);
        assert_eq!(snapshot.text, long, "the snapshot carries all of it");
        assert_eq!(snapshot.truncated, None);

        f.native.release_prompt();
        until("the long prompt ran", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], long, "the agent got all of it");
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[test]
    fn the_head_of_a_text_is_cut_on_a_character_boundary() {
        assert_eq!(head_of("abc", 8), "abc");
        assert_eq!(head_of("abcdef", 3), "abc");
        // "é" is two bytes: a cut inside it steps back.
        assert_eq!(head_of("aéb", 2), "a");
        assert_eq!(head_of("aéb", 3), "aé");
    }

    /// A sign-in prompt belongs to no session and is answered on the desktop:
    /// a remote answer to one is refused and the entry stays for the window.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_scoped_elicitation_is_not_answerable_remotely() {
        let f = fixture("s-signin").await;
        let request_id = Uuid::new_v4();
        f.host
            .request_elicitations
            .answered_by
            .lock()
            .unwrap()
            .insert(
                request_id,
                (
                    ThreadAgentId::new(ATLAS_AGENT_ID),
                    ElicitationEntryId("e-1".into()),
                ),
            );
        assert_eq!(f.host.elicitation_session(request_id), None);
        let refused = f
            .host
            .answer_elicitation(request_id, "accept", None, ada())
            .unwrap_err();
        assert!(refused.message.contains("desktop"), "{}", refused.message);
        assert!(
            f.host
                .request_elicitations
                .answered_by
                .lock()
                .unwrap()
                .contains_key(&request_id),
            "still the window's to answer"
        );
        // The window's own answer takes it (a no-op here: no connection by
        // that agent id is open in this fixture).
        f.host
            .answer_elicitation(request_id, "accept", None, Origin::Local)
            .unwrap();
        assert!(!f
            .host
            .request_elicitations
            .answered_by
            .lock()
            .unwrap()
            .contains_key(&request_id));
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A room ending — the account signed out, its credential rejected, the
    /// room closed from the web — releases the room's hold and nothing else:
    /// the session stays, and a turn in flight is not interrupted (CC-1: the
    /// remote session ends, the local one runs on).
    #[tokio::test(flavor = "multi_thread")]
    async fn ending_a_room_leaves_the_session_and_its_turn_running() {
        let f = fixture("s-room-ends").await;
        f.host.hold_session(&f.key.session_id, "rc:01ROOM").unwrap();
        f.host
            .set_remote_driver(&f.key.session_id, OWNER, ada_drives());
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        until("the turn runs", || f.native.prompts() == ["ada's"]).await;

        // What `rc::release` does when a room ends, in order.
        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        f.host
            .release_session(&f.key.session_id, "rc:01ROOM")
            .await
            .unwrap();

        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "the session is still here"
        );
        assert!(!f.host.is_held(&f.key.session_id));
        assert!(
            f.host
                .sessions
                .extra_mut(&f.key.session_id, |s| s.is_some_and(|s| s.turn_running())),
            "the turn was not cancelled"
        );
        assert_eq!(f.host.remote_driver(&f.key.session_id), None);
        // The owner's composer is free again, and the agent's one prompt is
        // still the only one it got.
        f.host
            .enqueue(&f.key, Prompt::text("mine"), Origin::Local)
            .expect("the seat is the owner's");
        assert_eq!(f.native.prompts(), ["ada's"]);
        f.native.release_prompt();
        until("then the owner's", || f.native.prompts().len() == 2).await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A held session the window let go has no send gate left to honour: its
    /// queue is released with the tab, so a remote driver's prompts run.
    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_a_held_sessions_tab_releases_its_paused_queue() {
        let f = fixture("s-held-queue").await;
        f.host.hold_session(&f.key.session_id, "rc:room").unwrap();
        f.host.set_queue_paused(&f.key, true).unwrap();
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                ada(),
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        assert!(f.native.prompts().is_empty(), "paused by the window's gate");

        f.host.drop_session(&f.key.session_id).await.unwrap();
        until("the parked prompt ran once the tab was gone", || {
            f.native.prompts() == ["ada's"]
        })
        .await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The side effects travel with the prompt into the host, whoever sent
    /// it: a remote prompt is recorded exactly like a local one.
    #[tokio::test(flavor = "multi_thread")]
    async fn every_prompt_runs_the_send_side_effects_and_is_announced() {
        let f = fixture("s-hooks").await;
        let seen = Arc::new(SeenPrompts::default());
        f.host.set_prompt_hooks(seen.clone());
        let remote = Origin::Remote {
            id: "guest:1".into(),
            name: Some("Sam".into()),
        };

        let submitted = f
            .host
            .submit(
                &f.key,
                Prompt {
                    client_message_id: Some("cm-1".into()),
                    ..Prompt::text("fix the build")
                },
                remote.clone(),
                SubmitPolicy::QueueIfBusy,
            )
            .expect("submit");
        assert!(
            matches!(submitted, Submitted::Started { .. }),
            "idle: starts now"
        );
        until("the agent got the prompt", || {
            f.native.prompts() == ["fix the build"]
        })
        .await;

        assert_eq!(
            seen.0.lock().unwrap().clone(),
            [(
                ATLAS_AGENT_ID.to_string(),
                "fix the build".to_string(),
                remote.clone()
            )]
        );
        until("the prompt is on the wire", || {
            f.recorder.deltas().iter().any(|d| {
                matches!(d, SessionDelta::UserMessage { origin, client_message_id, message }
                    if origin == &remote
                        && client_message_id.as_deref() == Some("cm-1")
                        && message.content == "fix the build")
            })
        })
        .await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// While someone else holds the room's seat, the window's own steering is
    /// refused with their name; a remote prompt and the owner's stop still
    /// run; the seat coming back lifts the refusal.
    #[tokio::test(flavor = "multi_thread")]
    async fn local_steering_is_refused_while_a_remote_driver_holds_the_seat() {
        let f = fixture("s-seat").await;
        f.host.set_remote_driver(
            &f.key.session_id,
            OWNER,
            Some(RemoteDriver {
                id: "user_member".into(),
                name: Some("Ada".into()),
            }),
        );
        let refused = f
            .host
            .submit(
                &f.key,
                Prompt::text("mine"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap_err();
        assert!(
            refused.message.starts_with("Ada is driving"),
            "{}",
            refused.message
        );
        assert!(f
            .host
            .enqueue(&f.key, Prompt::text("later"), Origin::Local)
            .is_err());
        assert!(f
            .host
            .set_mode(&f.key, "plan".into(), Origin::Local)
            .await
            .is_err());
        assert!(f.native.prompts().is_empty(), "nothing reached the agent");

        // The driver's own prompt goes through the same entry and runs.
        f.host
            .submit(
                &f.key,
                Prompt::text("ada's"),
                Origin::Remote {
                    id: "user_member".into(),
                    name: Some("Ada".into()),
                },
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the driver prompts");
        until("the agent got the driver's prompt", || {
            f.native.prompts() == ["ada's"]
        })
        .await;
        // The owner's master power is never seat-gated.
        f.host.stop(&f.key, Origin::Local).expect("stop");

        f.host.set_remote_driver(&f.key.session_id, OWNER, None);
        assert_eq!(f.host.remote_driver(&f.key.session_id), None);
        f.host
            .submit(
                &f.key,
                Prompt::text("mine"),
                Origin::Local,
                SubmitPolicy::QueueIfBusy,
            )
            .expect("the seat is back");
        until("the owner's prompt ran", || f.native.prompts().len() == 2).await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A prompt submitted while a turn runs waits for it, then goes next — on
    /// the wire as a queue, in Rust where a remote driver can reach it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_prompt_submitted_mid_turn_queues_and_drains_when_it_ends() {
        let f = fixture("s-queue").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;

        let queued = f
            .host
            .submit(
                &f.key,
                Prompt::text("two"),
                Origin::Local,
                SubmitPolicy::QueueIfBusy,
            )
            .unwrap();
        assert!(matches!(queued, Submitted::Queued { .. }));
        f.host
            .enqueue(&f.key, Prompt::text("three"), Origin::Local)
            .unwrap();
        assert_eq!(
            f.recorder.last_queue(),
            Some(vec!["two".into(), "three".into()])
        );
        assert_eq!(f.host.snapshot_meta(&f.key).unwrap().queue.len(), 2);

        f.native.release_prompt();
        until("turn two runs", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "two");
        assert_eq!(f.recorder.last_queue(), Some(vec!["three".into()]));

        f.native.release_prompt();
        until("turn three runs", || f.native.prompts().len() == 3).await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Stop discards the queue (the snapshot agrees with the window), and a
    /// paused queue does not drain until it is released.
    #[tokio::test(flavor = "multi_thread")]
    async fn stop_discards_the_queue_and_a_paused_queue_waits() {
        let f = fixture("s-stop").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        for text in ["a", "b", "c"] {
            f.host
                .enqueue(&f.key, Prompt::text(text), Origin::Local)
                .unwrap();
        }
        f.host.stop(&f.key, Origin::Local).unwrap();
        assert_eq!(f.recorder.last_queue(), Some(Vec::new()));
        assert!(f.host.snapshot_meta(&f.key).unwrap().queue.is_empty());
        until("the cancelled turn returned", || {
            f.host
                .sessions
                .extra_mut("s-stop", |s| s.is_some_and(|s| !s.turn_running()))
        })
        .await;
        assert_eq!(f.native.prompts().len(), 1, "nothing drained after Stop");

        f.host.set_queue_paused(&f.key, true).unwrap();
        f.host
            .enqueue(&f.key, Prompt::text("held"), Origin::Local)
            .unwrap();
        assert_eq!(f.host.drain_queue(&f.key).unwrap(), None, "paused");
        f.host.set_queue_paused(&f.key, false).unwrap();
        until("released, it runs", || f.native.prompts().len() == 2).await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Send-now interrupts the running turn and runs the chosen prompt next,
    /// keeping the rest of the queue.
    #[tokio::test(flavor = "multi_thread")]
    async fn send_now_runs_one_prompt_next_and_keeps_the_rest() {
        let f = fixture("s-now").await;
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .enqueue(&f.key, Prompt::text("later"), Origin::Local)
            .unwrap();
        let urgent = f
            .host
            .enqueue(&f.key, Prompt::text("urgent"), Origin::Local)
            .unwrap();

        f.host.send_now(&f.key, &urgent, Origin::Local).unwrap();
        until("the urgent prompt runs", || f.native.prompts().len() == 2).await;
        assert_eq!(f.native.prompts()[1], "urgent");
        assert_eq!(f.recorder.last_queue(), Some(vec!["later".into()]));
        f.native.release_prompt();
        until("then the rest", || f.native.prompts().len() == 3).await;
        f.native.release_prompt();
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// A held session survives the window dropping it; releasing the last
    /// hold finishes the drop.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_held_session_outlives_its_tab_until_released() {
        let f = fixture("s-hold").await;
        f.host.hold_session("s-hold", "dev").unwrap();
        assert!(f.host.snapshot_meta(&f.key).unwrap().held);

        f.host.drop_session("s-hold").await.unwrap();
        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "the tab closed, the session did not"
        );

        f.host.release_session("s-hold", "dev").await.unwrap();
        assert!(f.host.snapshot_meta(&f.key).is_err(), "now it is gone");
        let held: Vec<bool> = f
            .recorder
            .deltas()
            .into_iter()
            .filter_map(|d| match d {
                SessionDelta::HoldChanged { held } => Some(held),
                _ => None,
            })
            .collect();
        assert_eq!(held, [true, false]);
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// Reopening a held session after its tab closed claims it for the window
    /// again: releasing the hold later must not tear it down under the tab.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reopened_held_session_is_the_windows_again() {
        let f = fixture("s-reopen").await;
        f.host.hold_session("s-reopen", "dev").unwrap();
        f.host.drop_session("s-reopen").await.unwrap();

        f.host
            .load_session(f.key.agent_id, "s-reopen".into(), f.dir.clone())
            .await
            .expect("rebinds to the live session");
        f.host.release_session("s-reopen", "dev").await.unwrap();
        assert!(
            f.host.snapshot_meta(&f.key).is_ok(),
            "still open in its tab"
        );
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The snapshot's `as_of_seq` is the stream's position, and an open
    /// permission prompt comes back with it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_snapshot_says_where_in_the_stream_it_is() {
        let f = fixture("s-seq").await;
        f.host
            .enqueue(&f.key, Prompt::text("x"), Origin::Local)
            .unwrap();
        let last_seq = f.recorder.0.lock().unwrap().last().map(|e| e.seq).unwrap();
        let snapshot = f.host.snapshot(&f.key).unwrap();
        assert!(snapshot.as_of_seq >= last_seq);
        assert!(snapshot.pending_permissions.is_empty());
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    /// The snapshot names the turn the session is on, so a window that binds
    /// it (a reload, a rebind after the agent restarted) adopts the numbering
    /// its turn-scoped deltas carry instead of refusing them as stale.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_snapshot_names_the_turn_the_session_is_on() {
        let f = fixture("s-turn").await;
        assert_eq!(f.host.snapshot(&f.key).unwrap().turn_seq, 0);
        let started = f
            .host
            .submit(&f.key, Prompt::text("x"), Origin::Local, SubmitPolicy::Now)
            .unwrap();
        let Submitted::Started { turn_seq } = started else {
            panic!("an idle session starts the prompt at once: {started:?}");
        };
        assert_eq!(f.host.snapshot(&f.key).unwrap().turn_seq, turn_seq);
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    // ---- a failed turn halts the queue (audit #77) ----------------------

    /// Start turn one with a hand-delivered answer and park `two` behind it.
    async fn queued_behind_a_turn(
        session_id: &'static str,
    ) -> (
        Fixture,
        tokio::sync::oneshot::Sender<anyhow::Result<acp::StopReason>>,
    ) {
        let f = fixture(session_id).await;
        let answer = f.native.queue_prompt();
        f.host
            .submit(
                &f.key,
                Prompt::text("one"),
                Origin::Local,
                SubmitPolicy::Now,
            )
            .unwrap();
        until("turn one runs", || f.native.prompts().len() == 1).await;
        f.host
            .enqueue(&f.key, Prompt::text("two"), Origin::Local)
            .unwrap();
        (f, answer)
    }

    fn halted(f: &Fixture) -> bool {
        f.host
            .sessions
            .extra_mut(&f.key.session_id, |s| s.is_some_and(|s| s.queue_halted()))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_turn_halts_the_queue_until_it_is_resumed() {
        let failures: [anyhow::Result<acp::StopReason>; 3] = [
            Err(anyhow::anyhow!("rate limited")),
            Ok(acp::StopReason::Refusal),
            Ok(acp::StopReason::MaxTokens),
        ];
        for (n, failure) in failures.into_iter().enumerate() {
            let (f, answer) = queued_behind_a_turn("s-fail-halts").await;
            let what = format!("failure #{n}");
            answer.send(failure).ok();
            idle(&f).await;
            assert!(halted(&f), "{what}: the queue was not halted");
            // The window's drain edge on idle must not run it either.
            assert_eq!(f.host.drain_queue(&f.key).unwrap(), None, "{what}");
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(f.native.prompts().len(), 1, "{what}: the queue drained");
            assert_eq!(f.recorder.last_queue(), Some(vec!["two".into()]), "{what}");

            assert!(f
                .host
                .resume_queue(&f.key, Origin::Local)
                .unwrap()
                .is_some());
            until("the resumed queue runs", || f.native.prompts().len() == 2).await;
            assert_eq!(f.native.prompts()[1], "two");
            assert!(!halted(&f));
            f.native.release_prompt();
            idle(&f).await;
            let _ = std::fs::remove_dir_all(&f.dir);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_turn_that_ends_well_still_drains_the_queue() {
        let (f, answer) = queued_behind_a_turn("s-ok-drains").await;
        answer.send(Ok(acp::StopReason::EndTurn)).ok();
        until("two runs", || f.native.prompts().len() == 2).await;
        assert!(!halted(&f));
        f.native.release_prompt();
        idle(&f).await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_now_runs_a_halted_queues_pick() {
        let (f, answer) = queued_behind_a_turn("s-fail-send-now").await;
        answer.send(Err(anyhow::anyhow!("rate limited"))).ok();
        idle(&f).await;
        let item = f.host.queue_of(&f.key.session_id)[0].id.clone();
        f.host.send_now(&f.key, &item, Origin::Local).unwrap();
        until("the pick runs", || f.native.prompts().len() == 2).await;
        assert!(!halted(&f));
        f.native.release_prompt();
        idle(&f).await;
        let _ = std::fs::remove_dir_all(&f.dir);
    }

    // ---- a model pick forwards the option list (audit #38) ---------------

    /// An agent whose model is one of its config options: picking a model
    /// answers with the whole list, where an option that depends on the model
    /// changed too. The selector stores that answer, as the ACP connection
    /// does, and the options read it back.
    #[derive(Default)]
    struct ModelAsOption(Mutex<Vec<acp::SessionConfigOption>>);

    fn option(id: &str, current: &str) -> acp::SessionConfigOption {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "type": "select",
            "currentValue": current,
            "options": [
                { "value": "a", "name": "A" },
                { "value": "b", "name": "B" },
            ],
        }))
        .expect("a select option")
    }

    struct Selector(Arc<ModelAsOption>);

    impl atlas_acp_thread::AgentModelSelector for Selector {
        fn list_models(
            &self,
        ) -> futures::future::BoxFuture<'static, anyhow::Result<atlas_acp_thread::AgentModelList>>
        {
            Box::pin(async { Ok(atlas_acp_thread::AgentModelList::Flat(Vec::new())) })
        }

        fn select_model(
            &self,
            model_id: AgentModelId,
        ) -> futures::future::BoxFuture<'static, anyhow::Result<()>> {
            *self.0 .0.lock().unwrap() =
                vec![option("model", model_id.as_str()), option("effort", "b")];
            Box::pin(async { Ok(()) })
        }

        fn selected_model(
            &self,
        ) -> futures::future::BoxFuture<'static, anyhow::Result<atlas_acp_thread::AgentModelInfo>>
        {
            Box::pin(async { Err(anyhow::anyhow!("not asked")) })
        }
    }

    impl atlas_acp_thread::AgentSessionConfigOptions for ModelAsOption {
        fn config_options(&self) -> Vec<acp::SessionConfigOption> {
            self.0.lock().unwrap().clone()
        }

        fn set_config_option(
            &self,
            _config_id: acp::SessionConfigId,
            _value: acp::SessionConfigOptionValue,
        ) -> futures::future::BoxFuture<'static, anyhow::Result<Vec<acp::SessionConfigOption>>>
        {
            Box::pin(async { Err(anyhow::anyhow!("not asked")) })
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_model_pick_forwards_the_option_list_it_was_answered_with() {
        let options = Arc::new(ModelAsOption::default());
        *options.0.lock().unwrap() = vec![option("model", "a"), option("effort", "a")];
        let native = FakeConnection::builder()
            .agent(ATLAS_AGENT_ID)
            .session_id("s-model-options")
            .model_selector(Arc::new(Selector(options.clone())))
            .config_options(options.clone())
            .handle();
        let recorder = Arc::new(Recorder::default());
        let (host, dir) =
            fresh_host_with_native_and_sink(ScriptedServer::new(native), recorder.clone());
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        let key = host
            .new_session(agent_id, dir.clone(), Vec::new())
            .await
            .expect("a session opens")
            .key;

        host.set_model(&key, "b".into(), Origin::Local)
            .await
            .expect("the pick");

        let announced = recorder.deltas().into_iter().rev().find_map(|d| match d {
            SessionDelta::ConfigOptionsUpdated { config_options, .. } => Some(config_options),
            _ => None,
        });
        let announced = announced.expect("the pick's option list never reached the window");
        let effort = announced
            .iter()
            .find(|o| o["id"] == "effort")
            .expect("the dependent option");
        assert_eq!(
            effort["currentValue"], "b",
            "the dependent knob stayed stale"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
