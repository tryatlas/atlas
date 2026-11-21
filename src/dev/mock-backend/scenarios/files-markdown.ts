// A markdown document open rendered in its file tab (`src/features/editor/`),
// for the tables in a rendered document (`src/lib/markdown-table.ts`):
//
//   - a table of values, which stays as narrow as its text;
//   - prose next to values, where the prose column keeps a readable width and
//     wraps, and the value columns stay narrow;
//   - more prose columns than the document is wide, which scrolls sideways in
//     its own box instead of squeezing every column to a word per line.
//
// The header's toggle switches to the source and back.

import type { Scenario } from "../types";
import { MOCK_PROJECT } from "../project";
import { fsHandlers } from "../fixtures/files";

const DOC = `${MOCK_PROJECT.path}/docs/settings.md`;

const prose = (topic: string) =>
  `Controls how ${topic} behaves while an agent is working, and what Atlas does when the two disagree.`;

const TEXT = `# Settings reference

Every setting below lives in \`~/.config/atlas/config.toml\`.

## Defaults

| Setting | Default | Since |
| --- | :-: | ---: |
| \`wordWrap\` | \`true\` | 0.3.0 |
| \`gitBlameInline\` | \`true\` | 0.4.0 |
| \`shareTelemetry\` | \`true\` | 0.1.0 |

## Editor

| # | Setting | What it does |
| -: | --- | --- |
| 1 | \`wordWrap\` | Wraps long lines in the file view and the diff viewer instead of scrolling them sideways, so a line's height follows the width of the panel. |
| 2 | \`gitBlameInline\` | Shows who last changed the line under the cursor, when, and in which commit, at the end of the line or in the header while wrapping. |

## Agents

| Area | Approvals | Sandbox | Files | Network | Memory |
| --- | --- | --- | --- | --- | --- |
| Native agent | ${prose("approval")} | ${prose("the sandbox")} | ${prose("file access")} | ${prose("network access")} | ${prose("memory")} |
| ACP agents | ${prose("approval")} | ${prose("the sandbox")} | ${prose("file access")} | ${prose("network access")} | ${prose("memory")} |
`;

export const filesMarkdown: Scenario = {
  name: "files-markdown",
  description: "A markdown document open rendered, with narrow, prose and too-wide tables.",
  commands: {
    read_file_content: (args) => (args.path === DOC ? TEXT : fsHandlers.read_file_content(args)),
  },
  setup: async () => {
    const { writeRenderedPreference } = await import("@/features/editor/lib/file-preview-mode");
    writeRenderedPreference("markdown", true);
    const { openFile } = await import("@/lib/open-file");
    await openFile(DOC);
  },
};
