//! Windows process-tree ownership for an external ACP agent.
//!
//! A suspended spawn cannot create descendants before joining the kill-on-close
//! job. An empty job nests under an inherited job on Windows 8+, without
//! requesting breakaway or weakening the parent's restrictions.

use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub(crate) struct AgentJob(OwnedHandle);

impl AgentJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security/name creates a private, non-inheritable job.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful CreateJobObject transfers this unique handle.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer/size describe a live struct of the requested class.
        if unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    pub(crate) fn assign_and_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("agent exited before job assignment"))?;
        // SAFETY: both handles are live, and the new process has not run yet.
        if unsafe { AssignProcessToJobObject(self.handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("agent has no process id"))?;
        resume_initial_thread(pid)
    }

    pub(crate) fn terminate(&self) {
        // SAFETY: this is the private job owned by this connection. Closing its
        // handle below is the backstop if the explicit termination fails.
        unsafe {
            TerminateJobObject(self.handle(), 1);
        }
    }
}

fn resume_initial_thread(pid: u32) -> io::Result<()> {
    // Stable Rust 1.99 does not expose Child's primary thread handle. The
    // documented ToolHelp enumeration obtains it while CREATE_SUSPENDED keeps
    // the process from running or spawning any other threads of its own.
    // SAFETY: no pointers are supplied; the returned snapshot is owned here.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateToolhelp32Snapshot returned a valid, uniquely owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: initialized structure and valid snapshot handle.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while found {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: thread id came from the system snapshot; ask only for
            // the one right needed to resume the process we created.
            let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful OpenThread transfers this handle to us.
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: the handle has THREAD_SUSPEND_RESUME access.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        // SAFETY: same valid snapshot and initialized structure.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    Err(io::Error::other(
        "could not find suspended agent's initial thread",
    ))
}
