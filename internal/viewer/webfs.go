package viewer

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	"github.com/rusq/slackdump/v4/internal/structures"
)

//go:embed web
var webFS embed.FS

func webAssets() fs.FS {
	assets, err := fs.Sub(webFS, "web/assets")
	if err != nil {
		panic(err)
	}
	return assets
}

func (v *Viewer) appHandler(w http.ResponseWriter, r *http.Request) {
	page, err := fs.ReadFile(webFS, "web/index.html")
	if err != nil {
		v.lg.ErrorContext(r.Context(), "read viewer app", "error", err)
		http.Error(w, "viewer unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(page)
}

func (v *Viewer) appChannelHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || isInvalid(id) {
		http.NotFound(w, r)
		return
	}
	if _, ok := v.ch.find(id); !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/canvas") {
		if isHXRequest(r) {
			v.canvasHandler(w, r, id)
			return
		}
		v.appHandler(w, r)
		return
	}
	if isHXRequest(r) {
		v.channelHandler(w, r, id)
		return
	}
	v.appHandler(w, r)
}

func (v *Viewer) appUserHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("user_id")
	if id == "" || isInvalid(id) || v.um[id] == nil {
		http.NotFound(w, r)
		return
	}
	if isHXRequest(r) {
		v.userHandler(w, r)
		return
	}
	v.appHandler(w, r)
}

func (v *Viewer) appPostHandler(w http.ResponseWriter, r *http.Request) {
	id, ts := r.PathValue("id"), r.PathValue("ts")
	if id == "" || isInvalid(id) || ts == "" || isInvalid(ts) {
		http.NotFound(w, r)
		return
	}
	if _, ok := v.ch.find(id); !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(ts, "p") {
		msgTS := structures.ThreadIDtoTS(ts)
		if _, err := apiTimestamp(msgTS); err != nil {
			http.NotFound(w, r)
			return
		}
		if threadTS := r.URL.Query().Get("thread_ts"); threadTS != "" {
			if _, err := apiTimestamp(threadTS); err != nil {
				http.NotFound(w, r)
				return
			}
			http.Redirect(w, r, v.rts.ThreadMessage(id, threadTS, msgTS), http.StatusSeeOther)
		} else {
			http.Redirect(w, r, v.rts.ChannelMessage(id, msgTS), http.StatusSeeOther)
		}
		return
	}
	if _, err := apiTimestamp(ts); err != nil {
		http.NotFound(w, r)
		return
	}
	if isHXRequest(r) {
		v.threadHandler(w, r, id)
		return
	}
	v.appHandler(w, r)
}
