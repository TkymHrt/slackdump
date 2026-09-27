package viewer

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"iter"
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/rusq/slack"

	"github.com/rusq/slackdump/v4/internal/structures"
	"github.com/rusq/slackdump/v4/source"
)

const pageSize = 80

var slackTimestamp = regexp.MustCompile(`^[0-9]{10,}\.[0-9]{6}$`)

type apiChannelData struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Alias           string `json:"alias,omitempty"`
	Kind            string `json:"kind"`
	Topic           string `json:"topic,omitempty"`
	Archived        bool   `json:"archived"`
	CanvasPresent   bool   `json:"canvasPresent"`
	CanvasAvailable bool   `json:"canvasAvailable"`
}

type apiMessageData struct {
	TS            string `json:"ts"`
	UserID        string `json:"userId,omitempty"`
	Author        string `json:"author"`
	Avatar        string `json:"avatar"`
	HTML          string `json:"html"`
	Time          string `json:"time"`
	ThreadTS      string `json:"threadTs,omitempty"`
	ReplyCount    int    `json:"replyCount,omitempty"`
	LatestReply   string `json:"latestReply,omitempty"`
	IsThreadStart bool   `json:"isThreadStart"`
}

type apiMessagePage struct {
	Messages   []apiMessageData `json:"messages"`
	NextBefore string           `json:"nextBefore,omitempty"`
	HasMore    bool             `json:"hasMore"`
	Root       *apiMessageData  `json:"root,omitempty"`
}

type pageItem struct {
	key int64
	msg slack.Message
}

type pagedMessagesSource interface {
	PageMessages(ctx context.Context, channelID string, bound int64, inclusive bool, limit int) ([]slack.Message, bool, error)
}

type searchableMessagesSource interface {
	SearchMessages(ctx context.Context, needle, channelID string, limit int, visit func(string, slack.Message) error) error
}

