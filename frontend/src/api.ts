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
  canAlias: boolean;
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
  root?: Message;
};

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

async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, signal });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>("/api/bootstrap", signal),
  channel: (id: string, signal?: AbortSignal) =>
    request<Channel>(`/api/channels/${encodeURIComponent(id)}`, signal),
  messages: (id: string, cursor?: string, at?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (cursor) query.set("before", cursor);
    else if (at) query.set("at", at);
    return request<MessagePage>(
      `/api/channels/${encodeURIComponent(id)}/messages?${query}`,
      signal,
    );
  },
  thread: (id: string, ts: string, cursor?: string, at?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (cursor) query.set("before", cursor);
    else if (at) query.set("at", at);
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
  alias: (id: string, alias: string) =>
    request<{ alias: string }>(`/api/channels/${encodeURIComponent(id)}/alias`, undefined, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias }),
    }),
};
