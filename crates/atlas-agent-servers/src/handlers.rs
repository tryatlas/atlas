//! The agent→client handler set.
//!
//! These are the requests an agent makes *of us* mid-turn: ask the user for
//! permission, read and write files, run commands, elicit input.
//!
//! **The dispatch queue is load-bearing, and awaiting handlers inline was tried
//! and failed.** The RPC crate dispatches inbound messages SERIALLY and awaits
//! each registered handler INLINE — the next message is not even parsed until
//! the previous handler's future resolves. The registered closures therefore
//! enqueue a work item and return immediately; the queue drains in wire order,
//! each item does its state mutation synchronously and defers any long await
//! (a permission prompt, a command's exit) to a spawned task. Awaiting handlers
//! inline meant an open permission prompt blocked EVERY message behind it: no
//! tool results, no text, no other session's work, and no way for a
//! cancellation to ever arrive (`$/cancel` is itself an inbound message). The
//! shape is: [`enqueue_request`]/[`enqueue_notification`] from the registered
//! closures, [`spawn_dispatch_queue`]'s drain running each handler's
//! synchronous phase in order, and `tokio::spawn` for the awaits (#28).
//!
//! Two rules hold throughout:
//!
//! - **Every request gets exactly one response.** An unknown session is an
//!   error response, not a dropped request — an agent blocked on a request we
//!   silently discarded hangs forever. On a normal close the drain still runs
//!   everything already buffered; `reject` exists for the enqueue that loses
//!   the race with the drain's death, so even that request gets an answer.
//! - **Cancellation is honoured.** Long-running requests (permission,
//!   `wait_for_exit`, `read_text_file`) race the responder's cancellation, and a
//!   cancelled permission prompt is taken down in the thread too, rather than
//!   left on screen asking about a turn that is over.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{JsonRpcResponse, Responder};
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AuthorizationKind, ElicitationStoreHandle, PermissionOptions,
    RequestPermissionOutcome, TerminalProviderEvent,
};
use atlas_terminal::command::{CommandTerminal, DEFAULT_OUTPUT_BYTE_LIMIT};

use crate::session::SessionRegistry;

/// Everything the handlers need. One clone per registered handler.
#[derive(Clone)]
pub struct ClientContext {
    pub sessions: Arc<SessionRegistry>,
    /// Request-scoped elicitations live here rather than on a thread, because
    /// they can arrive before any session exists — during authentication.
    pub request_elicitations: ElicitationStoreHandle,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ------------------------------------------------------------------- dispatch

/// One inbound message's handling, queued for the ordered drain.
///
/// The drain is a tokio task, and the deferred awaits go through
/// `tokio::spawn`.
pub trait DispatchWorkItem: Send {
    fn run(self: Box<Self>, ctx: &ClientContext);
    /// The queue is gone (connection closed). A request must still be
    /// answered — an agent blocked on a silently-dropped request hangs.
    fn reject(self: Box<Self>);
}

pub type DispatchWork = Box<dyn DispatchWorkItem>;

/// The sending half of a connection's dispatch queue.
pub type DispatchTx = tokio::sync::mpsc::Sender<DispatchWork>;

/// How many inbound messages may wait for the drain (#92). When the queue is
/// full, the closure enqueueing the next one waits — which stops the RPC
/// crate reading stdout, so an agent that floods the pipe is slowed to the
/// pace Atlas applies its messages at instead of growing memory without
/// bound. The drain never waits on anything but its own work, so a full queue
/// always empties.
pub const DISPATCH_QUEUE_CAPACITY: usize = 1024;

struct RequestWork<Req, Res>
where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    request: Req,
    responder: Responder<Res>,
    handler: fn(Req, Responder<Res>, &ClientContext),
}

impl<Req, Res> DispatchWorkItem for RequestWork<Req, Res>
where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    fn run(self: Box<Self>, ctx: &ClientContext) {
        let Self {
            request,
            responder,
            handler,
        } = *self;
        handler(request, responder, ctx);
    }

    fn reject(self: Box<Self>) {
        respond_err(self.responder, dispatch_queue_closed_error());
    }
}

struct NotificationWork<Notif>
where
    Notif: Send + 'static,
{
    notification: Notif,
    handler: fn(Notif, &ClientContext),
}

impl<Notif> DispatchWorkItem for NotificationWork<Notif>
where
    Notif: Send + 'static,
{
    fn run(self: Box<Self>, ctx: &ClientContext) {
        let Self {
            notification,
            handler,
        } = *self;
        handler(notification, ctx);
    }

    fn reject(self: Box<Self>) {
        tracing::warn!("ACP dispatch queue closed while a notification was queued");
    }
}

fn dispatch_queue_closed_error() -> acp::Error {
    acp::Error::internal_error().data("ACP dispatch queue closed")
}

/// Queue a request for the ordered drain.
///
/// Called from inside the RPC crate's serial inbound loop: whatever it does
/// happens before the NEXT message is parsed. It waits only while the queue
/// is full ([`DISPATCH_QUEUE_CAPACITY`]).
pub async fn enqueue_request<Req, Res>(
    dispatch_tx: &DispatchTx,
    request: Req,
    responder: Responder<Res>,
    handler: fn(Req, Responder<Res>, &ClientContext),
) where
    Req: Send + 'static,
    Res: JsonRpcResponse + Send + 'static,
{
    let work: DispatchWork = Box::new(RequestWork {
        request,
        responder,
        handler,
    });
    enqueue(dispatch_tx, work).await;
}

async fn enqueue(dispatch_tx: &DispatchTx, work: DispatchWork) {
    if let Err(err) = dispatch_tx.send(work).await {
        err.0.reject();
    }
}

pub async fn enqueue_notification<Notif>(
    dispatch_tx: &DispatchTx,
    notification: Notif,
    handler: fn(Notif, &ClientContext),
) where
    Notif: Send + 'static,
{
    let work: DispatchWork = Box::new(NotificationWork {
        notification,
        handler,
    });
    enqueue(dispatch_tx, work).await;
}

struct BarrierWork<F: FnOnce(Option<&ClientContext>) + Send + 'static> {
    then: F,
}

impl<F: FnOnce(Option<&ClientContext>) + Send + 'static> DispatchWorkItem for BarrierWork<F> {
    fn run(self: Box<Self>, ctx: &ClientContext) {
        (self.then)(Some(ctx));
    }

    fn reject(self: Box<Self>) {
        // Nothing left to wait behind: the queue is gone.
        (self.then)(None);
    }
}

/// Run `then` on the drain once every message queued before it has been
/// handled: the end of a `session/load` replay is ordered behind the replay's
/// own frames this way. Runs at once if the queue is gone.
pub async fn enqueue_barrier(dispatch_tx: &DispatchTx, then: impl FnOnce() + Send + 'static) {
    enqueue_on_drain(dispatch_tx, move |_ctx| then()).await;
}

/// [`enqueue_barrier`], handed the drain's context — `None` when the queue is
/// gone and `then` runs at once instead.
pub async fn enqueue_on_drain(
    dispatch_tx: &DispatchTx,
    then: impl FnOnce(Option<&ClientContext>) + Send + 'static,
) {
    let work: DispatchWork = Box::new(BarrierWork { then });
    enqueue(dispatch_tx, work).await;
}

