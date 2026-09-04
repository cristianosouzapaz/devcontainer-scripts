#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for collecting, validating, and injecting repository configuration.
#>

function Get-TokenVarName {
    <#
    .SYNOPSIS
        Computes the GIT_CLONE_TOKEN_<HOST> variable name for a given repo host.
    .DESCRIPTION
        Normalises the host to uppercase, replacing every non-alphanumeric character
        with "_". Mirrors token_env_var_name in public/scripts/setup/modules/git.sh —
        keep both in sync, since git.sh resolves the same variable name at runtime.
        Example: gitlab.example.com -> GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM
    .PARAMETER RepoHost
        The repo's hostname (e.g. from ([Uri]$url).Host).
    .OUTPUTS
        System.String — the computed environment variable name.
    #>
    param([string]$RepoHost)
    $normalized = ($RepoHost.ToUpperInvariant() -replace '[^A-Z0-9]', '_')
    return "GIT_CLONE_TOKEN_$normalized"
}

function Get-RepoList {
    <#
    .SYNOPSIS
        Interactively collects one or more repository entries from the user.
    .DESCRIPTION
        Prompts for the first repo (mandatory). Then loops asking for additional
        repos until the user submits a blank entry. Each entry is validated with
        Test-RepoEntry, normalised with Resolve-RepoUrl, and checked for
        duplicate folder names (inline warning + re-prompt on collision).
        Repos may span multiple hosts — each host resolves its own clone token
        at runtime via GIT_CLONE_TOKEN_<HOST> (falling back to GIT_CLONE_TOKEN).
        When an accepted repo's host isn't github.com, a hint with the exact
        token variable name to add to .env is printed via Get-TokenVarName.
        For optional repos (repo 2+), a blank response at any point — including
        after a validation warning — terminates the loop and returns the accepted list.
    .OUTPUTS
        System.String[] — array of fully normalised URLs (at least one entry).
    #>
    $acceptedUrls    = [System.Collections.ArrayList]@()
    $acceptedFolders = [System.Collections.Generic.HashSet[string]]@()
    $repoIndex       = 1

    Write-Section "Repository Sources"
    Write-Host "  Accepted formats:" -ForegroundColor $Colors['Info']
    Write-Host "    owner/repo" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "                    GitHub-only shorthand (https://github.com/owner/repo.git)" -ForegroundColor "DarkGray"
    Write-Host "    https://host/owner/repo" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "       full URL without .git - required for any non-GitHub host" -ForegroundColor "DarkGray"
    Write-Host "    https://host/owner/repo.git" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "   full URL with .git - required for any non-GitHub host" -ForegroundColor "DarkGray"
    Write-Host ""
    Write-Host "  Repos on different hosts are allowed; each host resolves its own" -ForegroundColor "DarkGray"
    Write-Host "  GIT_CLONE_TOKEN_<HOST> in your .env (falls back to GIT_CLONE_TOKEN)." -ForegroundColor "DarkGray"
    Write-Host ""

    while ($true) {
        $mandatory = $repoIndex -eq 1
        $prompt    = if ($mandatory) { "Repo $repoIndex" } else { "Repo $repoIndex (blank to finish)" }

        while ($true) {
            $raw = Read-Host $prompt

            if ([string]::IsNullOrWhiteSpace($raw)) {
                if ($mandatory) {
                    Write-Message 'At least one repository is required.' -Level 'Warning'
                    continue
                }
                return @($acceptedUrls.ToArray())
            }

            if (-not (Test-RepoEntry -Entry $raw)) {
                Write-Message "[!] Not a valid repo entry. Use 'owner/repo', 'https://host/owner/repo', or 'https://host/owner/repo.git'." -Level 'Warning'
                continue
            }

            $url        = Resolve-RepoUrl -Entry $raw
            $folderName = _Get-RepoFolderName -Url $url

            if ($acceptedFolders.Contains($folderName)) {
                Write-Message "[!] Folder name '$folderName' is already in use. Re-enter or leave blank to skip." -Level 'Warning'
                continue
            }

            $repoHost = ([Uri]$url).Host
            if ($repoHost -ne 'github.com') {
                $tokenVar = Get-TokenVarName -RepoHost $repoHost
                Write-Message "Non-GitHub host detected ($repoHost) - add '$tokenVar' to your .env (falls back to GIT_CLONE_TOKEN if omitted)." -Level 'Highlight'
            }

            [void]$acceptedUrls.Add($url)
            [void]$acceptedFolders.Add($folderName)
            break
        }

        $repoIndex++
    }
}

