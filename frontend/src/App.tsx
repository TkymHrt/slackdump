import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Hash,
  LockKeyhole,
  Menu,
  Moon,
  Search,
  Sun,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { api, type Bootstrap, type Channel } from "./api";
import MessageList from "./MessageList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function currentLocation() {
  return {
    path: window.location.pathname,
    hash: window.location.hash,
  };
}

function validTimestamp(raw: string) {
  return /^\d{10,}\.\d{6}$/.test(raw) ? raw : undefined;
}

function decodePart(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function useNavigation() {
  const [location, setLocation] = useState(currentLocation);
  useEffect(() => {
    const onPop = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string, options?: { replace?: boolean }) => {
    if (options?.replace) {
      window.history.replaceState(null, "", path);
    } else {
      const current = window.location.pathname + window.location.search + window.location.hash;
      if (path === current) return;
      window.history.pushState({ slackdumpNavigation: true }, "", path);
    }
    setLocation(currentLocation());
  }, []);
  return { location, navigate };
}

function ChannelLink({
  channel,
  selected,
  navigate,
}: {
  channel: Channel;
  selected: boolean;
  navigate: (path: string) => void;
}) {
  const href = `/archives/${encodeURIComponent(channel.id)}`;
  const Icon =
    channel.kind === "private"
      ? LockKeyhole
      : channel.kind === "group" || channel.kind === "dm"
        ? UsersRound
        : Hash;
  return (
    <a
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigate(href);
      }}
      aria-current={selected ? "page" : undefined}
      className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-md px-3 py-1.5 text-[0.87rem] transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-ring lg:min-h-9 ${selected ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-sidebar-foreground/75"}`}
    >
      <Icon className="size-4 shrink-0 opacity-65" aria-hidden="true" />
      <span className="truncate">
        {channel.alias || channel.name.replace(/^(#|@|🔒\s*)/, "").replace(/ \(archived\)$/, "")}
      </span>
      {channel.archived && (
        <Archive className="ml-auto size-3.5 shrink-0 opacity-45" aria-label="アーカイブ済み" />
      )}
    </a>
  );
}

function Sidebar({
  data,
  channelId,
  navigate,
}: {
  data: Bootstrap;
  channelId?: string;
  navigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLocaleLowerCase();
  const groups: { title: string; kinds: Channel["kind"][] }[] = [
    { title: "チャンネル", kinds: ["public", "private"] },
    { title: "ダイレクトメッセージ", kinds: ["group", "dm"] },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-5 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold leading-tight">Slackdump</h1>
          <p className="truncate text-xs text-muted-foreground">{data.name}</p>
        </div>
        <div className="relative mt-5">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="会話を絞り込む"
            placeholder="チャンネル・DMを絞り込む"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="h-11 pl-8 text-sm"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-3 py-5">
          {groups.map((group) => {
            const channels = data.channels.filter(
              (channel) =>
                group.kinds.includes(channel.kind) &&
                (!needle ||
                  `${channel.alias || ""} ${channel.name}`.toLocaleLowerCase().includes(needle)),
            );
            if (!channels.length) return null;
            return (
              <section key={group.title} aria-label={group.title}>
                <div className="mb-2 flex items-center gap-1 px-3 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  <ChevronDown className="size-3.5" />
                  {group.title}
                </div>
                <div className="space-y-0.5">
                  {channels.map((channel) => (
                    <ChannelLink
                      key={channel.id}
                      channel={channel}
                      selected={channel.id === channelId}
                      navigate={navigate}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {needle &&
            !data.channels.some((channel) =>
              `${channel.alias || ""} ${channel.name}`.toLocaleLowerCase().includes(needle),
            ) && <p className="px-3 text-sm text-muted-foreground">該当する会話はありません。</p>}
        </div>
      </ScrollArea>
    </div>
  );
}

function GlobalSearch({
  navigate,
  channelId,
  locationKey,
}: {
  navigate: (path: string) => void;
  channelId?: string;
  locationKey: string;
}) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState(false);
  const [openForLocation, setOpenForLocation] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const showResults = openForLocation === locationKey && input.trim().length >= 2;
  useEffect(() => {
    const id = window.setTimeout(() => setTerm(input.trim()), 250);
    return () => window.clearTimeout(id);
  }, [input]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenForLocation(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setInput("");
        setOpenForLocation(null);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const results = useQuery({
    queryKey: ["search", term, scope ? channelId : "all"],
    queryFn: ({ signal }) => api.search(term, scope ? channelId : undefined, signal),
    enabled: term.length >= 2,
    staleTime: 60_000,
  });
  return (
    <div ref={rootRef} className="relative mx-auto w-full max-w-2xl">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          type="search"
          placeholder="メッセージを検索（/）"
          aria-label="メッセージを検索"
          aria-expanded={showResults}
          aria-controls={showResults ? "global-search-results" : undefined}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setOpenForLocation(locationKey);
          }}
          onFocus={() => setOpenForLocation(locationKey)}
          className="h-11 border-transparent bg-muted/60 pl-9 pr-3 focus-visible:border-ring"
        />
      </div>
      {showResults && (
        <div
          id="global-search-results"
          className="absolute left-0 right-0 top-11 z-30 max-h-[min(70vh,34rem)] overflow-auto rounded-xl border bg-popover p-2 shadow-xl"
          role="region"
          aria-label="検索結果"
        >
          <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
            <span>
              {results.isFetching ? "検索中…" : `${results.data?.results.length || 0}件の結果`}
            </span>
            {channelId && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={scope}
                  onChange={(event) => setScope(event.target.checked)}
                />
                この会話のみ
              </label>
            )}
          </div>
          {results.isError && (
            <p role="alert" className="p-3 text-sm text-destructive">
              検索できませんでした：{results.error.message}
            </p>
          )}
          {results.data?.results.map((result) => {
            const message = result.message;
            const inThread = message.threadTs && message.threadTs !== message.ts;
            const path = `/archives/${encodeURIComponent(result.channelId)}${inThread ? `/${encodeURIComponent(message.threadTs!)}` : ""}#${message.ts}`;
            return (
              <button
                key={`${result.channelId}:${message.ts}`}
                type="button"
                onClick={() => {
                  navigate(path);
                  setInput("");
                  setOpenForLocation(null);
                }}
                className="block w-full rounded-lg px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="block text-xs font-semibold text-primary">
                  {result.channelName}{" "}
                  <span className="font-normal text-muted-foreground">· {message.time}</span>
                </span>
                <span className="mt-0.5 block truncate text-sm">
                  <strong>{message.author}:</strong>{" "}
                  {message.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")}
                </span>
              </button>
            );
          })}
          {results.data && results.data.results.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              一致するメッセージはありません。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelHeader({
  channel,
  navigate,
  canvasActive,
}: {
  channel: Channel;
  navigate: (path: string) => void;
  canvasActive: boolean;
}) {
  const base = `/archives/${encodeURIComponent(channel.id)}`;
  return (
    <div className="shrink-0 border-b bg-background">
      <div className="flex min-h-16 items-center justify-between gap-3 px-5 py-3 sm:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold sm:text-lg">
              {channel.alias || channel.name.replace(/ \(archived\)$/, "")}
            </h2>
            {channel.archived && (
              <span className="text-xs text-muted-foreground">アーカイブ済み</span>
            )}
          </div>
          {channel.topic && (
            <p className="truncate text-xs text-muted-foreground">{channel.topic}</p>
          )}
        </div>
      </div>
      {channel.canvasPresent && (
        <div
          role="tablist"
          aria-label="会話の表示を切り替える"
          className="flex gap-4 px-5 sm:px-8"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]:not(:disabled)',
              ),
            );
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
            if (index < 0 || tabs.length === 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : (index - 1 + tabs.length) % tabs.length;
            tabs[next].click();
            tabs[next].focus();
          }}
        >
          <button
            id="tab-messages"
            type="button"
            role="tab"
            aria-selected={!canvasActive}
            aria-controls="conversation-panel"
            tabIndex={canvasActive ? -1 : 0}
            onClick={() => navigate(base)}
            className={`min-h-11 border-b-2 px-1 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${!canvasActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            メッセージ
          </button>
          <button
            id="tab-canvas"
            type="button"
            role="tab"
            aria-selected={canvasActive}
            aria-controls="canvas-panel"
            aria-describedby={!channel.canvasAvailable ? "canvas-unavailable-hint" : undefined}
            tabIndex={canvasActive ? 0 : -1}
            disabled={!channel.canvasAvailable}
            onClick={() => navigate(`${base}/canvas`)}
            className={`min-h-11 border-b-2 px-1 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40 ${canvasActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Canvas
          </button>
        </div>
      )}
      {channel.canvasPresent && !channel.canvasAvailable && (
        <p id="canvas-unavailable-hint" className="px-5 pb-2 text-xs text-muted-foreground sm:px-8">
          Canvasのファイルは保存されていません。
        </p>
      )}
    </div>
  );
}

function Profile({
  userId,
  navigate,
}: {
  userId: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const user = useQuery({
    queryKey: ["user", userId],
    queryFn: ({ signal }) => api.user(userId, signal),
  });
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6 sm:p-10">
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-8"
        onClick={() => {
          if (window.history.state?.slackdumpNavigation) {
            window.history.back();
          } else {
            navigate("/", { replace: true });
          }
        }}
      >
        <ArrowLeft className="size-4" />
        戻る
      </Button>
      {user.isPending ? (
        <Skeleton className="mt-8 h-40 w-full max-w-md" />
      ) : user.isError ? (
        <p role="alert" className="mt-8 text-destructive">
          {user.error.message}
        </p>
      ) : (
        <div className="mt-8 flex items-start gap-5">
          <img src={user.data.avatar} alt="" className="size-24 rounded-xl bg-muted object-cover" />
          <div>
            <h2 className="text-2xl font-bold">{user.data.name}</h2>
            {user.data.title && <p className="mt-1 text-muted-foreground">{user.data.title}</p>}
            {user.data.email && (
              <a
                className="mt-3 block text-sm text-primary underline"
                href={`mailto:${user.data.email}`}
              >
                {user.data.email}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function applyCanvasTheme(frame: HTMLIFrameElement | null) {
  const canvas = frame?.contentDocument;
  if (!canvas?.body) return;

  // Archived Canvas HTML lives in its own document and cannot inherit the viewer's theme class.
  const viewer = getComputedStyle(document.documentElement);
  const background = viewer.getPropertyValue("--background").trim();
  const foreground = viewer.getPropertyValue("--foreground").trim();
  canvas.documentElement.style.colorScheme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  canvas.documentElement.style.scrollbarColor = viewer.scrollbarColor;
  canvas.documentElement.style.backgroundColor = background;
  canvas.body.style.backgroundColor = background;
  canvas.body.style.color = foreground;
}

function App() {
  const { location, navigate: push } = useNavigation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchJump, setSearchJump] = useState({ path: "", sequence: 0 });
  const canvasFrame = useRef<HTMLIFrameElement>(null);
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem("viewer:theme") === "dark" ||
      (!localStorage.getItem("viewer:theme") && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("viewer:theme", dark ? "dark" : "light");
    applyCanvasTheme(canvasFrame.current);
  }, [dark]);
  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }) => {
      push(path, options);
      setMobileOpen(false);
    },
    [push, setMobileOpen],
  );
  const navigateSearchResult = useCallback(
    (path: string) => {
      navigate(path);
      setSearchJump((jump) => ({ path, sequence: jump.sequence + 1 }));
    },
    [navigate],
  );
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: ({ signal }) => api.bootstrap(signal),
    staleTime: 5 * 60_000,
  });
  const parts = location.path.split("/").filter(Boolean);
  const channelId = parts[0] === "archives" ? decodePart(parts[1] || "") : undefined;
  const userId = parts[0] === "team" ? decodePart(parts[1] || "") : undefined;
  const canvasActive = parts[2] === "canvas";
  const threadTs =
    channelId && parts[2] && !canvasActive ? validTimestamp(decodePart(parts[2])) : undefined;
  const hash = validTimestamp(decodePart(location.hash.replace(/^#/, "")));
  const at = channelId && !threadTs && !canvasActive ? hash : undefined;
  const channel = useQuery({
    queryKey: ["channel", channelId],
    queryFn: ({ signal }) => api.channel(channelId!, signal),
    enabled: !!channelId,
  });

  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      {bootstrap.isSuccess && (
        <aside className="hidden w-64 shrink-0 border-r border-sidebar-border lg:block xl:w-72">
          <Sidebar data={bootstrap.data} channelId={channelId} navigate={navigate} />
        </aside>
      )}
      {bootstrap.isSuccess && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
            <SheetHeader className="sr-only">
              <SheetTitle>会話一覧</SheetTitle>
            </SheetHeader>
            <Sidebar data={bootstrap.data} channelId={channelId} navigate={navigate} />
          </SheetContent>
        </Sheet>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 lg:hidden"
            aria-label="会話一覧を開く"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <GlobalSearch
            navigate={navigateSearchResult}
            channelId={channelId}
            locationKey={`${location.path}${location.hash}`}
          />
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto min-h-11 min-w-11"
            onClick={() => setDark(!dark)}
            aria-label={dark ? "ライトテーマに切り替える" : "ダークテーマに切り替える"}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </header>
        {bootstrap.isPending ? (
          <div className="space-y-4 p-8">
            <Skeleton className="h-8 w-52" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : bootstrap.isError ? (
          <div className="p-8" role="alert">
            <h2 className="font-semibold">アーカイブを開けませんでした</h2>
            <p className="mt-1 text-sm text-destructive">{bootstrap.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => void bootstrap.refetch()}
            >
              再試行
            </Button>
          </div>
        ) : userId ? (
          <Profile userId={userId} navigate={navigate} />
        ) : channelId ? (
          <div className="relative flex min-h-0 flex-1">
            <main className="relative flex min-w-0 flex-1 flex-col">
              {channel.isPending ? (
                <Skeleton className="m-6 h-14" />
              ) : channel.isError ? (
                <p role="alert" className="p-8 text-destructive">
                  {channel.error.message}
                </p>
              ) : (
                <>
                  <div id="channel-heading">
                    <ChannelHeader
                      key={channel.data.id}
                      channel={channel.data}
                      navigate={navigate}
                      canvasActive={canvasActive}
                    />
                  </div>
                  {canvasActive ? (
                    <>
                      {channel.data.canvasPresent && (
                        <div
                          id="conversation-panel"
                          role="tabpanel"
                          aria-labelledby="tab-messages"
                          hidden
                        />
                      )}
                      <div
                        id="canvas-panel"
                        role="tabpanel"
                        aria-labelledby={channel.data.canvasPresent ? "tab-canvas" : undefined}
                        aria-label={channel.data.canvasPresent ? undefined : "Canvas"}
                        tabIndex={0}
                        className="min-h-0 flex-1"
                      >
                        {channel.data.canvasAvailable ? (
                          <iframe
                            ref={canvasFrame}
                            title={`${channel.data.name}のCanvas`}
                            src={`/archives/${encodeURIComponent(channelId)}/canvas/content`}
                            sandbox="allow-same-origin"
                            className="size-full border-0"
                            onLoad={(event) => applyCanvasTheme(event.currentTarget)}
                          />
                        ) : (
                          <p className="p-8 text-sm text-muted-foreground">
                            Canvasを表示するためのファイルが保存されていません。
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {channel.data.canvasPresent && (
                        <div
                          id="canvas-panel"
                          role="tabpanel"
                          aria-labelledby="tab-canvas"
                          hidden
                        />
                      )}
                      <MessageList
                        key={`${channelId}:${at || "latest"}`}
                        channelId={channelId}
                        at={at}
                        jumpRequest={searchJump.sequence}
                        focusSearchResult={searchJump.path === `${location.path}${location.hash}`}
                        navigate={navigate}
                        hasTabs={channel.data.canvasPresent}
                      />
                    </>
                  )}
                </>
              )}
            </main>
            {threadTs && (
              <>
                <Separator orientation="vertical" />
                <aside
                  className="absolute inset-0 z-20 flex flex-col bg-background md:static md:w-[min(42%,28rem)] md:shrink-0"
                  aria-label="スレッド"
                >
                  <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
                    <h2 className="font-semibold">スレッド</h2>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-7"
                      aria-label="スレッドを閉じる"
                      onClick={() => navigate(`/archives/${encodeURIComponent(channelId)}`)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <MessageList
                    key={`${channelId}:${threadTs}:${hash || ""}`}
                    channelId={channelId}
                    threadTs={threadTs}
                    at={hash}
                    jumpRequest={searchJump.sequence}
                    focusSearchResult={searchJump.path === `${location.path}${location.hash}`}
                    navigate={navigate}
                  />
                </aside>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <div className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Hash className="size-8" />
            </div>
            <h2 className="text-xl font-bold">会話を選択してください</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              左の一覧から会話を選ぶか、上の検索欄でメッセージを探してください。
            </p>
            <Button
              variant="outline"
              className="mt-5 min-h-11 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              会話一覧を見る
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
