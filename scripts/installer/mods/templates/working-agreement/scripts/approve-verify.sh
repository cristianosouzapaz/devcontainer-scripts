#!/bin/bash
set -euo pipefail
# Approves a Verify config of the working-agreement mod from the user's own terminal, by the id the mod prints.
#   bash <this file> <config id>   run inside any worktree of the clone
# It shows the config and the change since the clone's last approved config, asks for confirmation on the terminal, and writes
# the same clone-wide approval the mod reads, keyed by the config blob. Without an interactive terminal it refuses and writes
# nothing: an agent's Bash tool, a ! command and piped input have none.

# why: the mod reads a record as an approval only when its content is exactly this
APPROVAL='{"v":1}'

# refuse <message>: prints the refusal and exits without writing anything
refuse() {
	printf 'approve-verify: %s\n' "$1" >&2
	exit 1
}

[[ $# -eq 1 ]] || refuse 'usage: approve-verify.sh <config id>'
id=$1
[[ $id =~ ^[0-9a-fA-F]{7,}$ ]] || refuse "not a config id: $id (seven or more hexadecimal characters)"
[[ -t 0 && -t 1 ]] || refuse 'needs an interactive terminal: run it yourself in your own terminal. Nothing was approved.'
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || refuse 'not inside a git repository'

# why: an id names a config only when exactly one blob of this clone starts with it; another object sharing the prefix is none
declare -a blobs
mapfile -t blobs < <(git rev-parse --disambiguate="${id,,}" 2>/dev/null | git cat-file --batch-check='%(objecttype) %(objectname)' | awk '$1 == "blob" { print $2 }')
((${#blobs[@]})) || refuse "no config $id in this clone"
((${#blobs[@]} == 1)) || refuse "$id names ${#blobs[@]} configs in this clone: give more characters of the id"
blob=${blobs[0]}
records=$common/working-agreement/ok

# why: the change shown is against the newest approval of another config whose content git still holds
last=
last_file=
shopt -s nullglob
for file in "$records"/*.json; do
	name=${file##*/}
	name=${name%.json}
	[[ $name != "$blob" && $(<"$file") == "$APPROVAL" ]] || continue
	git cat-file -e "$name^{blob}" 2>/dev/null || continue
	[[ -z $last_file || $file -nt $last_file ]] || continue
	last=$name
	last_file=$file
done

printf 'Verify config %s:\n\n' "${blob:0:12}"
git cat-file blob "$blob"
if [[ -n $last ]]; then
	printf '\nChange since the last approved config %s:\n\n' "${last:0:12}"
	git --no-pager diff --no-color "$last" "$blob" || true
else
	printf '\nNo other config is approved in this clone.\n'
fi
if [[ -f $records/$blob.json && $(<"$records/$blob.json") == "$APPROVAL" ]]; then
	printf '\nVerify config %s is already approved.\n' "${blob:0:12}"
	exit 0
fi

# why: the answer is read from the terminal itself, never from stdin, which a caller could have redirected
printf '\nApprove this config for every unit of this clone? [y/N] ' >/dev/tty
answer=
read -r answer </dev/tty || true
[[ $answer == [yY] ]] || refuse 'not approved. Nothing was written.'
mkdir -p -- "$records"
temporary=$(mktemp "$records/.$blob.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
printf '%s' "$APPROVAL" >"$temporary"
mv -f -- "$temporary" "$records/$blob.json"
printf 'Verify config %s approved.\n' "${blob:0:12}"
