/**
 * Where `bun run ci:local` runs each job: on this machine, in the Linux
 * container, or not at all. Decided from settings alone, never from whether a
 * container runtime happens to be up, so the same command on the same branch
 * always places its jobs the same way and `--list` shows what a run will do.
 *
 * Linux jobs go where the Linux mode says, read in this order:
 *
 *   --linux / --native        this run only
 *   ATLAS_CI_LINUX            this machine (set it in a gitignored mise.local.toml)
 *   native                    the default
 *
 * The modes:
 *
 *   native   every job on this machine; the app's Linux compile is skipped
 *            and the sandbox crate's suites run under macOS's seatbelt
 *   needed   the jobs only Linux can judge (`needsLinux`) in the container
 *   all      every Linux job in the container (`--linux`), CI's full replica
 *
 * Native is the default because almost every Linux CI failure fails on a Mac
 * too; ci-local.mjs's docblock has the numbers, and what native leaves to CI.
 * A mode that wants the container requires a runtime: with none running,
 * ci-local exits instead of quietly running those jobs here.
 *
 * Plain Node, no Bun APIs, so `scripts/doctor.mjs` and the tests can import it.
 */

export const LINUX_MODES = ["native", "needed", "all"];

/** Jobs that compile for their runner's OS. Anywhere else they would repeat
 *  the macOS `app` job's check under the wrong `cfg`, so they run only there
 *  (or, for Linux, in the container). */
export const OS_BOUND = new Set(["app-linux", "app-windows"]);

/** This machine's OS, spelled as ci.yml's runners are. */
export function hostOs(platform = process.platform) {
  return { darwin: "macos", win32: "windows" }[platform] ?? platform;
}

/** Linux jobs no other OS can stand in for: the crates and engine regression
 *  suites that run the sandbox, and the app's Linux compile. */
export function needsLinux(job) {
  return Boolean(job.flags?.sandbox) || job.id === "engine-dialect" || job.id === "app-linux";
}

/**
 * The Linux mode for this run and what chose it, as `{ mode, source }`.
 * Throws on contradictory flags or an unknown `ATLAS_CI_LINUX`.
 */
export function linuxMode(argv, env) {
  const linux = argv.includes("--linux");
  const native = argv.includes("--native");
  if (linux && native) throw new Error("--linux and --native contradict each other");
  if (linux) return { mode: "all", source: "--linux" };
  if (native) return { mode: "native", source: "--native" };
  const value = env.ATLAS_CI_LINUX;
  if (value) {
    if (!LINUX_MODES.includes(value)) {
      throw new Error(`ATLAS_CI_LINUX=${value} is not one of: ${LINUX_MODES.join(", ")}`);
    }
    return { mode: value, source: `ATLAS_CI_LINUX=${value}` };
  }
  return { mode: "native", source: "the default" };
}

/** "container", "native" or "skip" for one job. */
export function placement(job, host, mode) {
  if (job.os === "linux") {
    if (mode === "all") return "container";
    if (mode === "needed" && host !== "linux" && needsLinux(job)) return "container";
  }
  if ((job.os === "macos" || OS_BOUND.has(job.id)) && job.os !== host) return "skip";
  return "native";
}
