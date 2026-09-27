import { expect, test } from "@playwright/test";

const ts = (n: number) => `1710000000.${String(n).padStart(6, "0")}`;
const channel = {
  id: "C1",
  name: "#general",
  kind: "public",
  archived: false,
  canvasPresent: false,
  canvasAvailable: false,
  topic: "A place for everyone",
};
const reply = {
  ts: "1710000001.000001",
  userId: "U1",
  author: "Ada",
  avatar: "/static/48x48.gif",
  html: "<p>reply body</p>",
  time: "2024-03-09 16:00:01",
  threadTs: ts(100),
  isThreadStart: false,
};
const messages = Array.from({ length: 205 }, (_, i) => ({
  ts: ts(i + 1),
  userId: "U1",
  author: "Ada",
  avatar: "/static/48x48.gif",
  html: `<p>message ${i + 1}</p>`,
  time: `2024-03-09 16:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
  threadTs: i === 99 ? ts(100) : undefined,
  replyCount: i === 99 ? 1 : undefined,
  isThreadStart: i === 99,
}));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/bootstrap") {
      await route.fulfill({
        json: { name: "sample-archive", type: "database", canAlias: false, channels: [channel] },
      });
      return;
    }
    if (url.pathname === "/api/channels/C1") {
      await route.fulfill({ json: channel });
      return;
    }
    if (url.pathname === "/api/channels/C1/messages") {
      const before = url.searchParams.get("before");
      const at = url.searchParams.get("at");
      const subset = messages.filter((message) =>
        before ? message.ts < before : at ? message.ts <= at : true,
      );
      const page = subset.slice(-80);
      await route.fulfill({
        json: {
          messages: page,
          hasMore: subset.length > 80,
          nextBefore: subset.length > 80 ? page[0].ts : undefined,
        },
      });
      return;
    }
    if (url.pathname === `/api/channels/C1/threads/${ts(100)}`) {
      await route.fulfill({ json: { root: messages[99], messages: [reply], hasMore: false } });
      return;
    }
    if (url.pathname === "/api/search") {
      await route.fulfill({
        json: { results: [{ channelId: "C1", channelName: "#general", message: reply }] },
      });
      return;
    }
    if (url.pathname === "/api/users/U1") {
      await route.fulfill({
        json: { id: "U1", name: "Ada", avatar: "/static/48x48.gif", title: "Archivist" },
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
  await page.route("**/static/48x48.gif", (route) =>
    route.fulfill({ status: 200, contentType: "image/gif", body: "" }),
  );
});

test("loads older history, keeps the scroll position, and opens a search hit", async ({
  page,
}, testInfo) => {
  const cursors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/channels/C1/messages" && url.searchParams.has("before"))
      cursors.push(url.searchParams.get("before")!);
  });
  await page.goto("/archives/C1");
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
  await expect(page.getByText("message 205")).toBeVisible();
  const scroller = page.getByLabel("Channel messages");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => cursors.length).toBeGreaterThan(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const firstVisible = async () =>
    Number(
      (await page.locator(".message-row:visible").first().textContent())?.match(
        /message (\d+)/,
      )?.[1],
    );
  const savedMessage = await firstVisible();
  await page.getByRole("button", { name: "View Ada's profile" }).first().click();
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
  await expect.poll(async () => Math.abs((await firstVisible()) - savedMessage)).toBeLessThan(3);

  await page.getByRole("searchbox", { name: "Search messages" }).fill("reply body");
  await page.getByRole("button", { name: /reply body/ }).click();
  await expect(page).toHaveURL(new RegExp(`/archives/C1/${ts(100)}#${reply.ts}$`));
  await expect(page.getByLabel("Thread").getByText("reply body")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("viewer.png") });
});

test("opens an older message link and shows its target", async ({ page }) => {
  await page.goto(`/archives/C1#${ts(45)}`);
  await expect(page.getByText("message 45")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByText("message 205")).toBeVisible();
});