/// Start one connection's ordered drain and hand back its sender.
///
/// The drain runs each work item's SYNCHRONOUS phase to completion, in wire
/// order — that is the whole guarantee. A handler that must wait (for the
/// user's permission answer, for a command to exit) spawns that wait and
/// returns, so the queue keeps moving. The task ends when the last sender is
/// dropped, which happens when the connection's handler closures are dropped.
pub fn spawn_dispatch_queue(ctx: ClientContext) -> DispatchTx {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<DispatchWork>(DISPATCH_QUEUE_CAPACITY);
    tokio::spawn(async move {
        while let Some(work) = rx.recv().await {
            // A panicking handler must not take the drain down with it: the
            // connection would look alive while every later request got
            // "queue closed" and every update was dropped. A tokio task
            // dying silently is a lobotomy, so the panic is contained and the
            // queue keeps draining.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                work.run(&ctx);
            }));
            if let Err(panic) = outcome {
                tracing::error!("ACP dispatch handler panicked: {panic:?}");
            }
        }
    });
    tx
}

fn respond_err<T: JsonRpcResponse>(responder: Responder<T>, err: acp::Error) {
    // Log what we actually returned. Without this an agent hitting an error
    // path sees only the generic wire error and the client side has no trace of
    // why.
    tracing::warn!(
        method = responder.method(),
        "responding to ACP request with error: {err:?}"
    );
    let _ = responder.respond_with_error(err);
}

fn respond_result<T: JsonRpcResponse>(responder: Responder<T>, result: Result<T, acp::Error>) {
    match result {
        Ok(response) => {
            let _ = responder.respond(response);
        }
        Err(err) => respond_err(responder, err),
    }
}

// ------------------------------------------------------------------ permission

pub fn handle_request_permission(
    args: acp::RequestPermissionRequest,
    responder: Responder<acp::RequestPermissionResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
    let tool_call_id = args.tool_call.tool_call_id.clone();
    let session_id = args.session_id.clone();
    let sessions = ctx.sessions.clone();

    // The registration is the synchronous phase: once this returns, the prompt
    // exists and the drain can move on to whatever the agent said next.
    let (waiter, grant) = {
        let mut thread = lock(&thread);
        // No turn running: this request crossed the user's Stop on the wire
        // (Stop clears the turn, then sends `session/cancel`), or came after
        // the agent had already answered its prompt. Nobody is waiting on it,
        // and raising it would pin a prompt for a turn that is over, answered
        // by whoever clicks it later. ACP: having cancelled the turn, the client
        // MUST answer every pending permission request `Cancelled` — so it is,
        // here, before anything shows. Checked under the same lock as the
        // registration, so a Stop cannot land between the two. A turn is
        // always open before its `session/prompt` goes out
        // (`AgentManager::send` calls `begin_turn` first), so no request the
        // turn could raise arrives ahead of it.
        if !thread.is_generating() {
            drop(thread);
            let _ = responder.respond(acp::RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled.into(),
            ));
            return;
        }
        // An execute call the user allows here is one Atlas need not ask
        // about again when the agent runs it through `terminal/create` (#28).
        // The kind is the request's own, else what the thread already knows
        // of the call.
        let executes = args.tool_call.fields.kind == Some(acp::ToolKind::Execute)
            || (args.tool_call.fields.kind.is_none()
                && thread.entries().iter().any(|entry| {
                    matches!(entry, atlas_acp_thread::AgentThreadEntry::ToolCall(call)
                        if call.id == tool_call_id && call.kind == acp::ToolKind::Execute)
                }));
        let grant = thread.active_turn().filter(|_| executes);
        let waiter = thread.request_tool_call_authorization(
            args.tool_call,
            PermissionOptions::Flat(args.options),
            AuthorizationKind::PermissionGrant,
        );
        (waiter, grant)
    };
    let waiter = match waiter {
        Ok(waiter) => waiter,
        Err(err) => return respond_err(responder, err),
    };

    // The prompt can be open for as long as the user takes to answer — that
    // wait must not hold the dispatch queue.
    tokio::spawn(async move {
        match cancellation
            .run_until_cancelled(async { Ok(waiter.await) })
            .await
        {
            Ok(outcome) => {
                if let Some(turn) = grant.filter(|_| outcome_allows(&outcome)) {
                    sessions.grant_execution(&session_id, turn, tool_call_id);
                }
                let _ = responder.respond(acp::RequestPermissionResponse::new(outcome.into()));
            }
            Err(err) => {
                // The agent gave up on the turn; take the prompt down rather
                // than leaving the user staring at a question nobody is
                // waiting on.
                if err.code == acp::ErrorCode::RequestCancelled {
                    lock(&thread).cancel_tool_call_authorization(&tool_call_id);
                }
                respond_err(responder, err)
            }
        }
    });
}

// ---------------------------------------------------------------- elicitation

pub fn handle_create_elicitation(
    args: acp::CreateElicitationRequest,
    responder: Responder<acp::CreateElicitationResponse>,
    ctx: &ClientContext,
) {
    // Session-scoped elicitations belong in that session's timeline;
    // request-scoped ones can predate every session, so they live on the
    // connection.
    let waiter = match args.scope() {
        acp::ElicitationScope::Session(scope) => {
            let session_id = scope.session_id.clone();
            let thread = match ctx.sessions.thread(&session_id) {
                Ok(thread) => thread,
                Err(err) => return respond_err(responder, err),
            };
            let result = lock(&thread).request_elicitation(args);
            match result {
                Ok((_id, waiter)) => Box::pin(waiter)
                    as std::pin::Pin<Box<dyn std::future::Future<Output = _> + Send>>,
                Err(err) => return respond_err(responder, err),
            }
        }
        _ => {
            let result = lock(&ctx.request_elicitations).request_elicitation(args);
            match result {
                Ok((_id, waiter)) => Box::pin(waiter)
                    as std::pin::Pin<Box<dyn std::future::Future<Output = _> + Send>>,
                Err(err) => return respond_err(responder, err),
            }
        }
    };

    // Registered above (the synchronous phase); the wait for the user's answer
    // is deferred so the queue keeps draining.
    let cancellation = responder.cancellation();
    tokio::spawn(async move {
        match cancellation
            .run_until_cancelled(async { Ok(waiter.await) })
            .await
        {
            Ok(response) => {
                let _ = responder.respond(response);
            }
            Err(err) => respond_err(responder, err),
        }
    });
}

/// The agent telling us a URL elicitation finished out of band (the user
/// completed a device-code login in their browser).
///
/// Broadcast to every thread and to the connection store, because the id space
/// is the agent's and we do not know which one owns it.
pub fn handle_complete_elicitation(
    args: acp::CompleteElicitationNotification,
    ctx: &ClientContext,
) {
    let elicitation_id = args.elicitation_id;
    for thread in ctx.sessions.all_threads() {
        lock(&thread).complete_url_elicitation(&elicitation_id);
    }
    lock(&ctx.request_elicitations).complete_url_elicitation(&elicitation_id);
}

// ------------------------------------------------------------------------- fs
//
// Served from disk, not from editor buffers — see the divergence note in
// `atlas_acp_thread`'s module docs. An agent reading a file the user has
// modified but not saved sees the on-disk version.
//
// Bound to the session's granted directories (`AcpThread::work_dirs` — cwd
// plus any `additionalDirectories`), the same set advertised to the agent in
// `session/new` — widened by the projects attached to the session at their
// access: reads may reach every attached project, writes only the read-write
// ones (`AcpThread::readable_roots` / `writable_roots`). Without this an agent that merely knows a session id can
// hand back an absolute path or a `../` climb and read or overwrite anything
// the OS user can touch, not just the project the user granted.

pub fn handle_write_text_file(
    args: acp::WriteTextFileRequest,
    responder: Responder<acp::WriteTextFileResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };
    // The session's own folders and its read-write attached projects; a
    // read-only attached project is never written through here.
    let roots = lock(&thread).writable_roots();

    // Disk IO off the queue: a write to a slow volume must not stall the
    // messages behind it.
    tokio::spawn(async move {
        let path = args.path.clone();
        let result =
            tokio::task::spawn_blocking(move || write_text_file(&path, &args.content, &roots))
                .await
                .unwrap_or_else(|err| Err(anyhow::anyhow!("write task panicked: {err}")));

        match result {
            Ok(()) => {
                let _ = responder.respond(acp::WriteTextFileResponse::default());
            }
            Err(err) => respond_err(
                responder,
                acp::Error::internal_error().data(err.to_string()),
            ),
        }
    });
}

