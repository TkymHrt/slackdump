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
      const after = url.searchParams.get("after");
      const subset = messages.filter((message) =>
        before ? message.ts < before : after ? message.ts > after : at ? message.ts <= at : true,
      );
      const page = after ? subset.slice(0, 80) : subset.slice(-80);
      const hasNewer = after
        ? subset.length > 80
        : at
          ? messages.some((message) => message.ts > at)
          : false;
      await route.fulfill({
        json: {
          messages: page,
          hasMore: !after && subset.length > 80,
          nextBefore: !after && subset.length > 80 ? page[0].ts : undefined,
          hasNewer,
          nextAfter: hasNewer ? page.at(-1)?.ts || at : undefined,
        },
      });
      return;
    }
    if (url.pathname === `/api/channels/C1/threads/${ts(100)}`) {
      const at = url.searchParams.get("at");
      const after = url.searchParams.get("after");
      const threadMessages = after
        ? reply.ts > after
          ? [reply]
          : []
        : at
          ? reply.ts <= at
            ? [reply]
            : []
          : [reply];
      const hasNewer = !!at && reply.ts > at;
      await route.fulfill({
        json: {
          root: messages[99],
          messages: threadMessages,
          hasMore: false,
          hasNewer,
          nextAfter: hasNewer ? at : undefined,
        },
      });
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

test("loads older history, opens a profile, and opens a search hit", async ({ page }, testInfo) => {
  const cursors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/channels/C1/messages" && url.searchParams.has("before"))
      cursors.push(url.searchParams.get("before")!);
  });
  await page.goto("/archives/C1");
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();
  await expect(page.getByText("message 205")).toBeVisible();
  const scroller = page.getByLabel("チャンネルのメッセージ");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => cursors.length).toBeGreaterThan(0);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Adaのプロフィールを開く" }).first().click();
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(page.getByRole("heading", { name: "#general" })).toBeVisible();

  await page.getByRole("searchbox", { name: "メッセージを検索" }).fill("reply body");
  await page.getByRole("button", { name: /reply body/ }).click();
  await expect(page).toHaveURL(new RegExp(`/archives/C1/${ts(100)}#${reply.ts}$`));
  await expect(page.getByLabel("スレッド").getByText("reply body")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("viewer.png") });
});

test("opens an older message link and shows its target", async ({ page }) => {
  await page.goto(`/archives/C1#${ts(45)}`);
  await expect(page.getByText("message 45")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await page.getByRole("link", { name: "general" }).click();
  await expect(page).toHaveURL(/\/archives\/C1$/);
  await expect(page.getByText("message 205")).toBeVisible();
});

test("filters conversations from the mobile sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "会話一覧を開く" }).click();
  const sidebar = page.getByRole("dialog");
  await sidebar.getByRole("textbox", { name: "会話を絞り込む" }).fill("general");
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
  const messagesTab = page.getByRole("tab", { name: "メッセージ" });
  await messagesTab.focus();
  await messagesTab.press("ArrowRight");
  await expect(page).toHaveURL(/\/archives\/C1\/canvas$/);
  await expect(page.getByRole("tab", { name: "キャンバス" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
  const scroller = page.getByLabel("スレッドのメッセージ");
  const original = scroller.getByText("元の投稿");
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
    html: `<section class="slack-files"><div class="file-preview-container"><img class="file-image" src="${path}" alt="sample.png" width="200" height="120"><div><a class="file-download file-link" href="${path}" download="sample.png" aria-label="sample.pngをダウンロード">画像をダウンロード</a></div></div></section>`,
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
  await page.getByRole("link", { name: "sample.pngをダウンロード" }).click();
  expect((await download).suggestedFilename()).toBe("sample.png");
});

test("an older message link can scroll forward without a latest button", async ({ page }) => {
  await page.goto(`/archives/C1#${ts(45)}`);
  await expect(page.getByText("message 45")).toBeVisible();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  const newer = page.waitForResponse(
    (response) => response.url().includes("/messages?after=") && response.status() === 200,
  );
  const scroller = page.getByLabel("チャンネルのメッセージ");
  await scroller.hover();
  await page.mouse.wheel(0, 600);
  await newer;
  await expect(page.getByText("message 46")).toBeVisible();
  const latest = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("after") === ts(125) && response.status() === 200,
  );
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.mouse.wheel(0, 600);
  await latest;
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("message 205")).toBeVisible();
});

test("a message link before archive history can still scroll forward", async ({ page }) => {
  await page.goto("/archives/C1#1000000000.000001");
  const scroller = page.getByLabel("チャンネルのメッセージ");
  await scroller.hover();
  const newer = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("after") === "1000000000.000001" &&
      response.status() === 200,
    { timeout: 3000 },
  );
  await page.mouse.wheel(0, 600);
  await newer;
  await expect(page.getByText("message 1", { exact: true })).toBeVisible();
});

