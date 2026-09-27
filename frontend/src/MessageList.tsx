import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import DOMPurify from "dompurify";
import { MessageCircle, ArrowDown, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { api, type Message } from "./api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  channelId: string;
  threadTs?: string;
  at?: string;
  navigate: (path: string) => void;
  getInitialScrollTop?: () => number | undefined;
  onScrollTop?: (top: number) => void;
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

export default function MessageList({
  channelId,
  threadTs,
  at,
  navigate,
  getInitialScrollTop,
  onScrollTop,
  hasTabs,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const pendingPrepend = useRef<{ total: number; top: number } | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["messages", channelId, threadTs || "", at || "latest"],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      threadTs
        ? api.thread(channelId, threadTs, pageParam, at, signal)
        : api.messages(channelId, pageParam, at, signal),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextBefore : undefined),
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const messages = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((page) => page.messages) : []),
    [query.data],
  );
  const root = query.data?.pages[0]?.root;
  const loaderCount = hasNextPage ? 1 : 0;
  const virtualizer = useVirtualizer({
    count: messages.length + loaderCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (loaderCount && index === 0 ? 46 : 104),
    getItemKey: (index) =>
      loaderCount && index === 0 ? "loader" : messages[index - loaderCount]?.ts || index,
    overscan: 8,
  });

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !query.data) return;
    if (pendingPrepend.current) {
      const previous = pendingPrepend.current;
      node.scrollTop = previous.top + virtualizer.getTotalSize() - previous.total;
      pendingPrepend.current = null;
      return;
    }
    if (initialized.current || messages.length === 0) return;
    const initialScrollTop = getInitialScrollTop?.();
    if (initialScrollTop !== undefined) {
      requestAnimationFrame(() => {
        node.scrollTop = initialScrollTop;
        initialized.current = true;
        node.dispatchEvent(new Event("scroll"));
      });
      return;
    }
    const target = at ? messages.findIndex((message) => message.ts === at) : -1;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(
        target >= 0 ? target + loaderCount : messages.length - 1 + loaderCount,
        {
          align: target >= 0 ? "center" : "end",
        },
      );
      initialized.current = true;
      node.dispatchEvent(new Event("scroll"));
    });
  }, [query.data, messages, at, loaderCount, virtualizer, getInitialScrollTop]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const loadOlder = () => {
      if (!initialized.current) return;
      if (node.scrollTop > 350 && node.scrollHeight > node.clientHeight) return;
      pendingPrepend.current = { total: virtualizer.getTotalSize(), top: node.scrollTop };
      void fetchNextPage();
    };
    node.addEventListener("scroll", loadOlder, { passive: true });
    loadOlder();
    return () => node.removeEventListener("scroll", loadOlder);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, messages.length, virtualizer]);

  useEffect(() => {
    if (threadTs) return;
    const node = scrollRef.current;
    if (!node) return;
    const saveAnchor = () => {
      onScrollTop?.(node.scrollTop);
      const first = virtualizer
        .getVirtualItems()
        .find((item) => item.index >= loaderCount && item.end >= node.scrollTop);
      const message = first && messages[first.index - loaderCount];
      if (message) sessionStorage.setItem(`viewer:anchor:${channelId}`, message.ts);
    };
    node.addEventListener("scroll", saveAnchor, { passive: true });
    return () => node.removeEventListener("scroll", saveAnchor);
  }, [channelId, threadTs, messages, loaderCount, virtualizer, onScrollTop]);

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
      {threadTs && root && (
        <div className="shrink-0 border-b bg-muted/30">
          <div className="px-8 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Original message
          </div>
          <MessageRow message={root} channelId={channelId} navigate={navigate} compact />
        </div>
      )}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-label={threadTs ? "Thread replies" : "Channel messages"}
      >
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            No messages in this conversation.
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index - loaderCount];
            const previous = messages[item.index - loaderCount - 1];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {message ? (
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
      {at && !threadTs && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-5 right-5 shadow-md"
          onClick={() => {
            sessionStorage.removeItem(`viewer:anchor:${channelId}`);
            navigate(`/archives/${encodeURIComponent(channelId)}?latest=1`);
          }}
        >
          <ArrowDown className="size-4" />
          Jump to latest
        </Button>
      )}
    </div>
  );
}
