import { describe, expect, it } from "vitest";
import { commitAvatarSrc } from "./commit-avatar";

describe("commitAvatarSrc", () => {
  it("uses the GitHub avatar gh returned for the email", () => {
    expect(
      commitAvatarSrc(
        " Ada@Example.com ",
        { "ada@example.com": "https://avatars.example/u/1" },
        32,
      ),
    ).toBe("https://avatars.example/u/1?s=32");
  });

  it("reads a GitHub noreply address without a lookup", () => {
    expect(commitAvatarSrc("123+ada@users.noreply.github.com", undefined, 32)).toBe(
      "https://avatars.githubusercontent.com/u/123?v=4&s=32",
    );
  });

  // An author GitHub doesn't know gets initials. Nothing about the email,
  // hashed or not, goes to Gravatar or anywhere else.
  it("falls to initials, never Gravatar, when GitHub doesn't know the author", () => {
    expect(commitAvatarSrc("someone@example.com", {}, 32)).toBeNull();
    expect(commitAvatarSrc("someone@example.com", undefined, 32)).toBeNull();
    expect(commitAvatarSrc("", undefined, 32)).toBeNull();
  });
});
