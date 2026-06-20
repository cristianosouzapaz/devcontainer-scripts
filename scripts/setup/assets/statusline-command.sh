#!/bin/bash

input=$(cat)

reset=$'\033[0m'
dim=$'\033[2m'
bold=$'\033[1m'
orange=$'\033[0;33m'
cyan=$'\033[0;36m'
green=$'\033[0;32m'
yellow=$'\033[0;33m'
red=$'\033[0;31m'
grey=$'\033[0;37m'

# ── Project name ───────────────────────────────────────────────────────────────
project_dir=$(printf '%s' "${input}" | jq -r '.workspace.project_dir // .cwd // empty')
project_name=$(basename "${project_dir}")
project_segment="${dim}${project_name}${reset}"

# ── Git branch ─────────────────────────────────────────────────────────────────
branch=$(git --no-optional-locks -C "${project_dir}" symbolic-ref --short HEAD 2>/dev/null \
         || git --no-optional-locks -C "${project_dir}" rev-parse --short HEAD 2>/dev/null)
if [[ -n "${branch}" ]]; then
    branch_segment="${cyan}⎇ ${branch}${reset}"
else
    branch_segment=""
fi

# ── Model (abbreviated display name) ──────────────────────────────────────────
raw_model=$(printf '%s' "${input}" | jq -r '.model.display_name // empty')
model_label=$(printf '%s' "${raw_model}" | sed 's/^Claude //')
if [[ -n "${model_label}" ]]; then
    model_segment="${orange}${model_label}${reset}"
else
    model_segment=""
fi

# ── Effort (hidden when not configured) ────────────────────────────────────────
effort_level=$(printf '%s' "${input}" | jq -r '.effort.level // empty')
if [[ -n "${effort_level}" ]]; then
    effort_segment="${orange}${effort_level}${reset}"
else
    effort_segment=""
fi

# ── Model + effort combined ────────────────────────────────────────────────────
model_effort_segment=""
if [[ -n "${model_segment}" ]] && [[ -n "${effort_segment}" ]]; then
    model_effort_segment="${model_segment}${dim} · ${reset}${effort_segment}"
elif [[ -n "${model_segment}" ]]; then
    model_effort_segment="${model_segment}"
fi

# ── Context window ─────────────────────────────────────────────────────────────
used_pct=$(printf '%s' "${input}" | jq -r '.context_window.used_percentage // empty')
sep="${dim} | ${reset}"

# Startup state: used_percentage is null — show project, branch, model, effort.
if [[ -z "${used_pct}" ]]; then
    line="${project_segment}"
    [[ -n "${branch_segment}"       ]] && line="${line}  ${branch_segment}"
    [[ -n "${model_effort_segment}" ]] && line="${line}${sep}${model_effort_segment}"
    printf '%s\n' "${line}"
    exit 0
fi

# Round to integer once for comparisons and display.
pct_int=$(printf '%.0f' "${used_pct}")

# Color thresholds: green < 50%, yellow 50–75%, red >= 75%.
if [[ "${pct_int}" -lt 50 ]]; then
    bar_color="${green}"
elif [[ "${pct_int}" -lt 75 ]]; then
    bar_color="${yellow}"
else
    bar_color="${red}"
fi

_BAR_WIDTH=10
filled=$(( (pct_int * _BAR_WIDTH + 50) / 100 ))
[[ "${filled}" -gt "${_BAR_WIDTH}" ]] && filled=${_BAR_WIDTH}
[[ "${filled}" -lt 0 ]] && filled=0
empty=$(( _BAR_WIDTH - filled ))
bar_str=""
for i in $(seq 1 "${filled}"); do bar_str="${bar_str}█"; done
for i in $(seq 1 "${empty}");  do bar_str="${bar_str}░"; done

# Token counts formatted as "48k/200k".
tokens_used=$(printf '%s' "${input}" | jq -r '.context_window.total_input_tokens // empty')
tokens_max=$(printf '%s' "${input}"  | jq -r '.context_window.context_window_size  // empty')
token_label=""
if [[ -n "${tokens_used}" ]] && [[ -n "${tokens_max}" ]]; then
    used_k=$(awk "BEGIN{printf \"%.0fk\", ${tokens_used}/1000}")
    max_k=$(awk  "BEGIN{printf \"%.0fk\", ${tokens_max}/1000}")
    token_label=" ${dim}(${used_k}/${max_k})${reset}"
fi

ctx_segment="${bar_color}▕${bar_str}▏${reset} ${bar_color}${bold}${pct_int}%${reset}${token_label}"

# ── Rate limits ────────────────────────────────────────────────────────────────
five_pct=$(printf '%s' "${input}" | jq -r '.rate_limits.five_hour.used_percentage // empty')
week_pct=$(printf '%s' "${input}" | jq -r '.rate_limits.seven_day.used_percentage // empty')

rate_segment=""
if [[ -n "${five_pct}" ]]; then
    five_val=$(printf '%.0f' "${five_pct}")
    rate_segment="5h:${five_val}%"
fi
if [[ -n "${week_pct}" ]]; then
    week_val=$(printf '%.0f' "${week_pct}")
    [[ -n "${rate_segment}" ]] && rate_segment="${rate_segment} "
    rate_segment="${rate_segment}w:${week_val}%"
fi
if [[ -n "${rate_segment}" ]]; then
    rate_segment="${grey}${rate_segment}${reset}"
fi

# ── Assemble ───────────────────────────────────────────────────────────────────
line="${ctx_segment}${sep}${project_segment}"
[[ -n "${branch_segment}"       ]] && line="${line}  ${branch_segment}"
[[ -n "${model_effort_segment}" ]] && line="${line}${sep}${model_effort_segment}"
[[ -n "${rate_segment}"         ]] && line="${line}${sep}${rate_segment}"

printf '%s\n' "${line}"
