//! One connection attempt, from dial to close.
//!
//! ## The ticket
//!
//! Browsers cannot set headers on a WebSocket, so the contract puts the access
//! JWT in the subprotocol list — and the desktop follows the same shape rather
//! than inventing a second one:
//!
//! ```text
//! Sec-WebSocket-Protocol: atlas.v1, atlas.ticket.<jwt>
//! ```
//!
//! The server echoes only `atlas.v1` on the 101; the ticket is never reflected.
//!
//! **Never log the request, its headers, or the URL of a failed dial.** The
//! second value in that header is a live credential. Every `tracing` call in
//! this module is written to be safe with that rule in mind.

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::error::{CommsError, Result};
use crate::wire::{ClientFrame, ServerFrame};

/// Why an attempt ended. The manager's whole retry policy keys off this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitReason {
    /// Closed cleanly or by the peer; reconnect after a backoff.
    Closed,
    /// The ticket was refused. Worth exactly one immediate re-mint: the JWT
    /// lives ten minutes and can expire between minting and dialling.
    Unauthorized,
    /// Valid token, not a member of this Organisation. Retrying cannot help.
    Forbidden,
    /// Removed from the Organisation — delivered as a frame, then closed 1008.
    Evicted,
    /// Transport failure; back off and retry.
    Transport(String),
}

/// What a live connection hands back to the manager.
pub enum ConnEvent {
    /// A frame arrived. Already parsed; an unknown `t` is `ServerFrame::Unknown`.
    Frame(ServerFrame),
    /// The attempt ended.
    Closed(ExitReason),
}

/// Build the dial request with the two-value subprotocol offer. Shared with
/// the Spaces socket, which authenticates identically.
///
/// The pinned fork validates the server's echo against this list, so a server
/// that echoed something else fails the handshake rather than proceeding on a
/// protocol nobody agreed to.
pub(crate) fn ticket_request(
    url: String,
    token: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut request = url
        .into_client_request()
        .map_err(|e| CommsError::Transport(format!("bad url: {e}")))?;
    let protocols = format!("atlas.v1, atlas.ticket.{token}");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocols)
            .map_err(|_| CommsError::Protocol("token is not a valid header value".into()))?,
    );
    Ok(request)
}

/// Dial, hand every frame to `events`, and write everything from `outbound`
/// until one side closes.
///
/// `resume_from` is the persisted watermark. It is sent as `resume { since }`
/// immediately after `hello` lands — always, including the very first
/// connection, where a `0` simply means "everything you still have".
pub async fn run(
    url: String,
    token: String,
    resume_from: i64,
    mut outbound: mpsc::UnboundedReceiver<ClientFrame>,
    events: mpsc::UnboundedSender<ConnEvent>,
) -> Result<()> {
    let request = ticket_request(url, &token)?;

    let (stream, _response) = match connect(request).await {
        Ok(ok) => ok,
        Err(reason) => {
            // Deliberately logs the *classification*, never the error's own
            // Display — a tungstenite HTTP error can carry the request back.
            tracing::warn!(target: "atlas_comms::conn", "handshake failed: {reason:?}");
            let _ = events.send(ConnEvent::Closed(reason));
            return Ok(());
        }
    };

    tracing::info!(target: "atlas_comms::conn", "socket open");
    let (mut write, mut read) = stream.split();

    // `resume` goes out before anything else this client wants to say. The
    // server answers with a replay terminated by `resumed`, or with `too_old`.
    let resume = serde_json::to_string(&ClientFrame::Resume { since: resume_from })?;
    if let Err(e) = write.send(WsMessage::Text(resume.into())).await {
        let _ = events.send(ConnEvent::Closed(ExitReason::Transport(e.to_string())));
        return Ok(());
    }

    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(20),
        std::time::Duration::from_secs(20),
    );
    let mut last_received = tokio::time::Instant::now();
    let exit = loop {
        tokio::select! {
                _ = tokio::time::sleep_until(last_received + std::time::Duration::from_secs(60)) => {
                    break ExitReason::Transport("socket stopped responding".into());
                }
                _ = heartbeat.tick() => {
                    if let Err(error) = crate::conn::send_frame(&mut write, WsMessage::Ping(Vec::new().into())).await {
                        break ExitReason::Transport(error);
                    }
                }
            incoming = read.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                        last_received = tokio::time::Instant::now();
                    match serde_json::from_str::<ServerFrame>(&text) {
                        Ok(frame) => {
                            let evicted = matches!(frame, ServerFrame::MemberEvicted { .. });
                            if events.send(ConnEvent::Frame(frame)).is_err() {
                                break ExitReason::Closed;
                            }
                            // Eviction is announced and then the socket closes
                            // 1008. Recording it here means the manager can
                            // tell "you were removed" from "connection lost".
                            if evicted {
                                break ExitReason::Evicted;
                            }
                        }
                        Err(e) => {
                            // A frame we cannot parse is not fatal: the server
                            // ships ahead of us and a new *shape* is as
                            // possible as a new `t`.
                            tracing::debug!(target: "atlas_comms::conn", "undecodable frame: {e}");
                        }
                    }
                }
                Some(Ok(WsMessage::Close(frame))) => {
                    let evicted = frame
                        .as_ref()
                        .is_some_and(|f| u16::from(f.code) == 1008);
                    break if evicted { ExitReason::Evicted } else { ExitReason::Closed };
                }
                Some(Ok(_)) => { last_received = tokio::time::Instant::now(); } // ping/pong/binary — nothing here sends binary
                Some(Err(e)) => break ExitReason::Transport(e.to_string()),
                None => break ExitReason::Closed,
            },

            to_send = outbound.recv() => match to_send {
                Some(frame) => {
                    let text = match serde_json::to_string(&frame) {
                        Ok(t) => t,
                        Err(e) => {
                            tracing::error!(target: "atlas_comms::conn", "unserializable frame: {e}");
                            continue;
                        }
                    };
                    if let Err(e) = crate::conn::send_frame(&mut write, WsMessage::Text(text.into())).await {
                        break ExitReason::Transport(e);
                    }
                }
                // The manager dropped the sender: this target is being torn
                // down. Close politely so the server drops presence promptly.
                None => {
                    let _ = crate::conn::send_frame(&mut write, WsMessage::Close(None)).await;
                    break ExitReason::Closed;
                }
            },
        }
    };

    tracing::info!(target: "atlas_comms::conn", "socket closed: {exit:?}");
    let _ = events.send(ConnEvent::Closed(exit));
    Ok(())
}

