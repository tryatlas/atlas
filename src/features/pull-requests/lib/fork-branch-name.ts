/** Mirrors checkout::sanitize_branch_fragment at the native checkout seam. */
export function forkBranchName(number: number, head: string): string {
  const suffix = head
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./_\-\s]+|[./_\-\s]+$/g, "")
    .replace(/[^a-z0-9/_-]/gu, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return `atlas/pr-${number}/${suffix || "update"}`;
}
