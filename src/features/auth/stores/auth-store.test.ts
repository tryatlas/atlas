import { beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";
import { auth, type AuthSnapshot } from "../lib/auth-api";
vi.mock("../lib/auth-api", () => ({
  auth: {
    signIn: vi.fn(),
    cancelSignIn: vi.fn(async () => ({ status: "signed-out" })),
    snapshot: vi.fn(),
  },
}));
vi.mock("@/features/telemetry/posthog-client", () => ({
  identify: vi.fn(),
  resetIdentity: vi.fn(),
}));
beforeEach(() =>
  useAuthStore.setState({
    snapshot: { status: "signed-out" },
    starting: false,
    dialogOpen: false,
    error: null,
  }),
);
it("keeps a failed grant visible for retry", async () => {
  vi.mocked(auth.signIn).mockResolvedValue({
    status: "connecting",
    userCode: "abc",
    verificationUri: "https://example.test",
    expiresAt: "later",
  });
  await useAuthStore.getState().actions.beginSignIn();
  useAuthStore.getState().actions.setSnapshot({ status: "signed-out" });
  useAuthStore.getState().actions.setError("Grant expired");
  expect(useAuthStore.getState()).toMatchObject({
    dialogOpen: true,
    error: "Grant expired",
    starting: false,
  });
});
it("ignores the sign-in result after cancellation", async () => {
  let resolve!: (snapshot: AuthSnapshot) => void;
  vi.mocked(auth.signIn).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const starting = useAuthStore.getState().actions.beginSignIn();
  await useAuthStore.getState().actions.cancelSignIn();
  resolve({
    status: "connecting",
    userCode: "abc",
    verificationUri: "https://example.test",
    expiresAt: "later",
  });
  await starting;
  expect(useAuthStore.getState()).toMatchObject({
    snapshot: { status: "signed-out" },
    dialogOpen: false,
    starting: false,
  });
});
