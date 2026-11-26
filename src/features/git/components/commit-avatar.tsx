import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage, Icon, initialsOf } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { useGitStore } from "../stores/git-store";
import { useGithubAvatars } from "../lib/git-avatars-api";

/** GitHub's private-email form `<id>+<login>@users.noreply.github.com` names
 *  the account outright — no lookup needed. */
const NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/;

function withSize(url: string, px: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
}

/**
 * The image URL for an author's face, or `null` for initials.
 *
 * Only GitHub: an avatar the user's own `gh` returned for this repository, or
 * the one a GitHub noreply address names outright. There is deliberately no
 * Gravatar fallback. It sent a hash of every commit author's email, plus the
 * user's IP, to a third party for any author GitHub didn't know, and a hash of
 * an email is easily reversed.
 */
export function commitAvatarSrc(
  email: string | null | undefined,
  byEmail: Record<string, string> | undefined,
  px: number,
): string | null {
  const key = email?.trim().toLowerCase() ?? "";
  if (!key) return null;
  const noreplyId = key.match(NOREPLY)?.[1];
  const github =
    byEmail?.[key] ||
    (noreplyId ? `https://avatars.githubusercontent.com/u/${noreplyId}?v=4` : null);
  return github ? withSize(github, px) : null;
}

interface CommitAvatarProps {
  email: string | null | undefined;
  /** The author's name, for the initials shown when there is no face. */
  name?: string;
  /** The repository the commit belongs to; defaults to the active one. */
  repoPath?: string;
  /** Pixels. Commit rows are denser than the control ladder the package
   *  `Avatar` sizes to, so the face is sized here. */
  size?: number;
  className?: string;
}

/**
 * A commit author's face: their GitHub avatar when GitHub knows the email,
 * else their initials, else a generic glyph. An avatar that fails to load
 * falls through to the initials.
 */
export function CommitAvatar({ email, name, repoPath, size = 16, className }: CommitAvatarProps) {
  const key = email?.trim().toLowerCase() ?? "";
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const activeRepo = useGitStore((s) => s.repoPath);
  const byEmail = useGithubAvatars(repoPath ?? activeRepo ?? "");

  useEffect(() => {
    setFailed(new Set());
  }, [key]);

  const candidate = commitAvatarSrc(email, byEmail, size * 2);
  const src = candidate && !failed.has(candidate) ? candidate : null;
  // No face anywhere: the author's initials, else the email's; the glyph
  // only when neither gives a letter.
  const fallback = initialsOf(name ?? "", email ?? undefined);

  return (
    <Avatar size="xs" className={className} style={{ width: size, height: size }}>
      {src ? (
        <AvatarImage
          key={src}
          src={src}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === "error") setFailed((prev) => new Set(prev).add(src));
          }}
        />
      ) : null}
      <AvatarFallback>
        {fallback === "?" ? (
          <Icon icon={User} size="xs" className="text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "font-medium leading-none text-muted-foreground",
              size >= 28 ? "text-xs" : "text-3xs",
            )}
          >
            {/* Two letters don't fit a row-sized face; one does. */}
            {size >= 20 ? fallback : fallback.slice(0, 1)}
          </span>
        )}
      </AvatarFallback>
    </Avatar>
  );
}
