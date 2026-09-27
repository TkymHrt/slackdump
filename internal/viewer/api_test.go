package viewer

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rusq/slack"
	"github.com/rusq/slackdump/v4/source"
)

func testApp(t *testing.T, src *aliasSourceStub) *Viewer {
	t.Helper()
	src.wi = &slack.AuthTestResponse{}
	v, err := New(t.Context(), "", src)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func getApp(t *testing.T, v *Viewer, path string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	v.srv.Handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	return rr
}

func TestViewer_apiMessages(t *testing.T) {
	src := newViewerRouteSource()
	src.msgs["C1"] = nil
	for i := 1; i <= 205; i++ {
		src.msgs["C1"] = append(src.msgs["C1"], slack.Message{Msg: slack.Msg{
			Timestamp: fmt.Sprintf("1710000000.%06d", i), User: "U1", Text: fmt.Sprintf("message %d", i),
		}})
	}
	v := testApp(t, src)
	defer v.Close()

	var first, second, last, newer apiMessagePage
	for _, tc := range []struct {
		path string
		into *apiMessagePage
	}{
		{"/api/channels/C1/messages", &first},
		{"/api/channels/C1/messages?before=1710000000.000126", &second},
		{"/api/channels/C1/messages?at=1710000000.000045", &last},
		{"/api/channels/C1/messages?after=1710000000.000045", &newer},
	} {
		rr := getApp(t, v, tc.path)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s status = %d: %s", tc.path, rr.Code, rr.Body.String())
		}
		if err := json.Unmarshal(rr.Body.Bytes(), tc.into); err != nil {
			t.Fatal(err)
		}
	}
	if len(first.Messages) != 80 || first.Messages[0].TS != "1710000000.000126" || first.Messages[79].TS != "1710000000.000205" || first.NextBefore != first.Messages[0].TS || !first.HasMore {
		t.Fatalf("first page: %+v", first)
	}
	if !strings.Contains(first.Messages[0].HTML, `class="slack-plain-text"`) {
		t.Fatalf("plain message HTML was not marked for readable styling: %q", first.Messages[0].HTML)
	}
	if len(second.Messages) != 80 || second.Messages[0].TS != "1710000000.000046" || second.Messages[79].TS != "1710000000.000125" || !second.HasMore {
		t.Fatalf("second page: first=%+v last=%+v more=%v", second.Messages[0], second.Messages[len(second.Messages)-1], second.HasMore)
	}
	if len(last.Messages) != 45 || last.Messages[44].TS != "1710000000.000045" || last.HasMore {
		t.Fatalf("anchored page: %+v", last)
	}
	if !last.HasNewer || last.NextAfter != "1710000000.000045" || first.HasNewer {
		t.Fatalf("newer cursor state: anchored=%+v latest=%+v", last, first)
	}
	if len(newer.Messages) != 80 {
		t.Fatalf("newer page length = %d, want 80", len(newer.Messages))
	}
	if newer.Messages[0].TS != "1710000000.000046" || newer.Messages[79].TS != "1710000000.000125" {
		t.Fatalf("newer page: first=%+v last=%+v", newer.Messages[0], newer.Messages[len(newer.Messages)-1])
	}
	if !newer.HasNewer || newer.NextAfter != "1710000000.000125" {
		t.Fatalf("newer page cursor: %+v", newer)
	}
	finished := getApp(t, v, "/api/channels/C1/messages?after=1710000000.000125")
	var finalPage apiMessagePage
	if err := json.Unmarshal(finished.Body.Bytes(), &finalPage); err != nil {
		t.Fatal(err)
	}
	if finalPage.HasNewer || len(finalPage.Messages) != 80 || finalPage.Messages[79].TS != "1710000000.000205" {
		t.Fatalf("final newer page: %+v", finalPage)
	}
	for _, path := range []string{
		"/api/channels/C1/messages?before=bad",
		"/api/channels/C1/messages?after=bad",
		"/api/channels/C1/messages?before=1710000000.000001&at=1710000000.000002",
		"/api/channels/C1/messages?before=1710000000.000001&after=1710000000.000002",
	} {
		if rr := getApp(t, v, path); rr.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", path, rr.Code)
		}
	}
	if rr := getApp(t, v, "/api/channels/missing/messages"); rr.Code != http.StatusNotFound {
		t.Fatalf("missing channel status = %d, want 404", rr.Code)
	}
}

