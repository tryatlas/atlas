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
//             (done; its one entry left is a WCAG exemption, not debt: see
//             `settings`)
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

// What every screen with the sidebar showing carries. A modal (First run, the
// palette) hides the sidebar from axe, so those carry none of it.
const SHELL: Known[] = [
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
  "fresh-install": [DIALOG_FOCUS_GUARDS],
  // Surfaces reached by a journey.
  "command-palette": [DIALOG_FOCUS_GUARDS],
  // Settings makes the workspace behind it inert, so the shell's rules are gone.
  settings: [
    {
      // Not debt: WCAG 1.4.3 exempts an inactive control's text. The rows'
      // controls are `inert` (no pointer, keyboard or assistive input), and
      // their description takes the design system's one disabled treatment,
      // half opacity, which over a card is 2.41:1. axe cannot see that the
      // row is inactive. Chromium only: see the rule below.
      rule: "color-contrast",
      issue: "ATL-1006",
      why: "the Windows-only disabled rows dim their description to 2.41:1 (WCAG-exempt: an inactive control)",
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
  const scan = async () => {
    // Let entrances settle first: reduced motion keeps opacity fades (the
    // composer placeholder, its pills), and axe sampling one mid-fade reads
    // its text as faint. Ten calm frames in a row; looping animations never
    // settle, so they do not count.
    await page.waitForFunction(() => {
      const entering = document
        .getAnimations()
        .some(
          (a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity,
        );
      const w = window as { __axeCalmFrames?: number };
      w.__axeCalmFrames = entering ? 0 : (w.__axeCalmFrames ?? 0) + 1;
      return w.__axeCalmFrames >= 10;
    });
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
    return { blocking, unexpected };
  };

  // Something can still mount and fade in during the scan (the lazily loaded
  // editor lands whenever its chunk does, and not every scenario waits for
  // it), so a failure must reproduce on a second, settled scan. A real one
  // always does.
  let { blocking, unexpected } = await scan();
  if (unexpected.length > 0) ({ blocking, unexpected } = await scan());

  const fired = new Set(blocking.map((v) => v.id));
  for (const k of known.filter((k) => !fired.has(k.rule))) {
    testInfo.annotations.push({
      type: "stale-allowlist",
      description: `${surface}: ${k.rule} no longer fires (${k.issue}); delete it from e2e/a11y.ts`,
    });
  }

  expect(unexpected, `new serious/critical axe violations on ${surface}`).toEqual([]);
}
