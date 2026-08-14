#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for collecting, validating, and injecting repository configuration.
#>

function Add-RepoMountsToConfig {
    <#
    .SYNOPSIS
        Appends per-repo volume mount entries to the mounts array in devcontainer.json.
    .DESCRIPTION
        Reads the existing mounts array (already populated by Add-MountsToConfig),
        appends one volume mount per repo, and writes the result back.
        Mount format: source=<project>-<folder>-data,target=/workspace/<folder>,type=volume
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ProjectName
        Project name used to construct volume names.
    .PARAMETER RepoList
        Array of fully normalised repository URLs.
    #>
    param([string]$FilePath, [string]$ProjectName, [string[]]$RepoList)

    $config = Read-JsonFile -FilePath $FilePath
    $mounts = [System.Collections.ArrayList]::new()
    if ($null -ne $config.mounts) {
        @($config.mounts) | ForEach-Object { [void]$mounts.Add($_) }
    }

    foreach ($url in $RepoList) {
        $folder = _Get-RepoFolderName -Url $url
        [void]$mounts.Add("source=$ProjectName-$folder-data,target=/workspace/$folder,type=volume")
    }

    $placeholder  = '__REPO_MOUNTS_ARRAY_PLACEHOLDER__'
    $mountsJson   = ConvertTo-JsonStringArray -Items $mounts.ToArray()
    $sortedConfig = Set-ConfigProperty -Config $config -Key 'mounts' -Value $placeholder
    Write-JsonFile -FilePath $FilePath -Config $sortedConfig -Replacements @{ $placeholder = $mountsJson }
    Write-LogEntry "Repo mounts injected ($($RepoList.Count) repos)" -Status Success
}

function Get-TokenVarName {
    <#
    .SYNOPSIS
        Computes the GIT_CLONE_TOKEN_<HOST> variable name for a given repo host.
    .DESCRIPTION
        Normalises the host to uppercase, replacing every non-alphanumeric character
        with "_". Mirrors token_env_var_name in public/scripts/setup/modules/01-git.sh —
        keep both in sync, since 01-git.sh resolves the same variable name at runtime.
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

function New-ComposeWithRepoVolumes {
    <#
    .SYNOPSIS
        Transforms the docker-compose.yml template to add per-repo volumes and
        writes the result to the destination .devcontainer folder.
    .DESCRIPTION
        Performs placeholder substitution (project-name → ProjectName), then
        handles two distinct layouts depending on repo count:
        - Single-repo: replaces the workspace root volume line with the single
          repo volume (<project>-<folder>-data:/workspace/<folder>), keeping
          the output consistent with standard (non-compose) mode.
        - Multi-repo: preserves the workspace root volume and injects per-repo
          service volume entries and top-level volume declarations for each repo
          immediately after their respective anchor lines.
        Finally, for every selected entry that declares a named-volume mount
        (source=X,target=Y,type=volume — e.g. the GitHub CLI auth volume), appends
        a matching top-level volume declaration if one isn't already present in the
        template. This keeps docker-compose.yml's declared volumes in sync with
        whichever optional features were actually selected, instead of requiring
        every such feature to hardcode its volume into the static template.
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
    #>
    param([string]$TemplateFile, [string]$ProjectName, [string[]]$RepoList, [string]$Destination, [array]$SelectedEntries = @())

    $content = (Get-Content -Path $TemplateFile -Raw) -replace '\r\n', "`n"
    $content = $content.Replace('project-name', $ProjectName)

    if ($RepoList.Count -eq 1) {
        $folder     = _Get-RepoFolderName -Url $RepoList[0]
        $volumeName = "$ProjectName-$folder-data"
        $content    = $content.Replace(
            "      - $ProjectName-workspace:/workspace",
            "      - ${volumeName}:/workspace/$folder"
        )
        $content    = $content.Replace(
            "  $ProjectName-workspace:",
            "  ${volumeName}:"
        )
    } else {
        $lines   = [System.Collections.ArrayList]@($content -split "`n")

        $serviceMarker    = "      - $ProjectName-workspace:/workspace"
        $volumeMarker     = "  $ProjectName-workspace:"
        $serviceInsertIdx = -1
        $volumeInsertIdx  = -1

        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].Contains($serviceMarker)) { $serviceInsertIdx = $i }
            if ($lines[$i].Contains($volumeMarker))  { $volumeInsertIdx  = $i }
        }

        $serviceLines = [System.Collections.ArrayList]@()
        foreach ($url in $RepoList) {
            $folder = _Get-RepoFolderName -Url $url
            [void]$serviceLines.Add("      - $ProjectName-$folder-data:/workspace/$folder")
        }
        if ($serviceInsertIdx -ge 0) {
            $lines.InsertRange($serviceInsertIdx + 1, $serviceLines)
        }

        # Recompute volumeInsertIdx after service line insertions
        $volumeInsertIdx += $serviceLines.Count

        $volumeLines = [System.Collections.ArrayList]@()
        foreach ($url in $RepoList) {
            $folder = _Get-RepoFolderName -Url $url
            [void]$volumeLines.Add("  $ProjectName-$folder-data:")
        }
        if ($volumeInsertIdx -ge 0) {
            $lines.InsertRange($volumeInsertIdx + 1, $volumeLines)
        }

        $content = $lines -join "`n"
    }

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
        All remoteEnv keys are sorted alphabetically. The rest of the config is
        preserved and rewritten via Write-JsonFile.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER RepoList
        Array of fully normalised repository URLs.
    #>
    param([string]$FilePath, [string[]]$RepoList)

    $config = Read-JsonFile -FilePath $FilePath

    $remoteEnv = [ordered]@{}
    foreach ($key in ($config.remoteEnv.PSObject.Properties.Name | Where-Object { $_ -ne 'REPO_SOURCE' } | Sort-Object)) {
        $remoteEnv[$key] = $config.remoteEnv.$key
    }

    if ($RepoList.Count -eq 1) {
        $remoteEnv['REPO_SOURCE'] = $RepoList[0]
    } else {
        for ($i = 0; $i -lt $RepoList.Count; $i++) {
            $remoteEnv["REPO_SOURCE_$($i + 1)"] = $RepoList[$i]
        }
    }

    $sortedRemoteEnv = [ordered]@{}
    foreach ($key in ($remoteEnv.Keys | Sort-Object)) {
        $sortedRemoteEnv[$key] = $remoteEnv[$key]
    }

    Write-JsonFile -FilePath $FilePath -Config (Set-ConfigProperty -Config $config -Key 'remoteEnv' -Value $sortedRemoteEnv)
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

function Test-SameHost {
    <#
    .SYNOPSIS
        Returns $true if all URLs in the list share the same hostname.
    .PARAMETER Urls
        Array of fully normalised repository URLs.
    #>
    param([string[]]$Urls)
    if ($Urls.Count -le 1) { return $true }
    $firstHost = ([Uri]$Urls[0]).Host
    foreach ($url in $Urls[1..($Urls.Count - 1)]) {
        if (([Uri]$url).Host -ne $firstHost) { return $false }
    }
    return $true
}