func writeJSON(w http.ResponseWriter, value any) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(value); err != nil {
		http.Error(w, "encode response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(buf.Bytes())
}

func apiTimestamp(raw string) (int64, error) {
	if !slackTimestamp.MatchString(raw) {
		return 0, fmt.Errorf("invalid Slack timestamp")
	}
	n, err := strconv.ParseInt(strings.Replace(raw, ".", "", 1), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid Slack timestamp: %w", err)
	}
	return n, nil
}

func pageBound(r *http.Request) (int64, bool, error) {
	before, at := r.URL.Query().Get("before"), r.URL.Query().Get("at")
	if before != "" && at != "" {
		return 0, false, errors.New("before and at cannot be combined")
	}
	if before != "" {
		n, err := apiTimestamp(before)
		return n, false, err
	}
	if at != "" {
		n, err := apiTimestamp(at)
		return n, true, err
	}
	return int64(^uint64(0) >> 1), false, nil
}

func addPageItem(items []pageItem, item pageItem, limit int) []pageItem {
	if len(items) < limit+1 {
		return append(items, item)
	}
	oldest := 0
	for i := 1; i < len(items); i++ {
		if items[i].key < items[oldest].key {
			oldest = i
		}
	}
	if item.key > items[oldest].key {
		items[oldest] = item
	}
	return items
}

func collectPage(ctx context.Context, seq iter.Seq2[slack.Message, error], bound int64, inclusive bool, limit int, skipTS string) ([]slack.Message, bool, *slack.Message, error) {
	items := make([]pageItem, 0, limit+1)
	var root *slack.Message
	if seq != nil {
		for msg, err := range seq {
			if err != nil {
				return nil, false, nil, err
			}
			if err := ctx.Err(); err != nil {
				return nil, false, nil, err
			}
			if msg.Timestamp == skipTS {
				copy := msg
				root = &copy
				continue
			}
			key, err := apiTimestamp(msg.Timestamp)
			if err != nil || key > bound || (!inclusive && key == bound) {
				continue
			}
			items = addPageItem(items, pageItem{key: key, msg: msg}, limit)
		}
	}
	slices.SortFunc(items, func(a, b pageItem) int { return cmp.Compare(a.key, b.key) })
	hasMore := len(items) > limit
	if hasMore {
		items = items[1:]
	}
	result := make([]slack.Message, 0, len(items))
	for _, item := range items {
		result = append(result, item.msg)
	}
	return result, hasMore, root, nil
}

func (v *Viewer) messageData(ctx context.Context, msg slack.Message) apiMessageData {
	rendered := string(v.r.Render(ctx, &msg))
	if len(msg.Blocks.BlockSet) == 0 {
		rendered = strings.Replace(rendered, "<pre>", `<pre class="slack-plain-text">`, 1)
	}
	return apiMessageData{
		TS:            msg.Timestamp,
		UserID:        msg.User,
		Author:        v.username(msg),
		Avatar:        v.userpic(msg.User),
		HTML:          rendered,
		Time:          localtime(msg.Timestamp),
		ThreadTS:      msg.ThreadTimestamp,
		ReplyCount:    msg.ReplyCount,
		LatestReply:   msg.LatestReply,
		IsThreadStart: structures.IsThreadStart(&msg),
	}
}

func (v *Viewer) channelData(ch slack.Channel, alias string) apiChannelData {
	kind := "public"
	switch structures.ChannelType(ch) {
	case structures.CPrivate:
		kind = "private"
	case structures.CMPIM:
		kind = "group"
	case structures.CIM:
		kind = "dm"
	}
	return apiChannelData{
		ID:            ch.ID,
		Name:          v.um.ChannelName(ch),
		Alias:         alias,
		Kind:          kind,
		Topic:         ch.Topic.Value,
		Archived:      ch.IsArchived,
		CanvasPresent: ch.Properties != nil && ch.Properties.Canvas.FileId != "",
	}
}

func (v *Viewer) requestedChannel(w http.ResponseWriter, r *http.Request) (slack.Channel, bool) {
	id := r.PathValue("id")
	if id == "" || isInvalid(id) {
		http.NotFound(w, r)
		return slack.Channel{}, false
	}
	ch, ok := v.ch.find(id)
	if !ok {
		http.NotFound(w, r)
	}
	return ch, ok
}

func (v *Viewer) apiBootstrap(w http.ResponseWriter, r *http.Request) {
	aliasMap := map[string]string{}
	if a, ok := v.aliaser(); ok {
		aliases, err := a.Aliases()
		if err != nil {
			v.lg.ErrorContext(r.Context(), "aliases", "error", err)
			http.Error(w, "load channels", http.StatusInternalServerError)
			return
		}
		aliasMap = aliases
	}
	channels := make([]apiChannelData, 0, len(v.ch.Public)+len(v.ch.Private)+len(v.ch.MPIM)+len(v.ch.DM))
	for _, group := range [][]slack.Channel{v.ch.Public, v.ch.Private, v.ch.MPIM, v.ch.DM} {
		for _, ch := range group {
			channels = append(channels, v.channelData(ch, aliasMap[ch.ID]))
		}
	}
	writeJSON(w, struct {
		Name     string           `json:"name"`
		Type     string           `json:"type"`
		CanAlias bool             `json:"canAlias"`
		Channels []apiChannelData `json:"channels"`
	}{filepath.Base(v.src.Name()), v.src.Type().String(), v.canAlias(), channels})
}

func (v *Viewer) apiChannel(w http.ResponseWriter, r *http.Request) {
	ch, ok := v.requestedChannel(w, r)
	if !ok {
		return
	}
	if full, err := v.src.ChannelInfo(r.Context(), ch.ID); err == nil && full != nil {
		ch = *full
	} else if err != nil && !errors.Is(err, source.ErrNotFound) && !errors.Is(err, fs.ErrNotExist) {
		v.lg.ErrorContext(r.Context(), "channel info", "error", err)
		http.Error(w, "load channel", http.StatusInternalServerError)
		return
	}
	alias, _, err := v.alias(ch.ID)
	if err != nil {
		v.lg.ErrorContext(r.Context(), "channel alias", "error", err)
		http.Error(w, "load channel", http.StatusInternalServerError)
		return
	}
	data := v.channelData(ch, alias)
	data.CanvasAvailable = canvasAvailable(v.src.Files(), &ch)
	writeJSON(w, data)
}

func (v *Viewer) apiMessages(w http.ResponseWriter, r *http.Request) {
	ch, ok := v.requestedChannel(w, r)
	if !ok {
		return
	}
	bound, inclusive, err := pageBound(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if pager, ok := v.src.(pagedMessagesSource); ok {
		msgs, hasMore, err := pager.PageMessages(r.Context(), ch.ID, bound, inclusive, pageSize)
		if err != nil {
			v.lg.ErrorContext(r.Context(), "page messages", "channel", ch.ID, "error", err)
			http.Error(w, "load messages", http.StatusInternalServerError)
			return
		}
		v.writeMessagePage(w, r, msgs, hasMore, nil)
		return
	}
	seq, err := v.src.AllMessages(r.Context(), ch.ID)
	if errors.Is(err, source.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		seq, err = nil, nil
	}
	if err != nil {
		v.lg.ErrorContext(r.Context(), "load messages", "channel", ch.ID, "error", err)
		http.Error(w, "load messages", http.StatusInternalServerError)
		return
	}
	msgs, hasMore, _, err := collectPage(r.Context(), seq, bound, inclusive, pageSize, "")
	if err != nil {
		v.lg.ErrorContext(r.Context(), "read messages", "channel", ch.ID, "error", err)
		http.Error(w, "read messages", http.StatusInternalServerError)
		return
	}
	v.writeMessagePage(w, r, msgs, hasMore, nil)
}

func (v *Viewer) apiThread(w http.ResponseWriter, r *http.Request) {
	ch, ok := v.requestedChannel(w, r)
	if !ok {
		return
	}
	ts := r.PathValue("ts")
	if _, err := apiTimestamp(ts); err != nil {
		http.Error(w, "invalid thread timestamp", http.StatusBadRequest)
		return
	}
	bound, inclusive, err := pageBound(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	seq, err := v.src.AllThreadMessages(r.Context(), ch.ID, ts)
	if errors.Is(err, source.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		v.lg.ErrorContext(r.Context(), "load thread", "channel", ch.ID, "thread", ts, "error", err)
		http.Error(w, "load thread", http.StatusInternalServerError)
		return
	}
	msgs, hasMore, root, err := collectPage(r.Context(), seq, bound, inclusive, pageSize, ts)
	if err != nil {
		v.lg.ErrorContext(r.Context(), "read thread", "channel", ch.ID, "thread", ts, "error", err)
		http.Error(w, "read thread", http.StatusInternalServerError)
		return
	}
	v.writeMessagePage(w, r, msgs, hasMore, root)
}

func (v *Viewer) writeMessagePage(w http.ResponseWriter, r *http.Request, msgs []slack.Message, hasMore bool, root *slack.Message) {
	page := apiMessagePage{Messages: make([]apiMessageData, 0, len(msgs)), HasMore: hasMore}
	for _, msg := range msgs {
		page.Messages = append(page.Messages, v.messageData(r.Context(), msg))
	}
	if hasMore && len(msgs) > 0 {
		page.NextBefore = msgs[0].Timestamp
	}
	if root != nil {
		data := v.messageData(r.Context(), *root)
		page.Root = &data
	}
	writeJSON(w, page)
}

func (v *Viewer) apiUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || isInvalid(id) {
		http.NotFound(w, r)
		return
	}
	u := v.um[id]
	if u == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
		Title  string `json:"title,omitempty"`
		Email  string `json:"email,omitempty"`
	}{u.ID, v.um.DisplayName(id), v.userpic(id), u.Profile.Title, u.Profile.Email})
}

