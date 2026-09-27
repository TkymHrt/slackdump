// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";

vi.mock("./MessageList", () => ({
  default: ({ channelId, threadTs, at }: { channelId: string; threadTs?: string; at?: string }) => (
    <div
      data-testid={threadTs ? "thread" : "messages"}
    >{`${channelId}:${threadTs || ""}:${at || ""}`}</div>
  ),
}));

const bootstrap = {
  name: "sample-archive",
  type: "database",
  canAlias: true,
  channels: [
    {
      id: "C1",
      name: "#general",
      kind: "public",
      archived: false,
      canvasPresent: false,
      canvasAvailable: false,
    },
    {
      id: "C2",
      name: "#random",
      kind: "public",
      archived: false,
      canvasPresent: false,
      canvasAvailable: false,
    },
  ],
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      let data: unknown = {};
      if (url.pathname === "/api/bootstrap") data = bootstrap;
      else if (url.pathname === "/api/channels/C1" || url.pathname === "/api/channels/C2")
        data = bootstrap.channels.find((channel) => url.pathname.endsWith(channel.id));
      else if (url.pathname === "/api/search")
        data = {
          results: [
            {
              channelId: "C1",
              channelName: "#general",
              message: {
                ts: "1710000001.000001",
                threadTs: "1710000000.000001",
                author: "Ada",
                avatar: "",
                html: "found reply",
                time: "2024-03-09 16:00:01",
                isThreadStart: false,
              },
            },
          ],
        };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

test("navigates channels without carrying a message position", async () => {
  renderApp();
  fireEvent.click(await screen.findByRole("link", { name: "general" }));
  expect(window.location.pathname).toBe("/archives/C1");
  expect((await screen.findByTestId("messages")).textContent).toBe("C1::");
  fireEvent.click(screen.getByRole("link", { name: "random" }));
  expect((await screen.findByTestId("messages")).textContent).toBe("C2::");
  fireEvent.click(screen.getByRole("link", { name: "general" }));
  expect((await screen.findByTestId("messages")).textContent).toBe("C1::");
});

test("opens a search hit in its thread at the matching reply", async () => {
  renderApp();
  const input = await screen.findByRole("searchbox", { name: "メッセージを検索" });
  fireEvent.change(input, { target: { value: "found" } });
  const hit = await screen.findByRole("button", { name: /found reply/ });
  fireEvent.click(hit);
  expect(window.location.pathname).toBe("/archives/C1/1710000000.000001");
  expect(window.location.hash).toBe("#1710000001.000001");
  expect((await screen.findByTestId("thread")).textContent).toContain(
    "C1:1710000000.000001:1710000001.000001",
  );
});
