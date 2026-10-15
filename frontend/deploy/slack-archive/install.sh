#!/bin/bash
# Install the checked-out deployment files; archive data and binaries stay separate.
set -euo pipefail

if (( EUID != 0 )); then
  echo "run as root" >&2
  exit 1
fi
deploy=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$deploy" rev-parse --show-toplevel)
revision=$(git -C "$repo" rev-parse HEAD)
if [[ -n $(git -C "$repo" status --porcelain -- "$deploy") ]]; then
  echo "deployment checkout has uncommitted changes" >&2
  exit 1
fi
python3 -B -m unittest discover -s "$deploy/tests"

# Do not replace scripts while acquisition or snapshot publication is running.
exec 9>/run/slack-dump-archive.lock
flock -n 9
backup=/srv/slack-dump/deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -m 0700 "$backup"
while read -r source target mode; do
  if [[ -e $target || -L $target ]]; then
    cp -a --parents -- "$target" "$backup/"
  fi
  install -D -m "$mode" -- "$deploy/$source" "$target"
done <<'FILES'
scripts/slack-dump-resume /usr/local/sbin/slack-dump-resume 0755
scripts/slack-dump-view-refresh /usr/local/sbin/slack-dump-view-refresh 0755
systemd/slack-dump-view-refresh.service /etc/systemd/system/slack-dump-view-refresh.service 0644
systemd/slack-dump-view.service.d/10-fork-viewer.conf /etc/systemd/system/slack-dump-view.service.d/10-fork-viewer.conf 0644
systemd/slack-dump-resume.service.d/20-viewer-refresh.conf /etc/systemd/system/slack-dump-resume.service.d/20-viewer-refresh.conf 0644
systemd/slack-dump-resume.timer.d/10-daily.conf /etc/systemd/system/slack-dump-resume.timer.d/10-daily.conf 0644
FILES
systemctl daemon-reload
printf '%s\n' "$revision" > /srv/slack-dump/deployed-revision.next
mv -- /srv/slack-dump/deployed-revision.next /srv/slack-dump/deployed-revision
echo "installed revision=$revision backup=$backup"
