//! The small pieces every test around a scripted agent needs.

use std::path::{Path, PathBuf};
use std::sync::PoisonError;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThreadHandle, AgentThreadEntry, SelectedPermissionOutcome, ToolCallStatus,
};

/// Approves every permission prompt a thread raises, with its first "allow
/// once" option, until dropped: the agent's own
/// `session/request_permission`s, and the prompt Atlas raises itself before
/// it runs a `terminal/create`.
pub struct Approver(tokio::task::JoinHandle<()>);

impl Approver {
    pub fn start(thread: AcpThreadHandle) -> Self {
        Self::answering(thread, acp::PermissionOptionKind::AllowOnce)
    }

    /// Declines every prompt instead, with its first "reject once" option.
    pub fn rejecting(thread: AcpThreadHandle) -> Self {
        Self::answering(thread, acp::PermissionOptionKind::RejectOnce)
    }

    fn answering(thread: AcpThreadHandle, kind: acp::PermissionOptionKind) -> Self {
        Self(tokio::spawn(async move {
            loop {
                let waiting: Vec<(acp::ToolCallId, acp::PermissionOption)> = thread
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entries()
                    .iter()
                    .filter_map(|entry| match entry {
                        AgentThreadEntry::ToolCall(call) => match &call.status {
                            ToolCallStatus::WaitingForConfirmation { options, .. } => options
                                .first_option_of_kind(kind)
                                .map(|option| (call.id.clone(), option.clone())),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect();
                for (id, option) in waiting {
                    thread
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .authorize_tool_call(
                            id,
                            SelectedPermissionOutcome::new(option.option_id, option.kind),
                        );
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }))
    }
}

impl Drop for Approver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A fresh, real directory for a session to work in, removed on drop.
pub struct Folder(PathBuf);

impl Folder {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "atlas-session-folder-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).expect("create the session folder");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Default for Folder {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
