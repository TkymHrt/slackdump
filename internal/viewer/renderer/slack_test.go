// Copyright (c) 2021-2026 Rustam Gilyazov and Contributors.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package renderer

import (
	"bytes"
	"compress/gzip"
	"context"
	"html/template"
	"io"
	"strings"
	"testing"

	"github.com/rusq/slack"
	"github.com/stretchr/testify/assert"

	"github.com/rusq/slackdump/v4/internal/viewer/renderer/functions"
)

var tmpl = template.Must(template.New("blocks").Funcs(functions.FuncMap).Funcs(template.FuncMap{
	"fileurl": func(id, filename string) string {
		return NewRoutes(ModeLive).File(id, filename)
	},
	"rewriteurl": func(src string) string { return src },
}).ParseFS(templates, "templates/*.html"))

func TestSlack_Render(t *testing.T) {
	nestedLists := loadmsg(t, fxtrMsgNestedLists)
	type args struct {
		m *slack.Message
	}
	tests := []struct {
		name  string
		sm    *Slack
		args  args
		wantV template.HTML
	}{
		{
			"simple message",
			&Slack{
				tmpl: tmpl,
			},
			args{
				m: loadmsg(t, fxtrRtseText),
			},
			template.HTML("New message"),
		},
		{
			"nested lists",
			&Slack{
				tmpl: tmpl,
			},
			args{
				m: nestedLists,
			},
			template.HTML(`Enumerated:<br><ol><li>First (1)</li><li>Second(2)</li></ol><ol><ol><li>Nested (2.a)</li><li>Nested (2.b)</li></ol></ol><ul><ul><ul><li>Nexted bullet point</li></ul></ul></ul><ul><ul><ul><ul><li>Another nested bullet</li></ul></ul></ul></ul><ol><ol><ol><ol><ol><li>Nested enumeration</li></ol></ol></ol></ol></ol>`),
		},
		{
			"template panic",
			&Slack{
				tmpl: tmpl,
			},
			args{
				m: loadmsg(t, fxtrRtseText),
			},
			template.HTML("New message"),
		},
		{
			"started a meeting",
			&Slack{
				tmpl: tmpl,
			},
			args{
				m: loadmsg(t, fxtrStartedAMeeting),
			},
			template.HTML(`<div class="slack-call">(Call)</div><pre class="slack-section-text">Meeting passcode: yyyyy</pre>`),
		},
		{
			"polly message",
			&Slack{
				tmpl: tmpl,
			},
			args{
				m: loadmsg(t, fxtrPolly),
			},
			template.HTML(strings.TrimSpace(ungzip(t, fxtrPollyHTML))),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sm := &Slack{}
			gotV := sm.Render(t.Context(), tt.args.m)
			assert.Equal(t, tt.wantV, gotV)
		})
	}
	t.Run("image preview has a separate download control", func(t *testing.T) {
		sm := NewSlack(template.Must(template.New("base").Parse("")), WithRoutes(NewRoutes(ModeLive)))
		msg := &slack.Message{Msg: slack.Msg{Files: []slack.File{{ID: "F123", Name: "sample.png", Mimetype: "image/png"}}}}
		got := string(sm.Render(t.Context(), msg))
		if strings.Contains(got, `<a href="/slackdump/file/F123/sample.png" target="_blank">`) {
			t.Fatal("clicking an image preview would navigate to a download response")
		}
		if !strings.Contains(got, `class="file-download"`) || !strings.Contains(got, `download="sample.png"`) || !strings.Contains(got, `<svg`) {
			t.Fatal("image preview needs a separate download control")
		}
		if !strings.Contains(got, "添付ファイル 1件") || !strings.Contains(got, `aria-label="sample.pngをダウンロード"`) || !strings.Contains(got, `title="画像をダウンロード"`) {
			t.Fatal("file controls should use Japanese labels")
		}
	})
	t.Run("multiple images share a horizontal gallery", func(t *testing.T) {
		sm := NewSlack(template.Must(template.New("base").Parse("")), WithRoutes(NewRoutes(ModeLive)))
		msg := &slack.Message{Msg: slack.Msg{Files: []slack.File{
			{ID: "F1", Name: "one.png", Mimetype: "image/png"},
			{ID: "F2", Name: "two.png", Mimetype: "image/png"},
		}}}
		got := string(sm.Render(t.Context(), msg))
		if !strings.Contains(got, `class="file-items multi"`) || strings.Count(got, `class="file-preview-container"`) != 2 {
			t.Fatal("multiple image previews should share one gallery")
		}
	})
}

func TestSlack_Render_UsesRouteHelperForFiles(t *testing.T) {
	sm := NewSlack(template.Must(template.New("base").Parse("")), WithRoutes(NewRoutes(ModeStatic)))
	got := string(sm.Render(t.Context(), &slack.Message{Msg: slack.Msg{Files: []slack.File{{ID: "F123", Name: "hello world.txt"}}}}))
	if !strings.Contains(got, `/files/F123/hello%20world.txt`) {
		t.Fatalf("Render() should use static file route, got %q", got)
	}
}

func TestSlack_Render_SanitizesStaticFileRoutes(t *testing.T) {
	sm := NewSlack(template.Must(template.New("base").Parse("")), WithRoutes(NewRoutes(ModeStatic)))
	got := string(sm.Render(t.Context(), &slack.Message{Msg: slack.Msg{Files: []slack.File{{ID: "F123", Name: "a/b:c.txt"}}}}))
	if !strings.Contains(got, `/files/F123/a_b_c.txt`) {
		t.Fatalf("Render() should sanitize static file route, got %q", got)
	}
}

func ungzip(t *testing.T, b []byte) string {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer gr.Close()
	var buf strings.Builder
	if _, err := io.Copy(&buf, gr); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

func TestSlack_renderAttachment(t *testing.T) {
	type fields struct {
		tmpl *template.Template
		uu   map[string]slack.User
		cc   map[string]slack.Channel
	}
	type args struct {
		ctx   context.Context
		buf   *strings.Builder
		msgTS string
		a     slack.Attachment
	}
	tests := []struct {
		name   string
		fields fields
		args   args
	}{
		// TODO: Add test cases.
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Slack{
				tmpl: tt.fields.tmpl,
				uu:   tt.fields.uu,
				cc:   tt.fields.cc,
			}
			s.renderAttachment(tt.args.ctx, tt.args.buf, tt.args.msgTS, tt.args.a)
		})
	}
}