/// Map a handshake failure onto the retry policy.
///
/// The three that matter are distinguishable only by status: `401` is worth one
/// re-mint, `403` is worth nothing at all, and everything else is worth a
/// backoff.
/// How long a WebSocket dial (TCP, TLS and the HTTP upgrade together) may
/// take. `connect_async` has no deadline of its own, so a peer that accepts the
/// connection and never answers the upgrade used to park the reconnect loop
/// forever, the UI stuck on "connecting".
pub(crate) const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsResponse = tokio_tungstenite::tungstenite::handshake::client::Response;

/// Dial `request` within [`HANDSHAKE_TIMEOUT`]; a failure comes back already
/// classified (never as the error itself, which can carry the ticket).
pub(crate) async fn connect(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
) -> std::result::Result<(WsStream, WsResponse), ExitReason> {
    connect_within(request, HANDSHAKE_TIMEOUT).await
}

async fn connect_within(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    deadline: std::time::Duration,
) -> std::result::Result<(WsStream, WsResponse), ExitReason> {
    match tokio::time::timeout(deadline, tokio_tungstenite::connect_async(request)).await {
        Ok(Ok(ok)) => Ok(ok),
        Ok(Err(err)) => Err(classify_handshake(&err)),
        Err(_) => Err(ExitReason::Transport("handshake timed out".into())),
    }
}

fn classify_handshake(err: &tokio_tungstenite::tungstenite::Error) -> ExitReason {
    use tokio_tungstenite::tungstenite::Error;
    match err {
        Error::Http(response) => match response.status().as_u16() {
            401 => ExitReason::Unauthorized,
            403 => ExitReason::Forbidden,
            other => ExitReason::Transport(format!("HTTP {other}")),
        },
        // Deliberately not formatting the error itself: a tungstenite error can
        // carry the request, and the request carries the ticket.
        Error::Io(_) => ExitReason::Transport("io".into()),
        Error::Tls(_) => ExitReason::Transport("tls".into()),
        Error::Protocol(p) => ExitReason::Transport(format!("protocol: {p}")),
        _ => ExitReason::Transport("connect failed".into()),
    }
}

/// A stalled peer must not trap the select loop inside a write forever.
pub(crate) async fn send_frame<W>(
    write: &mut W,
    frame: WsMessage,
) -> std::result::Result<(), String>
where
    W: futures_util::Sink<WsMessage> + Unpin,
    W::Error: std::fmt::Display,
{
    tokio::time::timeout(std::time::Duration::from_secs(10), write.send(frame))
        .await
        .map_err(|_| "socket write timed out".to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// N6: a peer that accepts the TCP connection and never answers the
    /// upgrade must not hold the dial forever.
    #[tokio::test]
    async fn a_silent_peer_times_the_handshake_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _held = tokio::spawn(async move {
            let mut kept = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                kept.push(socket); // accepted, never answered
            }
        });
        let request = ticket_request(format!("ws://{addr}/socket"), "t").unwrap();
        let started = std::time::Instant::now();
        let result = connect_within(request, std::time::Duration::from_millis(200)).await;
        assert!(matches!(
            result,
            Err(ExitReason::Transport(ref why)) if why == "handshake timed out"
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