func TestViewer_apiBootstrap(t *testing.T) {
	for _, format := range []string{"source_archive", "source_dump_dir", "source_export_dir"} {
		t.Run(format, func(t *testing.T) {
			archivePath := filepath.Join("..", "fixtures", "assets", format)
			src, err := source.Load(t.Context(), archivePath)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			v, err := New(t.Context(), "", src)
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			rr := getApp(t, v, "/api/bootstrap")
			if rr.Code != http.StatusOK {
				t.Fatalf("bootstrap status=%d body=%s", rr.Code, rr.Body.String())
			}
			var data struct {
				Channels []apiChannelData `json:"channels"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
			if len(data.Channels) == 0 {
				t.Fatal("bootstrap returned no channels")
			}
			rr = getApp(t, v, "/api/channels/"+data.Channels[0].ID+"/messages")
			if rr.Code != http.StatusOK {
				t.Fatalf("messages status=%d body=%s", rr.Code, rr.Body.String())
			}
			var page apiMessagePage
			if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			if len(page.Messages) > 1 {
				after := page.Messages[0].TS
				rr = getApp(t, v, "/api/channels/"+data.Channels[0].ID+"/messages?after="+after)
				if rr.Code != http.StatusOK {
					t.Fatalf("newer messages status=%d body=%s", rr.Code, rr.Body.String())
				}
				var newer apiMessagePage
				if err := json.Unmarshal(rr.Body.Bytes(), &newer); err != nil {
					t.Fatal(err)
				}
				if len(newer.Messages) == 0 || newer.Messages[0].TS <= after {
					t.Fatalf("newer page did not advance past cursor")
				}
			}
			rr = getApp(t, v, "/api/search?q=hello")
			if rr.Code != http.StatusOK {
				t.Fatalf("search status=%d body=%s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestViewer_apiThread(t *testing.T) {
	v := testApp(t, newViewerRouteSource())
	defer v.Close()
	rr := getApp(t, v, "/api/channels/C1/threads/1710000000.000001")
	if rr.Code != http.StatusOK {
		t.Fatalf("thread status = %d: %s", rr.Code, rr.Body.String())
	}
	var page apiMessagePage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Root == nil || page.Root.TS != "1710000000.000001" || len(page.Messages) != 1 || page.Messages[0].TS != "1710000001.000001" {
		t.Fatalf("thread page = %+v", page)
	}
	t.Run("forward pagination", func(t *testing.T) {
		src := newViewerRouteSource()
		const threadTS = "1710000000.000001"
		root := src.threads["C1"][threadTS][0]
		thread := []slack.Message{root}
		for i := 1; i <= 205; i++ {
			thread = append(thread, slack.Message{Msg: slack.Msg{Timestamp: fmt.Sprintf("1710000001.%06d", i), ThreadTimestamp: threadTS, Text: "reply"}})
		}
		src.threads["C1"][threadTS] = thread
		viewer := testApp(t, src)
		defer viewer.Close()
		anchored := getApp(t, viewer, "/api/channels/C1/threads/"+threadTS+"?at=1710000001.000045")
		var start apiMessagePage
		if err := json.Unmarshal(anchored.Body.Bytes(), &start); err != nil {
			t.Fatal(err)
		}
		if !start.HasNewer || start.NextAfter != "1710000001.000045" || start.Root == nil {
			t.Fatalf("anchored thread cursor: %+v", start)
		}
		rr := getApp(t, viewer, "/api/channels/C1/threads/"+threadTS+"?after="+start.NextAfter)
		var newer apiMessagePage
		if err := json.Unmarshal(rr.Body.Bytes(), &newer); err != nil {
			t.Fatal(err)
		}
		if len(newer.Messages) != 80 || newer.Messages[0].TS != "1710000001.000046" || newer.Messages[79].TS != "1710000001.000125" || !newer.HasNewer {
			t.Fatalf("newer thread page: %+v", newer)
		}
	})
}

func TestViewer_apiSearch(t *testing.T) {
	v := testApp(t, newViewerRouteSource())
	defer v.Close()
	rr := getApp(t, v, "/api/search?q=reply%20body")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "1710000001.000001") {
		t.Fatalf("search status=%d body=%s", rr.Code, rr.Body.String())
	}
	if rr := getApp(t, v, "/api/search?q="); rr.Code != http.StatusBadRequest {
		t.Fatalf("empty query status = %d", rr.Code)
	}
}

func TestViewer_apiAlias(t *testing.T) {
	src := newViewerRouteSource()
	v := testApp(t, src)
	defer v.Close()
	for _, tc := range []struct {
		body       string
		wantStatus int
		wantAlias  string
	}{
		{`{"alias":"team_docs"}`, http.StatusOK, "team_docs"},
		{`{"alias":"bad alias"}`, http.StatusBadRequest, "team_docs"},
		{`{"alias":""}`, http.StatusOK, ""},
	} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/channels/C1/alias", strings.NewReader(tc.body))
		v.srv.Handler.ServeHTTP(rr, req)
		if rr.Code != tc.wantStatus {
			t.Fatalf("alias update status=%d body=%s", rr.Code, rr.Body.String())
		}
		if got := src.aliases["C1"]; got != tc.wantAlias {
			t.Fatalf("stored alias=%q, want %q", got, tc.wantAlias)
		}
	}
}

func TestViewer_appHandler(t *testing.T) {
	v := testApp(t, newViewerRouteSource())
	defer v.Close()
	for _, path := range []string{"/", "/archives/C1", "/archives/C1/1710000000.000001", "/team/U1", "/archives/C1/canvas"} {
		rr := getApp(t, v, path)
		if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "Slackdump Viewer") {
			t.Fatalf("%s status=%d body=%s", path, rr.Code, rr.Body.String())
		}
	}
	if rr := getApp(t, v, "/archives/unknown"); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown channel status = %d", rr.Code)
	}
	hx := httptest.NewRequest(http.MethodGet, "/archives/C1/canvas", nil)
	hx.Header.Set("HX-Request", "true")
	hxResponse := httptest.NewRecorder()
	v.srv.Handler.ServeHTTP(hxResponse, hx)
	if hxResponse.Code != http.StatusOK || !strings.Contains(hxResponse.Body.String(), `id="tab-panel-canvas"`) {
		t.Fatalf("canvas partial status=%d body=%s", hxResponse.Code, hxResponse.Body.String())
	}
	rr := getApp(t, v, "/archives/C1/p1710000000000001")
	if rr.Code != http.StatusSeeOther || rr.Header().Get("Location") != "/archives/C1#1710000000.000001" {
		t.Fatalf("Slack link redirect status=%d location=%s", rr.Code, rr.Header().Get("Location"))
	}
	files, err := webFS.ReadDir("web/assets")
	if err != nil || len(files) == 0 {
		t.Fatalf("embedded assets: %v", err)
	}
	asset := getApp(t, v, "/assets/"+files[0].Name())
	if asset.Code != http.StatusOK || asset.Body.Len() == 0 {
		t.Fatalf("embedded asset status=%d", asset.Code)
	}
}