function Sort-ComposeVolumeBlock {
    <#
    .SYNOPSIS
        Returns the compose YAML with the entries under the top-level `volumes:` block
        sorted alphabetically by volume name.
    .DESCRIPTION
        The block is the final section of the file: a `volumes:` line at column 0 followed
        by one 2-space-indented `<name>:` line per volume, each optionally followed by
        deeper-indented continuation lines (e.g. `    name: <name>`). Ordering is cosmetic
        (compose ignores it) but kept stable so generated docker-compose.yml diffs stay
        readable and match the alphabetically-sorted mounts array in devcontainer.json.
        Any trailing blank lines are preserved after the sorted block.
    .PARAMETER Content
        The full docker-compose.yml text (LF line endings).
    #>
    param([string]$Content)

    $lines     = [System.Collections.ArrayList]@($Content -split "`n")
    $headerIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -eq 'volumes:') { $headerIdx = $i; break }
    }
    if ($headerIdx -lt 0) { return $Content }

    $head = $lines[0..$headerIdx]
    $rest = if ($headerIdx + 1 -le $lines.Count - 1) { @($lines[($headerIdx + 1)..($lines.Count - 1)]) } else { @() }

    $trailing = [System.Collections.ArrayList]@()
    while ($rest.Count -gt 0 -and $rest[-1] -eq '') {
        [void]$trailing.Insert(0, $rest[-1])
        $rest = if ($rest.Count -gt 1) { @($rest[0..($rest.Count - 2)]) } else { @() }
    }

    $groups  = [System.Collections.ArrayList]@()
    $current = $null
    foreach ($line in $rest) {
        if ($line -match '^  (\S[^:]*):') {
            if ($null -ne $current) { [void]$groups.Add($current) }
            $current = [PSCustomObject]@{ Name = $Matches[1]; Lines = [System.Collections.ArrayList]@($line) }
        } elseif ($null -ne $current) {
            [void]$current.Lines.Add($line)
        }
    }
    if ($null -ne $current) { [void]$groups.Add($current) }
    if ($groups.Count -eq 0) { return $Content }

    $blockLines = foreach ($g in ($groups | Sort-Object { $_.Name })) { $g.Lines }

    return (@($head) + @($blockLines) + @($trailing)) -join "`n"
}

function New-ComposeWithRepoVolumes {
    <#
    .SYNOPSIS
    Transforms the docker-compose.yml template and
        writes the result to the destination .devcontainer folder.
    .DESCRIPTION
        Performs placeholder substitution (project-name → ProjectName), then
        keeps the project workspace volume mounted at /workspace in every mode.
        For every selected entry that declares a named-volume mount
        (source=X,target=Y,type=volume), appends
        a matching top-level volume declaration if one isn't already present in the
        template. This keeps docker-compose.yml's declared volumes in sync with
        whichever optional features were actually selected, instead of requiring
        every such feature to hardcode its volume into the static template.
        For every selected entry that declares a bind mount (source=X,target=Y,type=bind
        — e.g. the Docker socket), appends a matching entry to the primary service's
        volumes list, so the mount is explicit in the generated docker-compose.yml
        instead of relying solely on the devcontainer.json mounts/override mechanism.
        Extra workspace folders are intentionally NOT mounted here — they are only
        added to devcontainer.json's mounts array (see Add-ExtraFolderMountsToConfig),
        so a compose-mode project doesn't get a duplicate bind mount for the same
        host path.
        Uses text manipulation (no YAML parser) against the known fixed template
        structure.
    .PARAMETER TemplateFile
        Absolute path to the source docker-compose.yml template.
    .PARAMETER ProjectName
        Project name to substitute for the placeholder.
    .PARAMETER RepoList
        Array of fully normalised repository URLs.
    .PARAMETER Destination
        Absolute path to the destination folder (the .devcontainer directory).
        The output file is written as docker-compose.yml inside this folder.
    .PARAMETER SelectedEntries
        Array of selected entry objects; entries without a .mount value, or whose
        mount isn't a named volume (type=volume), are ignored.
    .PARAMETER ExtraFolders
        Array of extra workspace folder objects (as returned by Get-ExtraFolderList).
        Only their presence matters here — see .DESCRIPTION for why. Optional —
        when empty, single-repo behaves as before.
    #>
    param([string]$TemplateFile, [string]$ProjectName, [string[]]$RepoList, [string]$Destination, [array]$SelectedEntries = @(), [array]$ExtraFolders = @())

    $content = (Get-Content -Path $TemplateFile -Raw) -replace '\r\n', "`n"
    $content = $content.Replace('project-name', $ProjectName)

    $featureVolumeLines = [System.Collections.ArrayList]@()
    foreach ($e in $SelectedEntries) {
        if ([string]::IsNullOrWhiteSpace($e.mount)) { continue }
        if ($e.mount -notmatch '^source=(?<name>[^,]+),target=[^,]+,type=volume$') { continue }

        $volumeName = $Matches['name']
        if ($content -notmatch "(?m)^  $([regex]::Escape($volumeName)):") {
            [void]$featureVolumeLines.Add("  ${volumeName}:")
            [void]$featureVolumeLines.Add("    name: $volumeName")
        }
    }
    if ($featureVolumeLines.Count -gt 0) {
        $content = $content.TrimEnd("`n") + "`n" + ($featureVolumeLines -join "`n") + "`n"
    }

    $bindMounts = [System.Collections.ArrayList]@()
    foreach ($e in $SelectedEntries) {
        if ([string]::IsNullOrWhiteSpace($e.mount)) { continue }
        if ($e.mount -notmatch '^source=(?<source>[^,]+),target=(?<target>[^,]+),type=bind') { continue }

        $bindLine = "      - $($Matches['source']):$($Matches['target'])"
        if ($content -notmatch [regex]::Escape($bindLine)) {
            [void]$bindMounts.Add($bindLine)
        }
    }
    if ($bindMounts.Count -gt 0) {
        $lines = [System.Collections.ArrayList]@($content -split "`n")

        $match = $lines | Select-String -Pattern "^    container_name: $([regex]::Escape($ProjectName))$" | Select-Object -First 1
        $serviceIdx = if ($match) { $match.LineNumber - 1 } else { $null }
        if ($null -ne $serviceIdx) {
            $volumesIdx = -1
            for ($i = $serviceIdx; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match '^    volumes:$') { $volumesIdx = $i; break }
                if ($lines[$i] -match '^  \S') { break }
            }
            if ($volumesIdx -ge 0) {
                $lastVolumeLineIdx = $volumesIdx
                for ($i = $volumesIdx + 1; $i -lt $lines.Count; $i++) {
                    if ($lines[$i] -match '^      - ') { $lastVolumeLineIdx = $i } else { break }
                }
                $lines.InsertRange($lastVolumeLineIdx + 1, $bindMounts)
                $content = $lines -join "`n"
            }
        }
    }

    $content = Sort-ComposeVolumeBlock -Content $content

    $outputPath = Join-Path -Path $Destination -ChildPath 'docker-compose.yml'
    [System.IO.File]::WriteAllText($outputPath, $content)

    Write-LogEntry "docker-compose.yml generated ($($RepoList.Count) repos)" -Status Success
}