func (v *Viewer) apiSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len([]rune(q)) > 160 {
		http.Error(w, "q must contain 1 to 160 characters", http.StatusBadRequest)
		return
	}
	needle := strings.ToLower(q)
	groups := [][]slack.Channel{v.ch.Public, v.ch.Private, v.ch.MPIM, v.ch.DM}
	selected := r.URL.Query().Get("channel")
	if selected != "" {
		ch, ok := v.ch.find(selected)
		if !ok {
			http.NotFound(w, r)
			return
		}
		groups = [][]slack.Channel{{ch}}
	}
	type hit struct {
		channel slack.Channel
		item    pageItem
	}
	hits := make([]hit, 0, 51)
	addHit := func(ch slack.Channel, msg *slack.Message) error {
		if err := r.Context().Err(); err != nil {
			return err
		}
		if !strings.Contains(strings.ToLower(msg.Text), needle) {
			return nil
		}
		key, err := apiTimestamp(msg.Timestamp)
		if err != nil {
			return nil
		}
		for _, h := range hits {
			if h.channel.ID == ch.ID && h.item.msg.Timestamp == msg.Timestamp {
				return nil
			}
		}
		if len(hits) < 50 {
			hits = append(hits, hit{ch, pageItem{key, *msg}})
			return nil
		}
		oldest := 0
		for i := 1; i < len(hits); i++ {
			if hits[i].item.key < hits[oldest].item.key {
				oldest = i
			}
		}
		if key > hits[oldest].item.key {
			hits[oldest] = hit{ch, pageItem{key, *msg}}
		}
		return nil
	}
	if fast, ok := v.src.(searchableMessagesSource); ok {
		err := fast.SearchMessages(r.Context(), q, selected, 50, func(id string, msg slack.Message) error {
			ch, found := v.ch.find(id)
			if !found {
				return nil
			}
			return addHit(ch, &msg)
		})
		if err != nil {
			v.lg.ErrorContext(r.Context(), "search messages", "error", err)
			http.Error(w, "search messages", http.StatusInternalServerError)
			return
		}
	} else {
		for _, group := range groups {
			for _, ch := range group {
				err := v.searchChannel(r.Context(), ch, addHit)
				if err != nil && !errors.Is(err, source.ErrNotFound) && !errors.Is(err, fs.ErrNotExist) {
					v.lg.ErrorContext(r.Context(), "search messages", "channel", ch.ID, "error", err)
					http.Error(w, "search messages", http.StatusInternalServerError)
					return
				}
			}
		}
	}
	slices.SortFunc(hits, func(a, b hit) int { return cmp.Compare(b.item.key, a.item.key) })
	type apiHit struct {
		ChannelID   string         `json:"channelId"`
		ChannelName string         `json:"channelName"`
		Message     apiMessageData `json:"message"`
	}
	results := make([]apiHit, 0, len(hits))
	for _, h := range hits {
		results = append(results, apiHit{h.channel.ID, v.um.ChannelName(h.channel), v.messageData(r.Context(), h.item.msg)})
	}
	writeJSON(w, struct {
		Results []apiHit `json:"results"`
	}{results})
}