test("filters conversations from the mobile sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open conversations" }).click();
  const sidebar = page.getByRole("dialog");
  await sidebar.getByRole("textbox", { name: "Filter conversations" }).fill("general");
  await sidebar.getByRole("link", { name: "general" }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
});

test("sanitizes archived message HTML while preserving file links", async ({ page }) => {
  const malicious = {
    ...messages[0],
    html: '<a href="javascript:alert(1)" onclick="window.__xss=1">unsafe</a><img src="bad" onerror="window.__xss=1"><a href="/slackdump/file/F1/test.txt" download="test.txt">file</a>',
  };
  await page.route("**/api/channels/C1/messages*", (route) =>
    route.fulfill({ json: { messages: [malicious], hasMore: false } }),
  );
  await page.goto("/archives/C1");
  const unsafe = page.locator(".message-content a").filter({ hasText: "unsafe" });
  await expect(unsafe).toBeVisible();
  expect(await unsafe.getAttribute("href")).toBeNull();
  expect(await unsafe.getAttribute("onclick")).toBeNull();
  expect(await page.locator(".message-content img").getAttribute("onerror")).toBeNull();
  await expect(page.locator(".message-content a").filter({ hasText: "file" })).toHaveAttribute(
    "download",
    "test.txt",
  );
  expect(
    await page.evaluate(() => (window as typeof window & { __xss?: number }).__xss),
  ).toBeUndefined();
});

test("switches canvas tabs with the keyboard and keeps its sandbox", async ({ page }) => {
  const withCanvas = { ...channel, canvasPresent: true, canvasAvailable: true };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: { name: "sample-archive", type: "database", canAlias: false, channels: [withCanvas] },
    }),
  );
  await page.route("**/api/channels/C1", (route) => route.fulfill({ json: withCanvas }));
  await page.route("**/archives/C1/canvas/content", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Canvas body</p>" }),
  );
  await page.goto("/archives/C1");
  const messagesTab = page.getByRole("tab", { name: "Messages" });
  await messagesTab.focus();
  await messagesTab.press("ArrowRight");
  await expect(page).toHaveURL(/\/archives\/C1\/canvas$/);
  await expect(page.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-same-origin");
});

test("the thread root scrolls together with replies", async ({ page }) => {
  const longRoot = {
    ...messages[99],
    html: Array.from({ length: 40 }, (_, i) => `<p>Original line ${i}</p>`).join(""),
  };
  await page.route(`**/api/channels/C1/threads/${ts(100)}*`, (route) =>
    route.fulfill({ json: { root: longRoot, messages: [reply], hasMore: false } }),
  );
  await page.goto(`/archives/C1/${ts(100)}`);
  const scroller = page.getByLabel("Thread messages");
  const original = scroller.getByText("Original message");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(original).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(original).not.toBeInViewport();
  await expect(scroller.getByText("reply body")).toBeInViewport();
});

test("clicking an inline image does not download; download is explicit", async ({ page }) => {
  const path = "/slackdump/file/F1/sample.png";
  const imageMessage = {
    ...messages[0],
    html: `<section class="slack-files"><div class="file-preview-container"><img class="file-image" src="${path}" alt="sample.png" width="200" height="120"><div><a class="file-download file-link" href="${path}" download="sample.png" aria-label="Download sample.png">Download image</a></div></div></section>`,
  };
  await page.route("**/api/channels/C1/messages*", (route) =>
    route.fulfill({ json: { messages: [imageMessage], hasMore: false } }),
  );
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nAAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.goto("/archives/C1");
  const image = page.locator(".file-image");
  await expect(image).toBeVisible();
  await image.click();
  expect(downloads).toHaveLength(0);
  await expect(page).toHaveURL(/\/archives\/C1$/);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download sample.png" }).click();
  expect((await download).suggestedFilename()).toBe("sample.png");
});
