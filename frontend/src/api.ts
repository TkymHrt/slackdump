export type Channel = {
  id: string;
  name: string;
  alias?: string;
  kind: "public" | "private" | "group" | "dm";
  topic?: string;
  archived: boolean;
  canvasPresent: boolean;
  canvasAvailable: boolean;
};

export type Bootstrap = {
  name: string;
  type: string;
  channels: Channel[];
};

export type Message = {
  ts: string;
  userId?: string;
  author: string;
  avatar: string;
  html: string;
  time: string;
  threadTs?: string;
  replyCount?: number;
  latestReply?: string;
  isThreadStart: boolean;
};

export type MessagePage = {
  messages: Message[];
  nextBefore?: string;
  hasMore: boolean;
  nextAfter?: string;
  hasNewer: boolean;
  root?: Message;
};

export type MessageCursor = { before?: string; after?: string; at?: string };

export type User = {
  id: string;
  name: string;
  avatar: string;
  title?: string;
  email?: string;
};

export type SearchResult = {
  channelId: string;
  channelName: string;
  message: Message;
};

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal }).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new Error("ビューワーに接続できません。");
  });
  if (!response.ok) {
    if (response.status === 400) throw new Error("入力内容を確認してください。");
    if (response.status === 404) throw new Error("対象が見つかりません。");
    throw new Error(`操作に失敗しました（HTTP ${response.status}）。`);
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>("/api/bootstrap", signal),
  channel: (id: string, signal?: AbortSignal) =>
    request<Channel>(`/api/channels/${encodeURIComponent(id)}`, signal),
  messages: (id: string, cursor: MessageCursor = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (cursor.before) query.set("before", cursor.before);
    else if (cursor.after) query.set("after", cursor.after);
    else if (cursor.at) query.set("at", cursor.at);
    return request<MessagePage>(
      `/api/channels/${encodeURIComponent(id)}/messages?${query}`,
      signal,
    );
  },
  thread: (id: string, ts: string, cursor: MessageCursor = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (cursor.before) query.set("before", cursor.before);
    else if (cursor.after) query.set("after", cursor.after);
    else if (cursor.at) query.set("at", cursor.at);
    return request<MessagePage>(
      `/api/channels/${encodeURIComponent(id)}/threads/${encodeURIComponent(ts)}?${query}`,
      signal,
    );
  },
  user: (id: string, signal?: AbortSignal) =>
    request<User>(`/api/users/${encodeURIComponent(id)}`, signal),
  search: (query: string, channel?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query });
    if (channel) params.set("channel", channel);
    return request<{ results: SearchResult[] }>(`/api/search?${params}`, signal);
  },
};
