# slack-archive の運用設定

このディレクトリには、slack-archive サーバー固有の設定だけを置く。本家の Go コードと `/usr/bin/slackdump` は変更しない。閲覧用バイナリは `/usr/local/bin/slackdump-viewer` として別に配布する。認証情報はリポジトリに置かない。

| 用途 | サーバー上の場所 |
| --- | --- |
| 取得用DBと添付ファイル | `/srv/slack-dump/archive` |
| 閲覧用DB | `/srv/slack-dump/viewer-archive/slackdump.sqlite` |
| 閲覧用添付ファイル | `/srv/slack-dump/viewer-archive/__uploads` から `/srv/slack-dump/archive/__uploads` へのシンボリックリンク |
| 取得コマンド | `/usr/bin/slackdump`（本家） |
| 閲覧コマンド | `/usr/local/bin/slackdump-viewer`（このフォーク） |

`slack-dump-resume.service` が取得を実行する。サービスが成功終了すると `OnSuccess` により `slack-dump-view-refresh.service` がSQLiteのオンラインバックアップを作り、閲覧用DBを更新する。更新スクリプトは閲覧用DBの旧版を保持し、新版の起動確認に失敗した場合は戻す。MCPの再起動に失敗した場合はログに警告を残し、取得成功後の閲覧用DB更新は続ける。

## 取得間隔

`systemd/slack-dump-resume.timer.d/10-daily.conf` は親タイマーの予定時刻をリセットし、サーバーのローカル時刻で毎日00:15に1回起動する。最大10分のランダム遅延を設け、`Persistent=true` でタイマー停止中やサーバー停止中に逃した実行を補う。実行中に次の時刻が来ても同じサービスは再起動されず、その時刻の実行は積み上がらない。[systemd 255 のタイマー仕様](https://github.com/systemd/systemd/blob/v255/man/systemd.timer.xml)

取得ラッパーは `-threads` により古いスレッドも確認し、`-dedupe` で取得後にDB全体を調べる。頻度を日次にしても各回の所要時間は短くならない。取得範囲や重複整理の頻度を変える場合は、データの取りこぼしと表示への影響を確認して別途決める。

## 管理するファイル

パスはこのディレクトリからの相対パス。既存の `slack-dump-resume.service`、`slack-dump-resume.timer`、`slack-dump-view.service` を前提とし、フォーク固有の設定を drop-in で重ねる。新規サーバー用の元のサービス定義はここに含めない。

| リポジトリ内 | サーバー上 |
| --- | --- |
| `scripts/slack-dump-resume` | `/usr/local/sbin/slack-dump-resume` |
| `scripts/slack-dump-view-refresh` | `/usr/local/sbin/slack-dump-view-refresh` |
| `systemd/slack-dump-resume.timer.d/10-daily.conf` | `/etc/systemd/system/slack-dump-resume.timer.d/10-daily.conf` |
| `systemd/slack-dump-resume.service.d/20-viewer-refresh.conf` | `/etc/systemd/system/slack-dump-resume.service.d/20-viewer-refresh.conf` |
| `systemd/slack-dump-view.service.d/10-fork-viewer.conf` | `/etc/systemd/system/slack-dump-view.service.d/10-fork-viewer.conf` |
| `systemd/slack-dump-view-refresh.service` | `/etc/systemd/system/slack-dump-view-refresh.service` |

閲覧用サービスはスナップショット更新時に再起動する。取得用スクリプトから閲覧用サービスを再起動しない。

## 確認

```bash
systemctl list-timers --all slack-dump-resume.timer --no-pager
systemctl show slack-dump-resume.service -p ActiveState -p Result -p ExecMainStartTimestamp
systemctl show slack-dump-view-refresh.service -p ActiveState -p Result -p ExecMainStartTimestamp
journalctl -u slack-dump-view-refresh.service -n 20 --no-pager
curl --max-time 20 -fsS -o /dev/null -w 'viewer HTTP %{http_code}\n' http://127.0.0.1:8080/
curl --max-time 20 -fsS -o /dev/null -w 'API HTTP %{http_code}\n' http://127.0.0.1:8080/api/bootstrap
```

`Result=success` はサービスの実行中や初回実行前にも表示される。取得完了は `ActiveState=inactive` と合わせて判断し、閲覧用DB更新の実行は `ExecMainStartTimestamp` とログの `viewer snapshot refreshed` で確認する。

## 更新時の分離

本家からの更新は `/usr/bin/slackdump` に取り込み、このディレクトリの設定は維持する。フォークのviewerを更新するときは新しいビルドを `/usr/local/bin/slackdump-viewer` に配置し、閲覧用サービスを再起動する。systemdの設定とサーバー固有のスクリプトは `frontend/deploy/slack-archive/` に閉じているため、本家のコマンド実装に変更を加えない。
