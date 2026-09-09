#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for writing the generated project's VS Code workspace settings.
.DESCRIPTION
    Everything else project-init.ps1 generates lives under .devcontainer/, which
    describes the container. This file writes .vscode/settings.json, which
    describes how the editor on the host reaches that container — a different
    machine and a different concern, so it gets its own module rather than
    riding along in config.ps1.
#>

function Set-DockerContextInSettings {
    <#
    .SYNOPSIS
        Pins the generated project to a named Docker CLI context by writing
        containers.environment.DOCKER_CONTEXT into .vscode/settings.json.
    .DESCRIPTION
        No-op when DockerContext is blank — the generated project stays exactly
        as it is without a Docker context pin. Only DOCKER_CONTEXT is ever
        written, never DOCKER_HOST; the value is used verbatim, unvalidated.

        When settings.json doesn't exist yet, it is created from scratch. When
        it already exists, it is merged non-destructively: every other
        top-level key and every other key already inside containers.environment
        (e.g. a hand-set DOCKER_HOST) survive, only DOCKER_CONTEXT is replaced.
        A destination that already holds a settings.json is not hypothetical —
        Test-DestinationPath accepts an existing folder after confirmation.

        Two independent guards keep a file this function cannot rewrite safely
        byte-identical, warning the user to make the edit by hand instead:

        1. A regex for "//" or "/*" at the start of a line, applied before
           parsing. JSONC comments need catching *before* ConvertFrom-Json, not
           after: it does not reliably reject them, and a parse that succeeds
           and silently drops the comments would delete the user's annotations
           on write. The regex cannot false-positive, because a JSON string
           cannot contain a literal newline — so "//" at the start of a line is
           never inside a string value. It also cannot catch a "// comment"
           trailing a value on the same line; that case still parses and
           reformats, losing the comment. Accepted: the alternative is a JSONC
           parser, which is a dependency this script does not have.
        2. A try/catch around Read-JsonFile, for anything that fails to parse
           outright (a truncated file, a stray trailing comma).
    .PARAMETER Destination
        Absolute path to the destination project folder (not the .devcontainer
        sub-folder) — settings.json lives at <Destination>/.vscode/settings.json.
    .PARAMETER DockerContext
        The Docker context name to pin, or blank/whitespace to no-op.
    #>
    param([string]$Destination, [string]$DockerContext)

    if ([string]::IsNullOrWhiteSpace($DockerContext)) { return }

    $vscodeDir    = Join-Path -Path $Destination -ChildPath ".vscode"
    $settingsPath = Join-Path -Path $vscodeDir -ChildPath "settings.json"

    if (-not (Test-Path -Path $settingsPath -PathType Leaf)) {
        New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null
        Write-JsonFile -FilePath $settingsPath -Config @{ 'containers.environment' = @{ DOCKER_CONTEXT = $DockerContext } }
        Write-LogEntry "Docker context pinned to $DockerContext" -Status Success
        return
    }

    $rawSettings = Get-Content -Path $settingsPath -Raw
    if ($rawSettings -match '(?m)^\s*(//|/\*)') {
        Write-LogEntry "Could not parse $settingsPath (JSONC comments) — add `"containers.environment`": { `"DOCKER_CONTEXT`": `"$DockerContext`" } by hand" -Status Warning
        return
    }

    try {
        $settings = Read-JsonFile -FilePath $settingsPath
    } catch {
        Write-LogEntry "Could not parse $settingsPath — add `"containers.environment`": { `"DOCKER_CONTEXT`": `"$DockerContext`" } by hand" -Status Warning
        return
    }

    $contextEnv = [ordered]@{}
    if ($null -ne $settings.'containers.environment') {
        foreach ($key in $settings.'containers.environment'.PSObject.Properties.Name) {
            $contextEnv[$key] = $settings.'containers.environment'.$key
        }
    }
    $contextEnv['DOCKER_CONTEXT'] = $DockerContext

    $sortedEnv = [ordered]@{}
    foreach ($key in ($contextEnv.Keys | Sort-Object)) { $sortedEnv[$key] = $contextEnv[$key] }

    Write-JsonFile -FilePath $settingsPath -Config (Set-ConfigProperty -Config $settings -Key 'containers.environment' -Value $sortedEnv)
    Write-LogEntry "Docker context pinned to $DockerContext" -Status Success
}
