import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import DOMPurify from "dompurify";
import { MessageCircle, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { api, type Message, type MessageCursor } from "./api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  channelId: string;
  threadTs?: string;
  at?: string;
  navigate: (path: string) => void;
  hasTabs?: boolean;
};

function MessageRow({
  message,
  channelId,
  navigate,
  compact = false,
}: {
  message: Message;
  channelId: string;
  navigate: (path: string) => void;
  compact?: boolean;
}) {
  const channelPath = `/archives/${encodeURIComponent(channelId)}`;
  const threadPath = `${channelPath}/${encodeURIComponent(message.threadTs || message.ts)}`;
  const messagePath =
    message.threadTs && message.threadTs !== message.ts ? threadPath : channelPath;
  const safeHTML = useMemo(
    () =>
      DOMPurify.sanitize(message.html, {
        ADD_ATTR: ["download"],
        FORBID_ATTR: ["style"],
        SANITIZE_NAMED_PROPS: true,
      }),
    [message.html],
  );
  return (
    <article
      id={message.ts}
      className="message-row group flex gap-3 px-5 py-3 hover:bg-accent/35 sm:px-8"
    >
      <button
        type="button"
        className="relative mt-0.5 size-10 shrink-0 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => message.userId && navigate(`/team/${encodeURIComponent(message.userId)}`)}
        aria-label={`View ${message.author}'s profile`}
        disabled={!message.userId}
      >
        <span
          className="flex size-full items-center justify-center text-sm font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {message.author.charAt(0)}
        </span>
        <img
          src={message.avatar}
          alt=""
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
          <button
            type="button"
            className="font-semibold text-foreground hover:underline disabled:no-underline"
            onClick={() =>
              message.userId && navigate(`/team/${encodeURIComponent(message.userId)}`)
            }
            disabled={!message.userId}
          >
            {message.author}
          </button>
          <a
            className="text-xs text-muted-foreground hover:underline"
            href={`${messagePath}#${message.ts}`}
            title="Link to message"
          >
            {message.time.slice(11, 16)}
          </a>
        </div>
        <div
          className="message-content break-words text-[0.925rem] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: safeHTML }}
        />
        {!compact && message.isThreadStart && (
          <button
            type="button"
            onClick={() => navigate(threadPath)}
            className="mt-2 inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <MessageCircle className="size-4" aria-hidden="true" />
            {message.replyCount || 0} replies
          </button>
        )}
      </div>
    </article>
  );
}

