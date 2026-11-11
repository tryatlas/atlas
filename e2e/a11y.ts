// The axe check every surface runs, and today's known violations.
//
// A surface fails on any `serious` or `critical` violation whose rule is not
// in its allowlist below. The allowlist is the accessibility debt as it stood
// when this suite landed (2026-11-11), not a policy: every entry names the
// issue fixing it, and the entry goes when that issue lands. Never add a rule
// here to make a new failure pass; fix the markup.
//
//   ATL-1007  desktop: Atlas fully drivable through the accessibility tree
//   ATL-1006  @tryatlas/design: raise the contrast of its muted and disabled text
//
// An entry whose rule no longer fires is reported as a `stale-allowlist`
// annotation on the test (in the list reporter and the HTML report) rather
// than failing it, so the fix that clears it is not blocked on editing this
// file in the same change.

import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "./fixtures";

interface Known {
  rule: string;
  issue: "ATL-1006" | "ATL-1007";
  why: string;
  /** Only these engines report it. Omitted: both do. */
  engines?: ("chromium" | "webkit")[];
}

const CONTRAST: Known = {
  rule: "color-contrast",
  issue: "ATL-1006",
  why: "the package's muted text passes since 0.1.18; desktop still dims it further (the sidebar's text-muted-foreground/60 branch names at 2.96:1), and the 'Working' status (3.75:1) and the composer placeholder sit under 4.5:1",
};

// What every screen with the sidebar showing carries. A modal (First run, the
// palette) hides the sidebar from axe, so those carry only CONTRAST.
const SHELL: Known[] = [
  CONTRAST,
  {
    rule: "label-content-name-mismatch",
    issue: "ATL-1007",
    why: "status chips and menu triggers (capture status, Attach a project, Pull) are named for what they do, not their visible text",
  },
];

// Base UI's dialog focus guards are tabbable spans that WebKit's tree exposes
// as unnamed buttons; Chromium's does not.
const DIALOG_FOCUS_GUARDS: Known = {
  rule: "aria-command-name",
  issue: "ATL-1007",
  why: "Base UI focus-guard spans read as unnamed buttons in WebKit",
  engines: ["webkit"],
};

export const KNOWN_VIOLATIONS: Record<string, Known[]> = {
  // Scenarios, as each boots.
  default: SHELL,
  "git-conflict": SHELL,
  northwind: SHELL,
  "chat-markdown": SHELL,
  "chat-tools": SHELL,
  sidebar: SHELL,
  "inbox-long": SHELL,
  "memory-populated": SHELL,
  knowledge: SHELL,
  "fresh-install": [CONTRAST, DIALOG_FOCUS_GUARDS],
  // Surfaces reached by a journey.
  "command-palette": [CONTRAST, DIALOG_FOCUS_GUARDS],
  // Settings makes the workspace behind it inert, so the shell's rules are gone.
  settings: [
    {
      ...CONTRAST,
      why: "the Windows-only disabled rows dim their description to 2.41:1",
      engines: ["chromium"],
    },
    {
      // Chromium's "Desktop Chrome" profile reports Windows, so Settings shows
      // its Windows-only disabled rows.
      rule: "aria-prohibited-attr",
      issue: "ATL-1007",
      why: "the 'Not available on Windows yet' tooltip trigger is a role-less span with aria-label",
      engines: ["chromium"],
    },
  ],
  "source-control": [
    ...SHELL,
    {
      rule: "aria-required-children",
      issue: "ATL-1007",
      why: "a tab's close button and a changed file's actions sit beside the tab or option inside the tablist or listbox: inside it they would be presentational, and an assistive client could not press them",
    },
  ],
};

/**
 * Run axe on what the page shows now and fail on any serious or critical
 * violation not allowlisted for `surface`.
 */
export async function expectNoNewViolations(
  page: Page,
  surface: string,
  testInfo: TestInfo,
): Promise<void> {
  const engine = testInfo.project.name;
  const known = (KNOWN_VIOLATIONS[surface] ?? []).filter(
    (k) => !k.engines || k.engines.includes(engine as "chromium" | "webkit"),
  );
  const results = await new AxeBuilder({ page })
    // The mock's scenario badge is dev-only chrome that never ships.
    .exclude("[data-mock-badge]")
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const unexpected = blocking
    .filter((v) => !known.some((k) => k.rule === v.id))
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => n.html.slice(0, 160)),
    }));

  const fired = new Set(blocking.map((v) => v.id));
  for (const k of known.filter((k) => !fired.has(k.rule))) {
    testInfo.annotations.push({
      type: "stale-allowlist",
      description: `${surface}: ${k.rule} no longer fires (${k.issue}); delete it from e2e/a11y.ts`,
    });
  }

  expect(unexpected, `new serious/critical axe violations on ${surface}`).toEqual([]);
}