test("a thread deep link can scroll into newer replies", async ({ page }) => {
  const threadTS = ts(100);
  const stamp = (n: number) => `1710000001.${String(n).padStart(6, "0")}`;
  const replies = Array.from({ length: 205 }, (_, i) => ({
    ...reply,
    ts: stamp(i + 1),
    html: `<p>reply ${i + 1}</p>`,
  }));
  await page.route(`**/api/channels/C1/threads/${threadTS}*`, (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    const at = url.searchParams.get("at");
    const matching = replies.filter((message) =>
      before ? message.ts < before : after ? message.ts > after : at ? message.ts <= at : true,
    );
    const visible = after ? matching.slice(0, 80) : matching.slice(-80);
    const hasNewer = after
      ? matching.length > 80
      : at
        ? replies.some((message) => message.ts > at)
        : false;
    return route.fulfill({
      json: {
        root: messages[99],
        messages: visible,
        hasMore: !after && matching.length > 80,
        nextBefore: !after && matching.length > 80 ? visible[0].ts : undefined,
        hasNewer,
        nextAfter: hasNewer ? visible.at(-1)?.ts || at : undefined,
      },
    });
  });
  await page.goto(`/archives/C1/${threadTS}#${stamp(45)}`);
  await expect(page.getByText("reply 45", { exact: true })).toBeVisible();
  const scroller = page.getByLabel("スレッドのメッセージ");
  const newer = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("after") === stamp(45) && response.status() === 200,
  );
  await scroller.hover();
  await page.mouse.wheel(0, 600);
  await newer;
  await expect(page.getByText("reply 46", { exact: true })).toBeVisible();
});

test("multiple images in one message form a horizontal gallery", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  const previews = Array.from({ length: 3 }, (_, index) => {
    const path = `/slackdump/file/F${index + 1}/picture.png`;
    return `<div class="file-preview-container"><img class="file-image" src="${path}" alt="picture ${index + 1}" width="240" height="140"><div><a class="file-download file-link" href="${path}" download="picture.png">画像をダウンロード</a></div></div>`;
  }).join("");
  await page.route("**/api/channels/C1/messages*", (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            ...messages[0],
            html: `<section class="slack-files"><p>3 files:</p><div class="file-items multi">${previews}</div></section>`,
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.goto("/archives/C1");
  const cards = page.locator(".file-preview-container");
  await expect(cards).toHaveCount(3);
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first && second).toBeTruthy();
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(20);
  expect(second!.x).toBeGreaterThan(first!.x);
  const gallery = page.locator(".file-items");
  await expect(gallery).toBeVisible();
  expect(await gallery.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("a post link can be opened and copied from its message", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/archives/C1");
  const row = page.locator(`article[id="${ts(205)}"]`);
  await row.waitFor();
  const link = row.getByRole("link", { name: "投稿へのリンクを開く" });
  await expect(link).toHaveAttribute("href", `/archives/C1#${ts(205)}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#${ts(205)}$`));
  await row.getByRole("button", { name: "投稿リンクをコピー" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`http://127.0.0.1:5173/archives/C1#${ts(205)}`);
  await expect(
    row.getByRole("button", { name: "投稿リンクをコピー" }).getByText("コピーしました"),
  ).toBeVisible();
});

test("main viewer controls use Japanese labels", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { name: "会話を選択してください" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "メッセージを検索" })).toBeVisible();
  await expect(page.getByRole("region", { name: "チャンネル" })).toBeVisible();
});