export default function MessageList({ channelId, threadTs, at, navigate, hasTabs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const pendingPrepend = useRef<{ total: number; top: number; rootEnd?: number } | null>(null);
  const pendingAppend = useRef<{ total: number; top: number } | null>(null);
  const lastScrollTop = useRef(0);
  const initialPageParam: MessageCursor = { at };
  const query = useInfiniteQuery({
    queryKey: ["messages", channelId, threadTs || "", at || "latest"],
    initialPageParam,
    queryFn: ({ pageParam, signal }) =>
      threadTs
        ? api.thread(channelId, threadTs, pageParam, signal)
        : api.messages(channelId, pageParam, signal),
    getPreviousPageParam: (firstPage): MessageCursor | undefined =>
      firstPage.hasNewer && firstPage.nextAfter ? { after: firstPage.nextAfter } : undefined,
    getNextPageParam: (lastPage): MessageCursor | undefined =>
      lastPage.hasMore && lastPage.nextBefore ? { before: lastPage.nextBefore } : undefined,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = query;
  const messages = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((page) => page.messages) : []),
    [query.data],
  );
  const root = query.data?.pages[0]?.root;
  const loaderCount = hasNextPage ? 1 : 0;
  const newerLoaderCount = hasPreviousPage ? 1 : 0;
  const rootCount = threadTs && root ? 1 : 0;
  const messageOffset = loaderCount + rootCount;
  const virtualizer = useVirtualizer({
    count: messages.length + messageOffset + newerLoaderCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (loaderCount && index === 0) return 46;
      if (newerLoaderCount && index === messages.length + messageOffset) return 46;
      if (rootCount && index === loaderCount) return 180;
      return 104;
    },
    getItemKey: (index) => {
      if (loaderCount && index === 0) return "loader";
      if (rootCount && index === loaderCount) return `thread-root-${root?.ts}`;
      if (newerLoaderCount && index === messages.length + messageOffset) return "newer-loader";
      return messages[index - messageOffset]?.ts || index;
    },
    overscan: 8,
  });

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !query.data) return;
    if (pendingPrepend.current) {
      const previous = pendingPrepend.current;
      node.scrollTop =
        previous.rootEnd !== undefined && previous.top < previous.rootEnd
          ? previous.top
          : previous.top + virtualizer.getTotalSize() - previous.total;
      lastScrollTop.current = node.scrollTop;
      pendingPrepend.current = null;
      return;
    }
    if (pendingAppend.current) {
      const previous = pendingAppend.current;
      const growth = Math.max(0, virtualizer.getTotalSize() - previous.total);
      node.scrollTop = previous.top + Math.min(growth, 120);
      lastScrollTop.current = node.scrollTop;
      pendingAppend.current = null;
      return;
    }
    if (initialized.current || (messages.length === 0 && !root && !hasPreviousPage)) return;
    const target = at ? messages.findIndex((message) => message.ts === at) : -1;
    const finish = () => {
      lastScrollTop.current = node.scrollTop;
      initialized.current = true;
      node.dispatchEvent(new Event("scroll"));
    };
    if (at && target >= 0) {
      const index = target + messageOffset;
      const align = (attempt: number) => {
        virtualizer.scrollToIndex(index, { align: "center" });
        requestAnimationFrame(() => {
          const row = Array.from(node.querySelectorAll<HTMLElement>("article[id]")).find(
            (element) => element.id === at,
          );
          if (!row && attempt < 5) {
            align(attempt + 1);
            return;
          }
          if (row) {
            const desired = Math.max(0, (node.clientHeight - row.offsetHeight) / 2);
            node.scrollTop +=
              row.getBoundingClientRect().top - node.getBoundingClientRect().top - desired;
          }
          finish();
        });
      };
      requestAnimationFrame(() => align(0));
      return;
    }
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(
        messages.length > 0 ? messages.length - 1 + messageOffset : loaderCount,
        {
          align: messages.length > 0 ? "end" : "start",
        },
      );
      finish();
    });
  }, [query.data, messages, at, loaderCount, messageOffset, root, hasPreviousPage, virtualizer]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !hasPreviousPage || isFetchingPreviousPage) return;
    const loadNewer = () => {
      if (!initialized.current || pendingAppend.current) return;
      if (node.scrollHeight - node.clientHeight - node.scrollTop > 350) return;
      pendingAppend.current = { total: virtualizer.getTotalSize(), top: node.scrollTop };
      void fetchPreviousPage();
    };
    const onScroll = () => {
      const current = node.scrollTop;
      const movingDown = current > lastScrollTop.current + 1;
      lastScrollTop.current = current;
      if (movingDown) loadNewer();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 0) loadNewer();
    };
    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY || 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY || 0;
      if (y < touchY - 2) loadNewer();
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ["ArrowDown", "PageDown", "End"].includes(event.key) ||
        (event.key === " " && !event.shiftKey)
      )
        loadNewer();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, [hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage, virtualizer]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const loadOlder = () => {
      if (!initialized.current) return;
      if (node.scrollTop > 350 && node.scrollHeight > node.clientHeight) return;
      const rootEnd = rootCount
        ? virtualizer.getVirtualItems().find((item) => item.index === loaderCount)?.end
        : undefined;
      pendingPrepend.current = { total: virtualizer.getTotalSize(), top: node.scrollTop, rootEnd };
      void fetchNextPage();
    };
    node.addEventListener("scroll", loadOlder, { passive: true });
    loadOlder();
    return () => node.removeEventListener("scroll", loadOlder);
  }, [
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    messages.length,
    rootCount,
    loaderCount,
    virtualizer,
  ]);

  if (query.isPending) {
    return (
      <div className="space-y-5 p-8" role="status" aria-label="Loading messages">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-10" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="p-8 text-sm text-destructive" role="alert">
        Could not load messages: {query.error.message}{" "}
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      id={hasTabs && !threadTs ? "conversation-panel" : undefined}
      role={hasTabs && !threadTs ? "tabpanel" : undefined}
      aria-labelledby={hasTabs && !threadTs ? "tab-messages" : undefined}
      tabIndex={hasTabs && !threadTs ? 0 : undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-label={threadTs ? "Thread messages" : "Channel messages"}
        tabIndex={0}
      >
        {messages.length === 0 && !root && (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            No messages in this conversation.
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const isRoot = !!rootCount && item.index === loaderCount;
            const isNewerLoader =
              !!newerLoaderCount && item.index === messages.length + messageOffset;
            const message = messages[item.index - messageOffset];
            const previous = messages[item.index - messageOffset - 1];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {isNewerLoader ? (
                  <div className="flex h-11 items-center justify-center gap-2 text-xs text-muted-foreground">
                    {isFetchingPreviousPage && <LoaderCircle className="size-4 animate-spin" />}
                    {isFetchingPreviousPage
                      ? "Loading newer messages"
                      : "Scroll down for newer messages"}
                  </div>
                ) : isRoot && root ? (
                  <div data-thread-root className="border-b bg-muted/30">
                    <div className="px-8 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Original message
                    </div>
                    <MessageRow message={root} channelId={channelId} navigate={navigate} compact />
                  </div>
                ) : message ? (
                  <>
                    {(!previous || previous.time.slice(0, 10) !== message.time.slice(0, 10)) && (
                      <div className="relative my-4 border-t text-center">
                        <span className="relative -top-2.5 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
                          {message.time.slice(0, 10)}
                        </span>
                      </div>
                    )}
                    <MessageRow
                      message={message}
                      channelId={channelId}
                      navigate={navigate}
                      compact={!!threadTs}
                    />
                  </>
                ) : (
                  <div className="flex h-11 items-center justify-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading older messages
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