fn write_text_file(path: &Path, content: &str, roots: &[PathBuf]) -> anyhow::Result<()> {
    let path = resolve_within_roots(path, roots)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    Ok(())
}

pub fn handle_read_text_file(
    args: acp::ReadTextFileRequest,
    responder: Responder<acp::ReadTextFileResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };
    // The session's own folders and every attached project, read-only ones
    // included.
    let roots = lock(&thread).readable_roots();

    let cancellation = responder.cancellation();
    let path = args.path.clone();
    let (line, limit) = (args.line, args.limit);

    tokio::spawn(async move {
        let result = cancellation
            .run_until_cancelled(async move {
                tokio::task::spawn_blocking(move || read_text_file(&path, line, limit, &roots))
                    .await
                    .unwrap_or_else(|err| Err(anyhow::anyhow!("read task panicked: {err}")))
                    .map_err(|err| acp::Error::internal_error().data(err.to_string()))
            })
            .await;

        respond_result(responder, result.map(acp::ReadTextFileResponse::new));
    });
}

/// The most a single `fs/read_text_file` hands back: a whole-file read of
/// anything bigger is refused with a pointer to `line`/`limit`, and a window
/// stops here. The whole answer is one JSON-RPC message, copied several times
/// on its way (serialised, logged by the debug tap, parsed by the agent), so a
/// multi-gigabyte log asked for whole cost Atlas several times its size.
const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

/// `line` is 1-based and `limit` counts lines, matching the ACP field docs.
fn read_text_file(
    path: &Path,
    line: Option<u32>,
    limit: Option<u32>,
    roots: &[PathBuf],
) -> anyhow::Result<String> {
    let path = resolve_within_roots(path, roots)?;
    // What the path is, before it is opened: opening a FIFO blocks until a
    // writer appears, which parked a blocking-pool thread for good (cancelling
    // the request drops the future, not the read), and a device never ends.
    // Only a regular file is a text file to read (#90).
    let meta = std::fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(std::io::Error::from(std::io::ErrorKind::IsADirectory).into());
    }
    if !meta.is_file() {
        anyhow::bail!("{} is not a regular file", path.display());
    }
    if line.is_none() && limit.is_none() {
        if meta.len() > MAX_READ_BYTES {
            anyhow::bail!(
                "{} is {} MB, more than the {} MB one read returns; read it in parts with `line` and `limit`",
                path.display(),
                meta.len() / (1024 * 1024),
                MAX_READ_BYTES / (1024 * 1024),
            );
        }
        return Ok(std::fs::read_to_string(&path)?);
    }

    // Stream when a window was asked for. `read_to_string` first would load the
    // whole file to hand back one line of it — and `line`/`limit` exist
    // precisely so a client does not have to do that. It also decided the
    // encoding of the whole file: a byte the caller never asked for could fail
    // a read of a range that is perfectly good text.
    let skip = line.unwrap_or(1).saturating_sub(1) as usize;
    let take = limit.map(|limit| limit as usize).unwrap_or(usize::MAX);

    // The lines' own bytes, endings included. Splitting into lines and joining
    // them with "\n" turned CRLF into LF and dropped the last newline, so a
    // window and a whole read of the same lines disagreed, and an edit built
    // from one failed to match the other (#32).
    let mut reader = std::io::BufReader::new(std::fs::File::open(&path)?);
    let mut selected = Vec::new();
    let mut line_bytes = Vec::new();
    let (mut seen, mut taken) = (0usize, 0usize);
    while taken < take {
        line_bytes.clear();
        if std::io::BufRead::read_until(&mut reader, b'\n', &mut line_bytes)? == 0 {
            break;
        }
        if seen >= skip {
            if (selected.len() + line_bytes.len()) as u64 > MAX_READ_BYTES {
                anyhow::bail!(
                    "the lines asked for are more than the {} MB one read returns; ask for fewer",
                    MAX_READ_BYTES / (1024 * 1024),
                );
            }
            selected.extend_from_slice(&line_bytes);
            taken += 1;
        }
        seen += 1;
    }
    String::from_utf8(selected).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        )
        .into()
    })
}

/// Reject a path outside every root in `roots`, before it ever reaches
/// `std::fs`. `path` may not exist yet (a write's target), so `.`/`..` are
/// resolved lexically first and then the deepest part of the result that *does*
/// exist is canonicalized — see [`canonicalize_deepest_ancestor`].
///
/// That two-step is what makes the check hold against symlinks: a link planted
/// inside a granted root that points back out is followed while resolving the
/// ancestor, so the comparison sees where the path really lands rather than
/// where it appears to. The planted-symlink test below pins it.
///
/// A root that cannot be canonicalized grants nothing. It is the only
/// fail-closed choice available: the alternative is comparing a canonical
/// target against a non-canonical root, which is a different namespace and
/// therefore not a comparison at all.
fn resolve_within_roots(path: &Path, roots: &[PathBuf]) -> anyhow::Result<PathBuf> {
    // ONE namespace for both sides. The first version compared a lexically
    // normalized target against canonicalized roots — two namespaces, papered
    // over with an `|| starts_with(raw_root)` that made the check asymmetric
    // on symlinked paths (macOS: /tmp vs /private/tmp resolved differently
    // depending on which form the agent happened to send) and blind to a
    // symlink planted INSIDE a root pointing out. Canonicalizing the deepest
    // existing ancestor of the target — following any symlink already on
    // disk — and re-joining the not-yet-existing tail closes both.
    let resolved = canonicalize_deepest_ancestor(&normalize_lexically(path))?;
    for root in roots {
        // A root that is gone grants nothing. Falling back to a lexical form
        // here would compare a canonical target against a non-canonical root —
        // two namespaces again, which is the bug this function already carries
        // a note about.
        let Ok(canon_root) = root.canonicalize() else {
            tracing::warn!(
                root = %root.display(),
                "granted directory cannot be resolved; refusing paths under it"
            );
            continue;
        };
        if resolved.starts_with(&canon_root) {
            return Ok(resolved);
        }
    }
    anyhow::bail!(
        "path {} is outside this session's granted directories",
        path.display()
    )
}

/// Canonicalize the longest prefix of `path` that exists on disk (following
/// symlinks), then re-append the remaining components untouched. For a path
/// that exists in full this IS `canonicalize`; for a write's target it
/// resolves everything up to the missing leaf — which is exactly the part a
/// planted symlink could bend.
fn canonicalize_deepest_ancestor(path: &Path) -> anyhow::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(canon) => {
                let mut out = canon;
                for part in tail.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(error) => {
                // A dangling link is an existing object, not a missing tail.
                // Never append it unchecked and let open(O_CREAT) follow it.
                if std::fs::symlink_metadata(&existing).is_ok() {
                    return Err(error.into());
                }
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.into());
                }
                match (existing.file_name(), existing.parent()) {
                    (Some(name), Some(parent)) => {
                        tail.push(name.to_os_string());
                        existing = parent.to_path_buf();
                    }
                    // Ran out of parents without anything existing — nothing to
                    // resolve; the lexical form is all there is.
                    _ => return Err(error.into()),
                }
            }
        }
    }
}