function Resolve-RepoUrl {
    <#
    .SYNOPSIS
        Normalises a user-supplied repo entry to a fully qualified https URL ending in .git.
    .PARAMETER Entry
        One of: owner/repo shorthand, https URL without .git, or full https URL.
    .OUTPUTS
        Normalised URL string, or $null for unrecognised input.
    #>
    param([string]$Entry)

    if ([string]::IsNullOrWhiteSpace($Entry)) { return $null }

    if ($Entry -match '^https://') {
        if ($Entry.EndsWith('.git')) { return $Entry }
        return $Entry + '.git'
    }

    # owner/repo shorthand: no scheme, exactly one slash, no whitespace
    if ($Entry -match '^[^/\s]+/[^/\s]+$') {
        $path = if ($Entry.EndsWith('.git')) { $Entry } else { $Entry + '.git' }
        return "https://github.com/$path"
    }

    return $null
}

function Set-RepoSourcesInConfig {
    <#
    .SYNOPSIS
        Sets the REPO_SOURCE env var(s) in remoteEnv using the REPO_SOURCE_N schema.
    .DESCRIPTION
        Removes the template placeholder key REPO_SOURCE from remoteEnv and writes:
        - Single-repo: one "REPO_SOURCE" key with the full URL.
        - Multi-repo:  "REPO_SOURCE_1", "REPO_SOURCE_2", ... (no bare REPO_SOURCE key).
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER RepoList
        Array of fully normalised repository URLs.
    #>
    param([string]$FilePath, [string[]]$RepoList)

    $updates = @{}
    if ($RepoList.Count -eq 1) {
        $updates['REPO_SOURCE'] = $RepoList[0]
    } else {
        for ($i = 0; $i -lt $RepoList.Count; $i++) {
            $updates["REPO_SOURCE_$($i + 1)"] = $RepoList[$i]
        }
    }

    $config = Read-JsonFile -FilePath $FilePath
    Write-JsonFile -FilePath $FilePath -Config (Update-RemoteEnvInConfig -Config $config -Updates $updates -RemoveKeys @('REPO_SOURCE'))
    Write-LogEntry "REPO_SOURCE set ($($RepoList.Count) repos)" -Status Success
}

function Test-RepoEntry {
    <#
    .SYNOPSIS
        Returns $true if the input is a recognisable repo entry (shorthand or URL).
    .PARAMETER Entry
        Raw user input string.
    #>
    param([string]$Entry)
    if ([string]::IsNullOrWhiteSpace($Entry)) { return $false }
    return $null -ne (Resolve-RepoUrl -Entry $Entry)
}