func (v *Viewer) searchChannel(ctx context.Context, ch slack.Channel, visit func(slack.Channel, *slack.Message) error) error {
	seq, err := v.src.AllMessages(ctx, ch.ID)
	if err != nil || seq == nil {
		return err
	}
	for msg, err := range seq {
		if err != nil {
			return err
		}
		if err := visit(ch, &msg); err != nil {
			return err
		}
		if !structures.IsThreadStart(&msg) {
			continue
		}
		thread, err := v.src.AllThreadMessages(ctx, ch.ID, msg.Timestamp)
		if errors.Is(err, source.ErrNotFound) || errors.Is(err, source.ErrNotSupported) || errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if thread == nil {
			continue
		}
		for reply, err := range thread {
			if err != nil {
				return err
			}
			if err := visit(ch, &reply); err != nil {
				return err
			}
		}
	}
	return nil
}

func (v *Viewer) apiAlias(w http.ResponseWriter, r *http.Request) {
	ch, ok := v.requestedChannel(w, r)
	if !ok {
		return
	}
	a, ok := v.aliaser()
	if !ok {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var body struct {
		Alias string `json:"alias"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	alias, action, err := validateAlias(body.Alias)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if action == aliasDelete {
		err = a.DeleteAlias(ch.ID)
	} else {
		err = a.SetAlias(ch.ID, alias)
	}
	if err != nil {
		v.lg.ErrorContext(r.Context(), "save alias", "channel", ch.ID, "error", err)
		http.Error(w, "save alias", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct {
		Alias string `json:"alias"`
	}{alias})
}
