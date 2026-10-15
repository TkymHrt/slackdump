# slack-archive の運用設定

このディレクトリには、slack-archive サーバー固有の設定だけを置く。本家の Go コードと `/usr/bin/slackdump` は変更しない。閲覧用バイナリは `/usr/local/bin/slackdump-viewer` として別に配布する。認証情報はリポジトリに置かない。

| 用途 | サーバー上の場所 |
| --- | --- |
| 取得用DBと添付ファイル | `/srv/slack-dump/archive` |
| 閲覧用DB | `/srv/slack-dump/viewer-archive/slackdump.sqlite` |
| 閲覧用添付ファイル | `/srv/slack-dump/viewer-archive/__uploads` から `/srv/slack-dump/archive/__uploads` へのシンボリックリンク |
| 取得コマンド | `/usr/bin/slackdump`（本家） |
| 閲覧コマンド | `/usr/local/bin/slackdump-viewer`（このフォーク） |

`slack-dump-resume.service` が取得を実行する。成功後の `OnSuccess` で `slack-dump-view-refresh.service` がSQLiteのオンラインバックアップを作り、閲覧用DBを更新する。更新スクリプトは Python 3 標準ライブラリだけを使用する。取得ラッパーには `flock`（util-linux）が必要。

取得と更新は `/run/slack-dump-archive.lock` を共有する。更新中は取得用DBを開くMCPを一時停止し、取得直後のMCP再起動とコピーを競合させない。新DBの作成と索引作成は閲覧サービスを動かしたまま行う。索引はSQLiteのメモリ内DBで作成・検査してから、新しいファイルへ書き出す。索引作成中のランダムディスク読み込みを避けるためで、OSのキャッシュを暖めるだけでは本番の索引作成は改善しなかった。メモリ内での処理前に、コンテナの総メモリが「DBファイルサイズの2倍＋128MiB」以上か確認し、不足時は旧DBを維持して失敗する。このサーバーは約1.1GBのDBに対して3GiBを割り当てている。DBが成長したらメモリ容量と工程ログの時間を確認する。

書き出したDBと旧DBの検査も、SQLiteのバックアップAPIでメモリへ順次読み込んでから行う。検査側にも同じメモリ容量確認を適用する。入力の取得用DBに対してマイグレーションや索引作成は行わない。

切り替え時は閲覧サービスを停止し、旧DBをバックアップして別名設定（削除も含む）を新DBへ引き継ぐ。WALのチェックポイント成功とDELETEモードを確認してから、同一ファイルシステム内の `os.replace` で切り替える。旧版は `viewer-archive/slackdump.sqlite.rollback` に保持する。別名はまだ閲覧用DB内に保存する方式であり、別DBへの分離はしていない。

`refresh-pending` を永続化してから切り替え、起動確認成功後に消す。失敗時は旧版へ戻す。強制終了の場合も `ExecStopPost` の `--recover`、または次回更新の冒頭で復旧する。切り替え前の停止も `viewer-restart-pending` に記録し、旧DBの退避中に中断されても旧画面を再開できる。復元や復元後の起動確認に失敗した場合はマーカーを残してエラーにする。停止したMCPの再開要否は `mcp-restart-pending` に保持し、再開失敗はログに残す。

各工程の開始・終了・経過秒数と、バックアップ中の進捗をjournalへ記録する。SQLite操作は各300秒（SQLは進捗コールバックで中断）、起動確認は実経過300秒、systemctl操作は120秒を上限とする。サービス全体の45分は複数工程の合計用で、単独のロック待ちを45分放置する設定ではない。

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

更新スクリプト、取得ラッパー、更新サービス定義は一緒に配置して `systemctl daemon-reload` を実行する。スクリプトは実行権限を付け、LF改行で配置する。サーバー内のシークレットや取得用DBはコピーしない。

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

## 回帰テスト

```sh
python3 -m unittest discover -s frontend/deploy/slack-archive/tests -v
```

テストは一時ディレクトリの実SQLiteファイルを使用し、systemd・HTTP確認・所有者変更を置き換える。別名の保持・削除、WALの取り込み、検査とコピーの時間制限、起動失敗時の復元、中断後の復旧、復元失敗時に起動しないこと、外部WAL読者との競合、MCP再開マーカーの保持、索引作成とメモリ不足時の中止を確認する。

## 2026-10-15 の停止調査

取得用DBは更新されていたが、閲覧用DBは10月5日のままだった。元スクリプトをトレースし、取得用DBのコピー時の `database is locked` と、コピー後の `quick_check` の長時間I/O待ちを再現した。検査で約181MBを読む間に実ディスクから約1.07GBを読み込んでいた。1GiBのコンテナでは約1.1GBのDBをキャッシュできず、日次更新が20分でタイムアウトしていた。

メモリ3GiBと順次読み込みを組み合わせた比較では、約1.1GBの退避コピーに対して事前読み込み8.75秒、`quick_check` 0.5秒で `ok` を確認した。ただし本番更新の索引作成と旧DB検査では、OSのキャッシュだけでは改善しなかった。最終的にSQLiteのメモリ内DBを使用し、索引作成と検査が0.6秒、メモリへの読み込み・ファイルへの書き出しを含めた工程が約22秒で完了した。取得処理の高速化は今回の対象外。

最終版を本番へ配置し、19:06:51〜19:08:04と19:09:44〜19:11:24（JST）の2回、更新全体がそれぞれ約73秒・100秒で成功した。取得用・閲覧用のメッセージ数はともに351,150件、最新メッセージ時刻も `2026-10-14T23:39:02.921339+09:00` で一致し、ブラウザーでも10月の投稿を確認した。Windowsと本番Linuxで回帰テスト13件が成功した。

閲覧サービス・MCP・日次タイマーの稼働を確認して運用を再開した。再開時点の次回取得予定は10月16日00:22:17（JST）。元スクリプト、サービス定義、停止中に退避した閲覧用DBはサーバーの `/srv/slack-dump/recovery-20261015/` に保持している。

## 更新時の分離

本家からの更新は `/usr/bin/slackdump` に取り込み、このディレクトリの設定は維持する。フォークのviewerを更新するときは新しいビルドを `/usr/local/bin/slackdump-viewer` に配置し、閲覧用サービスを再起動する。systemdの設定とサーバー固有のスクリプトは `frontend/deploy/slack-archive/` に閉じているため、本家のコマンド実装に変更を加えない。
