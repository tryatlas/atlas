//! Test doubles for the far side of the pipe: an ACP agent a test scripts.
//!
//! Behind the `test-support` feature, which consumers turn on under
//! `[dev-dependencies]` only: a build without it does not compile this
//! module.
//!
//! `atlas_acp_thread::test_support::FakeConnection` stands in for a whole
//! connection, in process, at the `AgentConnection` seam. What it cannot be is
//! an agent on the other end of the transport, which is where an agent unlike
//! the one Atlas was built against shows itself: what it advertises at
//! `initialize`, the order and timing of what it writes, the requests it sends
//! back, the bytes it puts on stdout and stderr. [`ScriptedAgent`] is that: a
//! real child process over real pipes, playing a [`Scenario`].
//!
//! [`scenarios`] holds the named ones the conformance suites run.

mod helpers;
pub mod scenarios;
mod scripted_agent;

pub use helpers::{Approver, Folder};
pub use scripted_agent::{kept_thread_events, Scenario, Script, ScriptedAgent};
