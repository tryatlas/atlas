# ADR-0031: Capture scope is decided by the launch folder, and widening it asks first

**Status:** Accepted (2026-11-25). Amends the checkpoint importer's contract, which ADR-0001 preserved. Aligns with the Atlas CLI's ADR-0007 (discovery stops at the repository) and ADR-0015 (a folder of repositories binds once).

## Context

Capture decided which Project a session belonged to in two different ways, and both were wrong at the edges.

- **Live capture** required the session's folder to equal the Project root exactly. A session launched in a subfolder (a monorepo package) or in a linked worktree (`.claude/worktrees/*`, t3 worktrees) was never captured. An audit of one Project found sessions in eight such folders that had been missed.
- **External capture** (the checkpoint importer) read `~/.claude/projects/<encoded root>`. Claude Code's encoding turns every non-alphanumeric character into `-`, so `…/atlas-work/atlas`, `…/atlas/work/atlas` and `…/atlas_work/atlas` share one folder: a session launched in any of them is imported into the one Project. The importer never checked the folder the transcript itself records, and kept none, so what it had imported could not be audited afterwards.
- **The Atlas CLI** walks up from each hook event's folder to the repository root, and since its ADR-0015 past it to a folder of repositories bound as one. The desktop did not read that marker, so opening a member repository created a second store for the same sessions.
- Customers keep one product as several repositories under a plain folder and want one Timeline for it. Others keep unrelated products under one folder and want them kept apart. Both are real.

## Decision

- **The launch folder decides, once per session.** For a session run inside Atlas it is the folder Atlas started it in. For external capture it is read from the transcript's own record of where the session started, never from the folder the transcript is filed under, and a transcript that records no launch folder is not captured. The launch folder is stored on the recorded session.
- **Worktrees translate to the main checkout.** A launch folder inside a linked worktree counts as the same place in the repository's main checkout (`atlas_checkpoint::git::scope_root` already resolves this for shared memory).
- **The nearest Project wins.** From that place, the session belongs to the nearest Project at or above it, looking no further than the root of the repository that contains it, except to a multi-repo Project. A repository nested inside another (a submodule, a vendored clone) is a repository of its own: the outer Project does not capture it. A Project on a plain folder captures that folder and the plain folders below it, but not a repository below it; capturing several repositories is what a multi-repo Project is for. If that nearest Project has capture paused, the session is not recorded; it never falls through to a Project further out. A Project bound to a monorepo subfolder captures only that subfolder.
- **A multi-repo Project is opt-in and reads the CLI's marker.** The desktop honours `.atlas/workspace.json` as written by the CLI's ADR-0015, so a session launched in a member repository records to the folder's one store. Its members are the repositories the marker includes, not every repository somewhere below the folder. A member repository bound at its own root is a Project of its own.
- **No override, and some folders never capture.** A session launched outside every scope is not recorded, and there is no way to record it to a Project by hand. The filesystem root, the home folder or above it, system folders and home settings folders can be opened as Projects but never captured, nor made a multi-repo Project, the same list ADR-0029 refuses for attachment.
- **Widening scope asks first.** On a cloud Project, history that a change of scope makes eligible (this rule's first run, a repository appearing in a multi-repo Project) goes through the same disclosure preview as the first opt-in before anything uploads.
- **The importer may read more, but no differently.** The checkpoint importer's contract, which ADR-0001 preserved, now covers every `~/.claude/projects` folder whose launch folder could fall within a Project's scope, and reading each transcript's recorded launch folder. This is the importer, not history discovery: ADR-0001's rule that discovery never opens a transcript is unchanged.

The terms (Capture, Launch folder, Capture scope, Multi-repo Project, Uncapturable folder) are defined in `CONTEXT.md`.

## Considered options

- **Keep the exact-root match.** Rejected: it silently drops every subfolder and worktree session, and the folder-name collision is still there.
- **Use the whole repository, as shared memory does.** Rejected: a Project bound to a monorepo package would capture every other package's sessions.
- **The CLI's per-event lookup.** Rejected for the desktop: a session that moves between folders would be split across Projects mid-conversation.
- **Treat any parent folder as a multi-repo Project automatically.** Rejected: the CLI's ADR-0015 records one init in a folder of unrelated products pulling ten repositories into one cloud Project.
- **Let a paused sub-Project fall through to its parent.** Rejected: pausing would quietly widen who sees the session.

## Consequences

- Sessions already captured without a launch folder are re-checked against their transcripts. Those whose transcripts are gone, or whose recorded launch folder turns out to be outside the Project's scope, are shown as unverified; none is excluded or erased on that ground alone.
- History discovery's on-disk watcher (ADR-0001) reads the same encoded folder and shares the collision. It only adds sidebar rows and records nothing, so it is left as it is here.
- Capture scope can be narrower than shared memory's for a subfolder Project: memory stays repository-wide.
- The CLI's capture store is the desktop's schema byte for byte. Any schema change this work needs (excluded sessions) lands in both, agreed with the CLI's maintainers first.
- Worktree management (creating, listing, removing worktrees in the app) is not part of this decision.
