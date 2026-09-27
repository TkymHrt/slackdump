import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Hash,
  LockKeyhole,
  Menu,
  Moon,
  Pencil,
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
    search: window.location.search,
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

function initialAnchors() {
  const anchors = new Map<string, string | undefined>();
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "archives" && parts[1]) {
    const id = decodePart(parts[1]);
    const hash = validTimestamp(decodePart(window.location.hash.slice(1)));
    anchors.set(
      id,
      window.location.search.includes("latest=1")
        ? undefined
        : parts[2]
          ? validTimestamp(sessionStorage.getItem(`viewer:anchor:${id}`) || "")
          : hash || validTimestamp(sessionStorage.getItem(`viewer:anchor:${id}`) || ""),
    );
  }
  return anchors;
}

function useNavigation() {
  const [location, setLocation] = useState(currentLocation);
  useEffect(() => {
    const onPop = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
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
      className={`flex min-w-0 items-center gap-2.5 rounded-md px-3 py-1.5 text-[0.87rem] transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${selected ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-sidebar-foreground/75"}`}
    >
      <Icon className="size-4 shrink-0 opacity-65" aria-hidden="true" />
      <span className="truncate">{channel.alias || channel.name.replace(/^(#|@|🔒\s*)/, "")}</span>
      {channel.archived && (
        <Archive className="ml-auto size-3.5 shrink-0 opacity-45" aria-label="Archived" />
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
    { title: "Channels", kinds: ["public", "private"] },
    { title: "Direct messages", kinds: ["group", "dm"] },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            S
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight">Slackdump</h1>
            <p className="truncate text-xs text-muted-foreground">{data.name}</p>
          </div>
        </div>
        <div className="relative mt-5">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Filter conversations"
            placeholder="Filter conversations"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="h-9 pl-8 text-sm"
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
                  <span className="ml-auto font-normal tracking-normal">{channels.length}</span>
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
            ) && <p className="px-3 text-sm text-muted-foreground">No conversations found.</p>}
        </div>
      </ScrollArea>
      <div className="border-t border-sidebar-border px-5 py-3 text-xs text-muted-foreground">
        {data.channels.length} conversations · {data.type}
      </div>
    </div>
  );
}

function GlobalSearch({
  navigate,
  channelId,
}: {
  navigate: (path: string) => void;
  channelId?: string;
}) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setTerm(input.trim()), 250);
    return () => window.clearTimeout(id);
  }, [input]);
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
    <div className="relative w-full max-w-xl">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          type="search"
          placeholder="Search all messages  /"
          aria-label="Search messages"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="h-9 border-transparent bg-muted/60 pl-9 pr-3 focus-visible:border-ring"
        />
      </div>
      {input.trim().length >= 2 && (
        <div
          className="absolute left-0 right-0 top-11 z-30 max-h-[min(70vh,34rem)] overflow-auto rounded-xl border bg-popover p-2 shadow-xl"
          role="region"
          aria-label="Search results"
        >
          <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
            <span>
              {results.isFetching ? "Searching…" : `${results.data?.results.length || 0} results`}
            </span>
            {channelId && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={scope}
                  onChange={(event) => setScope(event.target.checked)}
                />
                This channel
              </label>
            )}
          </div>
          {results.isError && (
            <p role="alert" className="p-3 text-sm text-destructive">
              Search failed: {results.error.message}
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
            <p className="p-4 text-center text-sm text-muted-foreground">No matching messages.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelHeader({
  channel,
  canAlias,
  navigate,
  canvasActive,
}: {
  channel: Channel;
  canAlias: boolean;
  navigate: (path: string) => void;
  canvasActive: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(channel.alias || "");
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.alias(channel.id, alias),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ["bootstrap"] });
      void client.invalidateQueries({ queryKey: ["channel", channel.id] });
    },
  });
  const base = `/archives/${encodeURIComponent(channel.id)}`;
  return (
    <div className="shrink-0 border-b bg-background">
      <div className="flex min-h-16 items-center justify-between gap-3 px-5 py-3 sm:px-8">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold sm:text-lg">
              {channel.alias || channel.name}
            </h2>
            {canAlias && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Edit channel alias"
                onClick={() => setEditing(!editing)}
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
          </div>
          {channel.topic && (
            <p className="truncate text-xs text-muted-foreground">{channel.topic}</p>
          )}
        </div>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
          className="flex items-center gap-2 border-t bg-muted/30 px-5 py-2 sm:px-8"
        >
          <Input
            aria-label="Channel alias"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            maxLength={30}
            placeholder="Channel alias"
            className="max-w-64"
          />
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {mutation.isError && (
            <span role="alert" className="text-xs text-destructive">
              {mutation.error.message}
            </span>
          )}
        </form>
      )}
      {channel.canvasPresent && (
        <div
          role="tablist"
          aria-label="Channel views"
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
            className={`border-b-2 pb-2 text-sm font-medium ${!canvasActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Messages
          </button>
          <button
            id="tab-canvas"
            type="button"
            role="tab"
            aria-selected={canvasActive}
            aria-controls="canvas-panel"
            tabIndex={canvasActive ? 0 : -1}
            disabled={!channel.canvasAvailable}
            onClick={() => navigate(`${base}/canvas`)}
            className={`border-b-2 pb-2 text-sm font-medium disabled:opacity-40 ${canvasActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Canvas
          </button>
        </div>
      )}
    </div>
  );
}

function Profile({ userId, navigate }: { userId: string; navigate: (path: string) => void }) {
  const user = useQuery({
    queryKey: ["user", userId],
    queryFn: ({ signal }) => api.user(userId, signal),
  });
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6 sm:p-10">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => (window.history.length > 1 ? window.history.back() : navigate("/"))}
      >
        <ArrowLeft className="size-4" />
        Back
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

function App() {
  const { location, navigate: push } = useNavigation();
  const [windowAnchors, setWindowAnchors] = useState(initialAnchors);
  const scrollTops = useRef(new Map<string, number>());
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem("viewer:theme") === "dark" ||
      (!localStorage.getItem("viewer:theme") && matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("viewer:theme", dark ? "dark" : "light");
  }, [dark]);
  const navigate = useCallback(
    (path: string) => {
      const url = new URL(path, window.location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "archives" && parts[1]) {
        const id = decodePart(parts[1]);
        const hash = validTimestamp(decodePart(url.hash.slice(1)));
        if (url.searchParams.get("latest") === "1" || (hash && !parts[2]))
          scrollTops.current.delete(id);
        setWindowAnchors((previous) => {
          const next = new Map(previous);
          if (url.searchParams.get("latest") === "1") {
            next.set(id, undefined);
          } else if (hash && !parts[2]) {
            next.set(id, hash);
          } else if (!next.has(id)) {
            next.set(id, validTimestamp(sessionStorage.getItem(`viewer:anchor:${id}`) || ""));
          }
          return next;
        });
      }
      push(path);
      setMobileOpen(false);
    },
    [push, setMobileOpen],
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
  const at = channelId
    ? windowAnchors.has(channelId)
      ? windowAnchors.get(channelId)
      : validTimestamp(sessionStorage.getItem(`viewer:anchor:${channelId}`) || "")
    : undefined;
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
              <SheetTitle>Conversations</SheetTitle>
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
            className="lg:hidden"
            aria-label="Open conversations"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="hidden min-w-0 items-center gap-2 text-sm font-semibold sm:flex">
            <span className="truncate">{bootstrap.data?.name || "Slackdump"}</span>
            <span className="text-muted-foreground">/</span>
          </div>
          <GlobalSearch navigate={navigate} channelId={channelId} />
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => setDark(!dark)}
            aria-label={dark ? "Use light theme" : "Use dark theme"}
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
            <h2 className="font-semibold">Could not open archive</h2>
            <p className="mt-1 text-sm text-destructive">{bootstrap.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => void bootstrap.refetch()}
            >
              Retry
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
                      canAlias={bootstrap.data.canAlias}
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
                            title={`${channel.data.name} canvas`}
                            src={`/archives/${encodeURIComponent(channelId)}/canvas/content`}
                            sandbox="allow-same-origin"
                            className="size-full border-0"
                          />
                        ) : (
                          <p className="p-8 text-sm text-muted-foreground">
                            Canvas is unavailable because its file was not downloaded.
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
                        navigate={navigate}
                        getInitialScrollTop={() => scrollTops.current.get(channelId)}
                        onScrollTop={(top) => scrollTops.current.set(channelId, top)}
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
                  aria-label="Thread"
                >
                  <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
                    <h2 className="font-semibold">Thread</h2>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close thread"
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
            <h2 className="text-xl font-bold">Your archive, ready to explore</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Choose a conversation from the sidebar, or search across the workspace.
            </p>
            <Button
              variant="outline"
              className="mt-5 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              Browse conversations
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