/// Resolve `.`/`..` components without touching the filesystem. Not a
/// substitute for `canonicalize` on a path that already exists (it does not
/// follow symlinks), only for the case `canonicalize` cannot handle here: a
/// write's target, which may not exist yet.
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod fs_bound_tests {
    use super::*;

    /// A fresh, real directory per test (`resolve_within_roots` canonicalizes
    /// roots, which requires them to exist) — unique per call so parallel
    /// `cargo test` runs never collide.
    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "atlas-fs-bound-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create test root");
        root
    }

    #[test]
    fn normalize_lexically_resolves_dot_dot_without_touching_disk() {
        // Neither `/a/b/../c` nor `/a/c` need to exist on disk — this must not
        // shell out to `canonicalize`, which is exactly why a write's
        // not-yet-existing target can still be checked.
        assert_eq!(
            normalize_lexically(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn a_path_inside_the_granted_root_resolves() {
        let root = test_root();
        let target = root.join("notes.md");
        // The resolver answers in CANONICAL form now (temp dirs on macOS are
        // symlinks — /var/folders → /private/var/folders), so compare against
        // the canonical expectation rather than the raw input.
        let expected = root.canonicalize().unwrap().join("notes.md");
        assert_eq!(
            resolve_within_roots(&target, std::slice::from_ref(&root)).expect("inside the root"),
            expected
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The asymmetry regression: a root stored canonically with a target
    /// handed back in symlinked form (or vice versa) must BOTH resolve — the
    /// old two-namespace compare accepted one direction and refused the other.
    #[test]
    fn symlinked_roots_resolve_in_both_directions() {
        let raw = test_root();
        let canon = raw.canonicalize().unwrap();
        let expected = canon.join("a.md");
        assert_eq!(
            resolve_within_roots(&canon.join("a.md"), std::slice::from_ref(&raw))
                .expect("raw root"),
            expected
        );
        assert_eq!(
            resolve_within_roots(&raw.join("a.md"), &[canon]).expect("canon root"),
            expected
        );
        let _ = std::fs::remove_dir_all(&raw);
    }

    /// A symlink planted INSIDE a granted root pointing out must not carry a
    /// write with it — the deepest-existing-ancestor canonicalization follows
    /// it and the escape shows up in the compare.
    #[test]
    fn a_planted_symlink_does_not_smuggle_a_write_out() {
        let root = test_root();
        let outside = test_root();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("exit")).expect("plant symlink");
            assert!(
                resolve_within_roots(&root.join("exit/escape.md"), std::slice::from_ref(&root))
                    .is_err(),
                "write through a planted symlink resolved inside the root"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_or_cyclic_symlink_is_not_a_missing_write_target() {
        let root = test_root();
        let outside = test_root();
        std::os::unix::fs::symlink(outside.join("missing.txt"), root.join("file")).unwrap();
        std::os::unix::fs::symlink(outside.join("missing-dir"), root.join("directory")).unwrap();
        std::os::unix::fs::symlink("cycle", root.join("cycle")).unwrap();
        for path in ["file", "directory/new.txt", "cycle/new.txt"] {
            assert!(
                resolve_within_roots(&root.join(path), std::slice::from_ref(&root)).is_err(),
                "accepted {path}"
            );
        }
        assert!(!outside.join("missing.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn a_dot_dot_climb_out_of_the_root_is_rejected() {
        let root = test_root();
        let escape = root.join("../../../../etc/passwd");
        let err = resolve_within_roots(&escape, std::slice::from_ref(&root))
            .expect_err("outside every root");
        assert!(err
            .to_string()
            .contains("outside this session's granted directories"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unrelated_absolute_path_is_rejected() {
        let root = test_root();
        let err = resolve_within_roots(Path::new("/etc/passwd"), std::slice::from_ref(&root))
            .expect_err("outside every root");
        assert!(err
            .to_string()
            .contains("outside this session's granted directories"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_under_any_granted_directory_resolves() {
        // Granted directories are cwd plus `additionalDirectories`.
        let cwd = test_root();
        let extra_dir = test_root();
        let target = extra_dir.join("readme.txt");
        let expected = extra_dir.canonicalize().unwrap().join("readme.txt");
        assert_eq!(
            resolve_within_roots(&target, &[cwd.clone(), extra_dir.clone()])
                .expect("inside the second granted directory"),
            expected
        );
        let _ = std::fs::remove_dir_all(&cwd);
        let _ = std::fs::remove_dir_all(&extra_dir);
    }

    /// ATL-236. The old body ran `read_to_string` before looking at `line` or
    /// `limit`, so a windowed read paid for the whole file.
    ///
    /// Proven by encoding rather than by size, because a size test can only
    /// ever be slow and suggestive: bytes that are not UTF-8 sit *after* the
    /// requested line, so a whole-file read cannot succeed and a streaming
    /// read cannot fail. It is the same defect, made deterministic.
    #[test]
    fn a_windowed_read_does_not_pay_for_the_rest_of_the_file() {
        let root = test_root();
        let path = root.join("mixed.log");

        let mut bytes = b"the line that was asked for\n".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe, 0x00]);
        bytes.push(b'\n');
        std::fs::write(&path, &bytes).expect("write fixture");

        assert!(
            std::fs::read_to_string(&path).is_err(),
            "fixture is pointless unless a whole-file read of it fails"
        );

        let out = read_text_file(&path, Some(1), Some(1), std::slice::from_ref(&root))
            .expect("a windowed read must not decode past its window");
        assert_eq!(out, "the line that was asked for\n");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The window itself still has to be right — a streaming rewrite is only
    /// worth anything if `line` stays 1-based and `limit` still counts lines.
    #[test]
    fn line_is_one_based_and_limit_counts_lines() {
        let root = test_root();
        let path = root.join("numbers.txt");
        std::fs::write(&path, "one\ntwo\nthree\nfour\nfive\n").expect("write fixture");
        let roots = std::slice::from_ref(&root);

        assert_eq!(
            read_text_file(&path, None, None, roots).expect("whole file"),
            "one\ntwo\nthree\nfour\nfive\n",
            "an unwindowed read is byte-for-byte, trailing newline included"
        );
        assert_eq!(
            read_text_file(&path, Some(2), Some(2), roots).expect("window"),
            "two\nthree\n"
        );
        assert_eq!(
            read_text_file(&path, Some(1), None, roots).expect("from the top"),
            "one\ntwo\nthree\nfour\nfive\n"
        );
        assert_eq!(
            read_text_file(&path, None, Some(1), roots).expect("first line only"),
            "one\n"
        );
        assert_eq!(
            read_text_file(&path, Some(99), Some(3), roots).expect("past the end"),
            "",
            "a window past the end is empty, not an error"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A window is the lines' own bytes: a CRLF file read in parts reads the
    /// same as read whole, so an edit built from one matches the other (#32).
    #[test]
    fn a_window_keeps_the_lines_own_endings() {
        let root = test_root();
        let path = root.join("crlf.txt");
        std::fs::write(&path, "one\r\ntwo\r\nthree").expect("write fixture");
        let roots = std::slice::from_ref(&root);

        assert_eq!(
            read_text_file(&path, Some(1), Some(2), roots).expect("window"),
            "one\r\ntwo\r\n"
        );
        assert_eq!(
            read_text_file(&path, Some(3), Some(1), roots).expect("last, unterminated"),
            "three"
        );
        let whole = read_text_file(&path, None, None, roots).expect("whole");
        let parts = read_text_file(&path, Some(1), None, roots).expect("from the top");
        assert_eq!(whole, parts);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Only a regular file is read, and a whole read has a ceiling (#90). A
    /// FIFO is the sharp case: opening one blocks until a writer appears, so
    /// it must be refused before anything opens it — this test would hang,
    /// not fail, if it were not.
    #[cfg(unix)]
    #[test]
    fn a_read_is_of_a_regular_file_of_bounded_size() {
        let root = test_root();
        let roots = std::slice::from_ref(&root);
        let fifo = root.join("pipe");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("run mkfifo");
        assert!(made.success(), "mkfifo failed");
        for (line, limit) in [(None, None), (Some(1), Some(1))] {
            let err = read_text_file(&fifo, line, limit, roots).expect_err("a FIFO is not read");
            assert!(err.to_string().contains("not a regular file"), "{err}");
        }

        let big = root.join("big.log");
        let file = std::fs::File::create(&big).expect("create");
        // Sparse: as long as the ceiling without writing it.
        file.set_len(MAX_READ_BYTES + 1).expect("grow");
        let err = read_text_file(&big, None, None, roots).expect_err("too big to read whole");
        assert!(err.to_string().contains("`line` and `limit`"), "{err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A granted directory that no longer exists cannot be compared against,
    /// so it grants nothing. The alternative — comparing a canonical target
    /// against a lexical root — is the two-namespace bug this function was
    /// already fixed for once.
    #[test]
    fn a_root_that_cannot_be_resolved_grants_nothing() {
        // Canonical on purpose. `temp_dir()` is a symlink on macOS
        // (`/var/…` → `/private/var/…`), and under a symlinked root the old
        // lexical fallback happened to reject anyway — so this test passed
        // against the very code it was written to rule out. The difference is
        // only observable when the root is already in the canonical namespace.
        let root = test_root().canonicalize().expect("canonicalize the root");
        let target = root.join("file.txt");
        assert!(
            resolve_within_roots(&target, std::slice::from_ref(&root)).is_ok(),
            "sanity: the root grants while it exists"
        );

        std::fs::remove_dir_all(&root).expect("remove the root");
        assert!(
            resolve_within_roots(&target, std::slice::from_ref(&root)).is_err(),
            "a vanished root must not still grant paths under it"
        );
    }

    /// A zero-length window pulls nothing from the iterator, so an error that
    /// only surfaces on read — a directory — would never be raised. The old
    /// whole-file read failed first and got this right by accident; the
    /// streaming version has to mean it.
    #[test]
    fn an_unreadable_path_is_an_error_even_for_an_empty_window() {
        let root = test_root();
        let dir = root.join("a-directory");
        std::fs::create_dir_all(&dir).expect("create the directory");
        let roots = std::slice::from_ref(&root);

        for (line, limit) in [
            (None, Some(0)),
            (Some(1), Some(0)),
            (None, None),
            (Some(1), None),
        ] {
            assert!(
                read_text_file(&dir, line, limit, roots).is_err(),
                "reading a directory answered successfully for line={line:?} limit={limit:?}"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// #29's decision table: a command runs in a directory that exists inside
    /// the session's folders — the session's own when none is named — or the
    /// agent is told why not. `$HOME` is never the answer.
    #[test]
    fn a_terminal_cwd_is_an_existing_directory_inside_the_roots() {
        let root = test_root();
        let canon = root.canonicalize().expect("canonicalize the root");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).expect("create a subdirectory");
        let file = root.join("file.txt");
        std::fs::write(&file, "not a directory\n").expect("write fixture");
        let outside = test_root();
        let roots = std::slice::from_ref(&root);
        let invalid = |err: acp::Error| err.code == acp::ErrorCode::InvalidParams;

        assert_eq!(
            terminal_cwd(None, Some(&root), roots).expect("the session's folder"),
            canon
        );
        assert_eq!(
            terminal_cwd(Some(&sub), Some(&root), roots).expect("a folder inside it"),
            canon.join("sub")
        );
        assert!(invalid(
            terminal_cwd(Some(Path::new("sub")), Some(&root), roots).expect_err("relative")
        ));
        assert!(invalid(
            terminal_cwd(Some(&root.join("missing")), Some(&root), roots).expect_err("missing")
        ));
        assert!(invalid(
            terminal_cwd(Some(&file), Some(&root), roots).expect_err("a file")
        ));
        assert!(terminal_cwd(Some(&outside), Some(&root), roots).is_err());
        assert!(terminal_cwd(None, None, roots).is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The containment check has to run before the file is opened, not after.
    #[test]
    fn a_read_outside_the_roots_is_refused() {
        let root = test_root();
        let outside = test_root();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "not yours\n").expect("write fixture");

        let err = read_text_file(&secret, Some(1), Some(1), std::slice::from_ref(&root))
            .expect_err("a read outside every granted directory must be refused");
        assert!(
            err.to_string().contains("outside this session's granted"),
            "unexpected refusal reason: {err}"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}

// ------------------------------------------------------------- session/update

pub fn handle_session_notification(notification: acp::SessionNotification, ctx: &ClientContext) {
    let Ok(thread) = ctx.sessions.thread(&notification.session_id) else {
        // A session Atlas does not know yet may be the one a `session/new`
        // in flight is about to answer with: an agent may announce its
        // commands before it answers. Kept until that answer is registered,
        // and applied then, in order (#12).
        let session_id = notification.session_id.clone();
        if !ctx.sessions.park_update(notification) {
            // Not an error to answer — notifications have no response — but
            // worth saying, because it means an update was dropped.
            tracing::warn!("received session notification for unknown session: {session_id:?}");
        }
        return;
    };

    // Mode and config-option updates are also mirrored onto the session so a
    // later snapshot read agrees with what the agent just told us.
    match &notification.update {
        acp::SessionUpdate::CurrentModeUpdate(update) => {
            let mode_id = update.current_mode_id.clone();
            ctx.sessions
                .with_session(&notification.session_id, |session| {
                    if let Some(modes) = &session.session_modes {
                        lock(modes).current_mode_id = mode_id;
                    }
                });
        }
        acp::SessionUpdate::ConfigOptionUpdate(update) => {
            let options = update.config_options.clone();
            ctx.sessions
                .with_session(&notification.session_id, |session| {
                    // An agent whose modes live in a `category: "mode"` select
                    // (OpenCode — see `session_modes_of`) reports a mode change
                    // here, not as `current_mode_update`, and a change to the
                    // LIST of modes too: that select is the whole of its mode
                    // state, so it replaces the session's, list and current
                    // alike (#43).
                    let from_config = session
                        .modes_from_config
                        .as_ref()
                        .and_then(|id| crate::connection::mode_select_by_id(&options, id));
                    if let (Some(modes), Some(select)) = (&session.session_modes, from_config) {
                        *lock(modes) = select;
                    } else if let (Some(modes), Some(select), None) = (
                        &session.session_modes,
                        crate::connection::mode_select_of(&options),
                        &session.modes_from_config,
                    ) {
                        // An agent with its own `modes` wire that also sends
                        // a mode select: mirror the current mode, but only to
                        // a mode that state knows — its `modes` wire stays
                        // authoritative for what is selectable.
                        let mut modes = lock(modes);
                        if modes
                            .available_modes
                            .iter()
                            .any(|mode| mode.id == select.current_mode_id)
                        {
                            modes.current_mode_id = select.current_mode_id;
                        }
                    }
                    if session.session_modes.is_none() {
                        if let Some((config_id, modes)) =
                            crate::connection::mode_select_with_id(&options)
                        {
                            session.session_modes = Some(Arc::new(Mutex::new(modes)));
                            session.modes_from_config = Some(config_id);
                        }
                    }
                    // Options first announced after the session opened are
                    // stored all the same: an agent need not send any with
                    // `session/new` (#37).
                    match &session.config_options {
                        Some(config) => {
                            *lock(&config.config_options) = options;
                            config.notify();
                        }
                        None => {
                            session.config_options = Some(crate::session::ConfigOptions::new(
                                Arc::new(Mutex::new(options)),
                            ));
                        }
                    }
                });
        }
        _ => {}
    }

    // Pre-handle: a `ToolCall` whose meta carries `terminal_info` announces a
    // terminal the AGENT is running itself. Registered before the update is
    // applied, so the call's own `Terminal` content resolves on first render.
    // Gated purely on the meta key — the same key we advertise in
    // `client_capabilities_for_agent`. The order is a nicety, not
    // load-bearing: the registry parks
    // out-of-order events and unknown terminal references, so no test pins it.
    if let acp::SessionUpdate::ToolCall(tool_call) = &notification.update {
        if let Some(info) = tool_call
            .meta
            .as_ref()
            .and_then(|meta| meta.get("terminal_info"))
        {
            if let Some(terminal_id) = info.get("terminal_id").and_then(|v| v.as_str()) {
                let cwd = info.get("cwd").and_then(|v| v.as_str()).map(PathBuf::from);
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Created {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    label: tool_call.title.clone(),
                    cwd,
                    output_byte_limit: None,
                    terminal: None,
                });
            }
        }
    }

    let applied = lock(&thread).handle_session_update(notification.update.clone());
    if let Err(err) = applied {
        tracing::warn!("failed to apply session update: {err:?}");
    }

    // Post-handle: `terminal_output` / `terminal_exit` on a `ToolCallUpdate`'s
    // meta stream into that terminal. After the update, so a first update that
    // both names the call and carries output renders the call before the
    // output lands. Out-of-order arrivals park in the registry's side-tables,
    // exactly as for client-created terminals.
    if let acp::SessionUpdate::ToolCallUpdate(update) = &notification.update {
        let meta = update.meta.as_ref();
        if let Some(output) = meta.and_then(|meta| meta.get("terminal_output")) {
            if let (Some(terminal_id), Some(data)) = (
                output.get("terminal_id").and_then(|v| v.as_str()),
                output.get("data").and_then(|v| v.as_str()),
            ) {
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Output {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    data: data.as_bytes().to_vec(),
                });
            }
        }
        if let Some(exit) = meta.and_then(|meta| meta.get("terminal_exit")) {
            if let Some(terminal_id) = exit.get("terminal_id").and_then(|v| v.as_str()) {
                let mut status = acp::TerminalExitStatus::new();
                status.exit_code = exit
                    .get("exit_code")
                    .and_then(serde_json::Value::as_u64)
                    .map(|c| c as u32);
                status.signal = exit
                    .get("signal")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Exit {
                    terminal_id: acp::TerminalId::new(terminal_id),
                    status,
                });
            }
        }
    }
}

// ------------------------------------------------------------------- terminal

/// Does a permission outcome authorize the action? Only an explicit Allow
/// selection does — Cancelled, InterruptedByFollowUp, and every Reject kind
/// answer no. Split out so the gate's decision table is testable without a
/// live prompt.
fn outcome_allows(outcome: &RequestPermissionOutcome) -> bool {
    matches!(
        outcome,
        RequestPermissionOutcome::Selected(sel)
            if matches!(
                sel.option_kind,
                acp::PermissionOptionKind::AllowOnce | acp::PermissionOptionKind::AllowAlways
            )
    )
}

/// Environment variables an agent may NOT hand to a spawned process: each is
/// a code-injection lever into the child (and anything it execs) that the
/// permission prompt cannot render meaningfully — the user approves a command
/// line, not a preload.
fn env_is_denied(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("DYLD_")
        || name.starts_with("LD_")
        || matches!(
            name.as_str(),
            "BASH_ENV"
                | "ENV"
                | "NODE_OPTIONS"
                | "NODE_PATH"
                | "PYTHONSTARTUP"
                | "PYTHONPATH"
                | "PERL5OPT"
                | "PERL5LIB"
                | "RUBYOPT"
                | "RUBYLIB"
                | "GIT_SSH_COMMAND"
                | "GIT_EXTERNAL_DIFF"
        )
}

/// Where a `terminal/create` runs: the directory the agent named, or the
/// session's own folder when it named none (#29).
///
/// Never `$HOME`, which is where portable-pty starts a command it is given no
/// directory for, or a directory that does not exist — so leaving `cwd` out,
/// or naming a folder that is not there, ran the command in the user's home,
/// outside everything the session was granted. A relative path is refused
/// too: ACP says `cwd` "must be an absolute path", and one that is not would
/// resolve against Atlas's own working directory, which means nothing to the
/// agent. Those are the agent's mistakes, so they are answered as invalid
/// params.
///
/// Returns the directory in the resolved form [`resolve_within_roots`]
/// compared, so the command starts in the directory that was checked rather
/// than wherever a symlink points by the time it spawns.
fn terminal_cwd(
    requested: Option<&Path>,
    session_cwd: Option<&Path>,
    roots: &[PathBuf],
) -> Result<PathBuf, acp::Error> {
    let dir = match (requested, session_cwd) {
        (Some(dir), _) if !dir.is_absolute() => {
            return Err(acp::Error::invalid_params().data(format!(
                "terminal cwd must be an absolute path, got {}",
                dir.display()
            )))
        }
        (Some(dir), _) | (None, Some(dir)) => dir,
        (None, None) => {
            return Err(acp::Error::internal_error()
                .data("no terminal cwd given, and this session has no folder to run in"))
        }
    };
    let resolved = resolve_within_roots(dir, roots)
        .map_err(|err| acp::Error::internal_error().data(format!("terminal cwd refused: {err}")))?;
    if !resolved.is_dir() {
        return Err(acp::Error::invalid_params()
            .data(format!("terminal cwd {} is not a directory", dir.display())));
    }
    Ok(resolved)
}

pub fn handle_create_terminal(
    args: acp::CreateTerminalRequest,
    responder: Responder<acp::CreateTerminalResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let label = if args.args.is_empty() {
        args.command.clone()
    } else {
        format!("{} {}", args.command, args.args.join(" "))
    };
    // Preload-class variables are dropped, not errored: erroring would teach
    // agents to retry without them anyway, and the drop is the actual policy.
    let env: Vec<(String, String)> = args
        .env
        .into_iter()
        .filter(|env| !env_is_denied(&env.name))
        .map(|env| (env.name, env.value))
        .collect();
    // The agent's limit, but never past Atlas's own ceiling: the buffer is
    // held in memory for as long as the terminal lives (#92).
    let output_byte_limit = args
        .output_byte_limit
        .map(|limit| limit.min(MAX_OUTPUT_BYTE_LIMIT));
    let byte_limit = output_byte_limit.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);

    // The cwd is held to the same rule as fs reads/writes: inside a granted
    // root or nowhere. Without this, "run `git status` in /Users/x/.ssh" was
    // a legal request. Writable roots, not readable ones: a command can
    // write wherever it runs, so a read-only attached project is no place to
    // start one.
    let (roots, session_cwd) = {
        let thread = lock(&thread);
        (thread.writable_roots(), thread.work_dirs().first().cloned())
    };
    let cwd = match terminal_cwd(args.cwd.as_deref(), session_cwd.as_deref(), &roots) {
        Ok(cwd) => cwd,
        Err(err) => return respond_err(responder, err),
    };

    // The gate. `terminal/create` used to spawn with agent-chosen argv/env/
    // cwd and no question asked — which made the fs-handler path bind above
    // decorative, since an agent denied a write could simply shell one out.
    // The same authorization machinery every other permission uses carries
    // this prompt, so session modes (auto-allow etc.) behave identically.
    //
    // Unless the agent already asked: when the user allowed an execute call
    // through the agent's own `session/request_permission` in this turn,
    // that answer covers the command it runs, and a second "Run …?" for the
    // same action is only noise (#28, decided). ACP gives `terminal/create`
    // no tool call id, so the grant spent is the turn's oldest unspent one.
    let tool_call_id = acp::ToolCallId::new(format!("terminal-{}", uuid::Uuid::new_v4()));
    let mut fields = acp::ToolCallUpdateFields::default();
    fields.kind = Some(acp::ToolKind::Execute);
    fields.title = Some(if let Some(dir) = args.cwd.as_deref() {
        format!("Run `{label}` in {}", dir.display())
    } else {
        format!("Run `{label}`")
    });
    fields.raw_input = Some(
        serde_json::json!({"command": args.command, "args": args.args, "env": env, "cwd": cwd}),
    );
    let (waiter, turn) = {
        let mut thread_guard = lock(&thread);
        let Some(turn) = thread_guard.active_turn() else {
            return respond_err(responder, acp::Error::request_cancelled());
        };
        if ctx.sessions.spend_execution_grant(&args.session_id, turn) {
            (None, turn)
        } else {
            let waiter = thread_guard.request_tool_call_authorization(
                acp::ToolCallUpdate::new(tool_call_id.clone(), fields),
                PermissionOptions::Flat(vec![
                    acp::PermissionOption::new(
                        "allow_once",
                        "Allow once",
                        acp::PermissionOptionKind::AllowOnce,
                    ),
                    acp::PermissionOption::new(
                        "reject_once",
                        "Reject",
                        acp::PermissionOptionKind::RejectOnce,
                    ),
                ]),
                AuthorizationKind::PermissionGrant,
            );
            match waiter {
                Ok(waiter) => (Some(waiter), turn),
                Err(err) => return respond_err(responder, err),
            }
        }
    };

    let cancellation = responder.cancellation();
    let command = args.command.clone();
    let cmd_args = args.args;
    tokio::spawn(async move {
        if let Some(waiter) = waiter {
            let outcome = match cancellation
                .run_until_cancelled(async { Ok(waiter.await) })
                .await
            {
                Ok(outcome) => outcome,
                Err(err) => {
                    // The agent gave up on the turn — take the prompt down.
                    if err.code == acp::ErrorCode::RequestCancelled {
                        lock(&thread).cancel_tool_call_authorization(&tool_call_id);
                    }
                    respond_err(responder, err);
                    return;
                }
            };
            if !outcome_allows(&outcome) {
                respond_err(responder, user_declined());
                return;
            }
        }

        // The final turn check and process creation share the turn lock:
        // once Stop has retired that turn, this task cannot spawn on its behalf.
        // PTY/process creation is blocking and belongs on the blocking pool.
        let spawning_thread = thread.clone();
        let spawned = tokio::task::spawn_blocking(move || {
            let mut thread_guard = lock(&spawning_thread);
            if thread_guard.active_turn() != Some(turn) {
                return Err(acp::Error::request_cancelled());
            }
            let terminal = Arc::new(
                CommandTerminal::spawn(&command, &cmd_args, &env, Some(&cwd), byte_limit)
                    .map_err(|error| acp::Error::internal_error().data(error.to_string()))?,
            );
            let terminal_id = acp::TerminalId::new(uuid::Uuid::new_v4().to_string());
            thread_guard.on_terminal_provider_event(TerminalProviderEvent::Created {
                terminal_id: terminal_id.clone(),
                label,
                cwd: Some(cwd),
                output_byte_limit,
                terminal: Some(terminal.clone()),
            });
            Ok((terminal, terminal_id))
        })
        .await;
        let (terminal, terminal_id) = match spawned {
            Ok(Ok(spawned)) => spawned,
            Ok(Err(error)) => {
                respond_err(responder, error);
                return;
            }
            Err(error) => {
                respond_err(
                    responder,
                    acp::Error::internal_error().data(error.to_string()),
                );
                return;
            }
        };
        follow_terminal_output(thread, terminal, terminal_id.clone());

        let _ = responder.respond(acp::CreateTerminalResponse::new(terminal_id));
    });
}

/// Turn a running command's output into thread events for as long as it runs.
///
/// A terminal's output grows on the PTY reader thread; nothing about the thread
/// changes, so nothing re-projects the tool call that renders it, and the
/// output pane would show only what happened to be buffered when some unrelated
/// event last touched the entry.
///
/// Atlas has no inline terminal view that observes the terminal — output
/// reaches the UI only through the tool call's own projection — so the link
/// between the two is made here explicitly.
///
/// # What keeps this from leaking
///
/// The task holds the terminal STRONGLY — it has to read the buffer it is
/// reporting — and the thread only weakly, so a session that goes away does not
/// stay alive for its own terminal. It ends on any of three things, which
/// between them cover every way a terminal stops mattering:
///
/// - the command exits (checked before each park);
/// - the thread is gone (the upgrade fails, checked before parking again);
/// - the terminal is released or the session torn down, both of which kill the
///   command — which is an exit, so the first condition fires. Release kills
///   explicitly (`TerminalRegistry::release`), and its last report is what the
///   tool call keeps showing; teardown kills through `AcpTerminal`'s `Drop`,
///   which is the only thing covering an ABRUPT teardown — `close_session`
///   drops the thread handle without ever reaching this code.
pub fn follow_terminal_output(
    thread: AcpThreadHandle,
    terminal: Arc<CommandTerminal>,
    terminal_id: acp::TerminalId,
) {
    let thread = Arc::downgrade(&thread);
    tokio::spawn(async move {
        loop {
            // Nothing left to report to: stop before parking on a command whose
            // output no longer has a reader.
            let Some(alive) = thread.upgrade() else {
                return;
            };

            // Register for the next wake BEFORE reporting, then report. The
            // signal is `notify_waiters`, which keeps no permit: an append that
            // lands while nobody is registered wakes nobody. Reporting first and
            // registering after left exactly that gap — and before the first
            // poll the gap is the whole spawn, so a command that printed once
            // and then ran quiet (`echo …; sleep`) was never reported at all.
            // With the registration first, anything the report missed wakes
            // the park below.
            let changed = terminal.output_changed();
            futures::pin_mut!(changed);
            let exited = futures::poll!(changed.as_mut()).is_ready();
            lock(&alive).note_terminal_output(&terminal_id);
            drop(alive);

            // `output_changed` is ready at once after an exit, and the reader
            // records the exit only after its last append, so the report just
            // made already covers everything the command wrote.
            if exited {
                return;
            }
            changed.await;
        }
    });
}

pub fn handle_kill_terminal(
    args: acp::KillTerminalRequest,
    responder: Responder<acp::KillTerminalResponse>,
    ctx: &ClientContext,
) {
    match with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        // A display-only terminal has no process of ours to kill; this is
        // a soft no-op rather than an error, because an agent should not see a
        // failure for a kill that is, in effect, already done from the
        // client's side.
        if terminal.inner().is_none() {
            return Ok(());
        }
        terminal
            .kill()
            .map_err(|err| acp::Error::internal_error().data(err.to_string()))
    }) {
        Ok(Ok(())) => {
            let _ = responder.respond(acp::KillTerminalResponse::default());
        }
        Ok(Err(err)) | Err(err) => respond_err(responder, err),
    }
}

/// Release kills the command — a released terminal has nobody left to read its
/// output, so leaving the process running would leak it for the lifetime of the
/// connection — and retires the id. What the command printed stays on the tool
/// calls that show it (`AcpThread::release_terminal`).
pub fn handle_release_terminal(
    args: acp::ReleaseTerminalRequest,
    responder: Responder<acp::ReleaseTerminalResponse>,
    ctx: &ClientContext,
) {
    let thread = match ctx.sessions.thread(&args.session_id) {
        Ok(thread) => thread,
        Err(err) => return respond_err(responder, err),
    };

    let released = lock(&thread).release_terminal(&args.terminal_id);
    if released {
        let _ = responder.respond(acp::ReleaseTerminalResponse::default());
    } else {
        respond_err(responder, unknown_terminal(&args.terminal_id));
    }
}

pub fn handle_terminal_output(
    args: acp::TerminalOutputRequest,
    responder: Responder<acp::TerminalOutputResponse>,
    ctx: &ClientContext,
) {
    let result = with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.current_output()
    });
    respond_result(responder, result);
}

pub fn handle_wait_for_terminal_exit(
    args: acp::WaitForTerminalExitRequest,
    responder: Responder<acp::WaitForTerminalExitResponse>,
    ctx: &ClientContext,
) {
    // Clone the PTY handle out from under the lock: waiting for a build to
    // finish must not hold the thread mutex — or the dispatch queue. Agents
    // poll `terminal/output` WHILE waiting for the exit, and those polls
    // arrive on the same wire this wait used to block.
    let inner = match with_terminal(ctx, &args.session_id, &args.terminal_id, |terminal| {
        terminal.inner().cloned()
    }) {
        Ok(Some(inner)) => inner,
        // Display-only: the agent owns the process — it announced this
        // terminal through `terminal_info` meta and reports the exit the same
        // way. There is nothing on our side to await.
        Ok(None) => {
            return respond_err(
                responder,
                acp::Error::invalid_params().data(format!(
                "terminal {} is agent-owned (display-only); its exit arrives as terminal_exit meta",
                args.terminal_id
            )),
            )
        }
        Err(err) => return respond_err(responder, err),
    };

    let cancellation = responder.cancellation();
    tokio::spawn(async move {
        let result = cancellation
            .run_until_cancelled(async move {
                Ok(atlas_acp_thread::exit_status_from_command(
                    inner.wait_for_exit().await,
                ))
            })
            .await;

        respond_result(responder, result.map(acp::WaitForTerminalExitResponse::new));
    });
}

/// The ceiling on a terminal's `outputByteLimit` (#92). An agent may ask for
/// less; asking for more gets this.
pub const MAX_OUTPUT_BYTE_LIMIT: u64 = 16 * 1024 * 1024;

/// The JSON-RPC code of a command the user declined to run: in the range
/// JSON-RPC leaves to the implementation, next to ACP's own `-32000` and
/// `-32002`. Not `-32603`: nothing went wrong in the client, the user said no,
/// and an agent reading "internal error" retries or reports a bug.
pub const USER_DECLINED_CODE: i32 = -32001;

/// The refusal an agent hears when the user declines its command (#28).
fn user_declined() -> acp::Error {
    acp::Error::new(USER_DECLINED_CODE, "The user declined to run this command.")
}

fn unknown_terminal(terminal_id: &acp::TerminalId) -> acp::Error {
    acp::Error::internal_error().data(format!("unknown terminal: {terminal_id}"))
}

fn with_terminal<R>(
    ctx: &ClientContext,
    session_id: &acp::SessionId,
    terminal_id: &acp::TerminalId,
    f: impl FnOnce(&atlas_acp_thread::AcpTerminal) -> R,
) -> Result<R, acp::Error> {
    let thread: Arc<Mutex<AcpThread>> = ctx.sessions.thread(session_id)?;
    let thread = lock(&thread);
    let terminal = thread
        .terminal(terminal_id)
        .ok_or_else(|| unknown_terminal(terminal_id))?;
    Ok(f(terminal))
}

#[cfg(test)]
mod dispatch_barrier_tests {
    use super::*;

    struct Push(Arc<Mutex<Vec<&'static str>>>, &'static str);

    impl DispatchWorkItem for Push {
        fn run(self: Box<Self>, _ctx: &ClientContext) {
            lock(&self.0).push(self.1);
        }

        fn reject(self: Box<Self>) {}
    }

    fn ctx() -> ClientContext {
        ClientContext {
            sessions: Arc::new(SessionRegistry::default()),
            request_elicitations: Arc::new(Mutex::new(
                atlas_acp_thread::elicitation::ElicitationStore::new(
                    atlas_acp_thread::event_channel().0,
                ),
            )),
        }
    }

    #[tokio::test]
    async fn a_barrier_runs_after_everything_queued_before_it() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let tx = spawn_dispatch_queue(ctx());
        for frame in ["replay 1", "replay 2", "replay 3"] {
            assert!(tx.send(Box::new(Push(seen.clone(), frame))).await.is_ok());
        }
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let order = seen.clone();
        enqueue_barrier(&tx, move || {
            lock(&order).push("end replay");
            let _ = done_tx.send(());
        })
        .await;
        done_rx.await.unwrap();
        assert_eq!(
            *lock(&seen),
            ["replay 1", "replay 2", "replay 3", "end replay"]
        );
    }

    #[tokio::test]
    async fn a_barrier_on_a_closed_queue_runs_at_once() {
        let (tx, rx) = tokio::sync::mpsc::channel::<DispatchWork>(1);
        drop(rx);
        let ran = Arc::new(Mutex::new(false));
        let flag = ran.clone();
        enqueue_barrier(&tx, move || *lock(&flag) = true).await;
        assert!(*lock(&ran));
    }

    /// #92: the queue is bounded. A full queue makes the enqueue wait — the
    /// RPC crate's reader with it — rather than grow without limit, and the
    /// wait ends as the drain catches up.
    #[tokio::test]
    async fn a_full_queue_makes_the_reader_wait() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DispatchWork>(DISPATCH_QUEUE_CAPACITY);
        let seen = Arc::new(Mutex::new(Vec::new()));
        for _ in 0..DISPATCH_QUEUE_CAPACITY {
            enqueue(&tx, Box::new(Push(seen.clone(), "queued"))).await;
        }
        let blocked = enqueue(&tx, Box::new(Push(seen.clone(), "one more")));
        tokio::pin!(blocked);
        assert!(
            futures::poll!(blocked.as_mut()).is_pending(),
            "a full queue holds the next message back"
        );
        drop(rx.recv().await);
        blocked.await;
        assert_eq!(rx.len(), DISPATCH_QUEUE_CAPACITY);
    }
}

#[cfg(test)]
mod terminal_gate_tests {
    use super::*;
    use atlas_acp_thread::SelectedPermissionOutcome;

    #[test]
    fn preload_class_env_is_denied_and_ordinary_env_is_not() {
        for denied in [
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "LD_PRELOAD",
            "LD_AUDIT",
            "BASH_ENV",
            "ENV",
            "NODE_OPTIONS",
            "node_options",
            "NODE_PATH",
            "PYTHONSTARTUP",
            "PYTHONPATH",
            "PERL5OPT",
            "RUBYOPT",
            "GIT_SSH_COMMAND",
        ] {
            assert!(env_is_denied(denied), "{denied} must be dropped");
        }
        for ok in [
            "PATH",
            "HOME",
            "GIT_TERMINAL_PROMPT",
            "MY_LD_THING",
            "BUILD_DYLD",
        ] {
            assert!(!env_is_denied(ok), "{ok} must survive");
        }
    }

    #[test]
    fn only_an_explicit_allow_authorizes_a_spawn() {
        let allow_once = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("allow_once"),
            acp::PermissionOptionKind::AllowOnce,
        ));
        let allow_always = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("allow_always"),
            acp::PermissionOptionKind::AllowAlways,
        ));
        let reject = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("reject_once"),
            acp::PermissionOptionKind::RejectOnce,
        ));
        assert!(outcome_allows(&allow_once));
        assert!(outcome_allows(&allow_always));
        assert!(!outcome_allows(&reject));
        assert!(!outcome_allows(&RequestPermissionOutcome::Cancelled));
        assert!(!outcome_allows(
            &RequestPermissionOutcome::InterruptedByFollowUp
        ));
    }
}
