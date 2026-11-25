// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SpaceCursors } from "./space-cursors";
vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tryatlas/design", () => ({
  actorHue: () => "blue",
  PresenceCursor: ({ name }: { name: string }) => <span>{name}</span>,
}));
afterEach(cleanup);
it("positions a peer cursor on its first render without another awareness frame", () => {
  const view = render(
    <SpaceCursors
      actors={
        new Map([
          [
            "peer",
            {
              id: "peer",
              name: "Peer",
              colour: "blue",
              cursor: { x: 123, y: -45 },
              selection: [],
              viewport: null,
              following: null,
            },
          ],
        ])
      }
    />,
  );
  expect(view.getByText("Peer").parentElement?.style.transform).toBe(
    "translate3d(123px, -45px, 0)",
  );
});
