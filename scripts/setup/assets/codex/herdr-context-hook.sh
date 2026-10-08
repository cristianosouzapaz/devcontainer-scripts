#!/bin/bash

# why: no set -e and always exit 0, a Stop hook must never fail or print anything Codex could parse

# Reports this pane's context usage to the Herdr sidebar from the Codex Stop hook payload on
# stdin: the last token_count event of the rollout at transcript_path. A missing transcript or
# field skips the report.

input=$(cat)

# why: outside a Herdr pane there is no sidebar to report to
if [[ "${HERDR_ENV:-}" == "1" ]] && [[ -n "${HERDR_PANE_ID:-}" ]] && command -v herdr >/dev/null 2>&1; then
    transcript=$(printf '%s' "${input}" | jq -r '.transcript_path // empty' 2>/dev/null)
    # why: reading the rollout from the end finds the last event without parsing a long session
    if [[ -n "${transcript}" ]] && [[ -r "${transcript}" ]]; then
        # why: info is null in a token_count event that carries only rate limits
        # why: matches key order and spacing only loosely, jq checks the event itself
        usage=$(tac "${transcript}" 2>/dev/null | grep '"token_count"' \
            | jq -r 'select(.payload.type == "token_count" and .payload.info != null) | .payload.info | "\(.last_token_usage.total_tokens // empty) \(.model_context_window // empty)"' 2>/dev/null | head -n1)
        read -r tokens window <<<"${usage}"
        if [[ "${tokens}" =~ ^[0-9]+$ ]] && [[ "${window}" =~ ^[0-9]+$ ]] && [[ "${window}" -gt 0 ]]; then
            context_token=$(awk -v t="${tokens}" -v w="${window}" 'BEGIN{printf "⛁ %.0f%% (%.0fk)", t/w*100, t/1000}')
            herdr pane report-metadata "${HERDR_PANE_ID}" --source codex-context --token "context=${context_token}" >/dev/null 2>&1
        fi
    fi
fi

exit 0
