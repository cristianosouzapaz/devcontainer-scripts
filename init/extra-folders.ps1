#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for collecting, validating, and injecting extra workspace folders
    (host-machine folders bind-mounted into the container and added to the
    generated .code-workspace, e.g. a shared notes vault).
#>

function Get-ExtraFolderDevcontainerSource {
    <#
    .SYNOPSIS
        Computes the devcontainer.json mount source for an extra folder.
    .DESCRIPTION
        Absolute Windows paths (e.g. C:\Users\me\vault) and absolute POSIX paths
        (e.g. /srv/data/vault, meant to resolve on a remote Docker host) are used
        as-is. Paths relative to the Windows home are prefixed with
        ${localEnv:USERPROFILE}. Extra folders are only ever mounted through
        devcontainer.json's mounts array — never duplicated as a docker-compose.yml
        volume — so this is the sole source-string builder.
    .PARAMETER Folder
        Extra folder object (as returned by Get-ExtraFolderList).
    .OUTPUTS
        System.String — the devcontainer.json mount source.
    #>
    param($Folder)
    if ($Folder.IsAbsolute) { return $Folder.RawPath }
    return '${localEnv:USERPROFILE}\' + $Folder.RawPath
}

function Resolve-ExtraFolderHostPath {
    <#
    .SYNOPSIS
        Resolves an extra folder's raw input to a concrete path on this host,
        for existence validation only.
    .DESCRIPTION
        Not used to build the generated mount string (Get-ExtraFolderDevcontainerSource
        keeps the ${localEnv:USERPROFILE} placeholder for portability) — only to let
        Test-Path check, on the machine actually running project-init.ps1, whether
        the folder exists.

        Classifies RawPath itself rather than taking the caller's verdict as a
        parameter. The caller has already made that judgement, but passing it in
        as a second argument makes the two separable, and a call that says
        "absolute" of a path that isn't produces a wrong path with no error —
        Join-Path would simply hang it off %USERPROFILE%. One argument, one
        source of truth, nothing to hold wrong.

        Defined only for client-side paths. A path on the Docker daemon's host
        has no counterpart on this machine, so there is no correct value to
        return; being asked for one is a bug in the caller, not bad user input,
        and it throws rather than inventing a Windows path that resolves to
        nothing.
    .PARAMETER RawPath
        The raw path as entered by the user: an absolute Windows path, or one
        relative to the Windows home. Must not be a daemon-side POSIX path.
    .OUTPUTS
        System.String — a concrete path resolvable by Test-Path on this machine.
    #>
    param([string]$RawPath)
    if (Test-DockerHostPath -Path $RawPath) {
        throw "Resolve-ExtraFolderHostPath: '$RawPath' is a Docker-host path and has no equivalent on this machine."
    }
    if ($RawPath -match '^[A-Za-z]:[\\/]') { return $RawPath }
    return Join-Path -Path $env:USERPROFILE -ChildPath $RawPath
}

function Get-ExtraFolderList {
    <#
    .SYNOPSIS
        Interactively collects zero or more extra workspace folders from the user.
    .DESCRIPTION
        Prompts for a host path, then a workspace name, looping until the user
        submits a blank path. Entirely optional — a blank first response returns
        an empty array and leaves the rest of the flow unchanged.
        Each path is auto-detected as absolute — a drive letter (e.g. "C:\..." or
        "C:/...") or a leading "/" for a path on a remote Docker host — or relative
        to the Windows home (%USERPROFILE%). Windows paths (absolute or relative)
        are then checked with Test-Path; a path that doesn't exist on this host is
        rejected with a warning and re-prompted, rather than silently generating a
        mount to an empty auto-created folder. Absolute POSIX paths skip that check
        entirely — they name a folder on the Docker daemon's filesystem, which is
        unverifiable from Windows, and are accepted as typed. The name is validated
        as a filesystem-safe slug and used as both the container mount target
        (/workspace/<name>) and the .code-workspace folder name; it is rejected
        and re-prompted if it duplicates another extra folder's name, the project
        name, or any repo's folder name. These names are reserved beneath the
        shared /workspace root, where the project repository and additional
        repositories are created.
    .PARAMETER ProjectName
        The project name, reserved because single-repo mode creates its repository
        at /workspace/<ProjectName>.
    .PARAMETER RepoList
        Array of fully normalised repository URLs (as returned by Get-RepoList).
        Every repo's folder name is reserved, since it is created at /workspace/<folder>
        in multi-repo mode.
    .OUTPUTS
        Array of ordered hashtables:
        @{ Name = <string>; RawPath = <string>; IsAbsolute = <bool>; IsPosix = <bool> }.
        IsAbsolute covers both an absolute Windows path and a daemon-side POSIX
        one; IsPosix distinguishes the two, so a caller never has to re-parse
        RawPath to recover a classification this function already made.
    #>
    param([string]$ProjectName = '', [string[]]$RepoList = @())

    $accepted      = [System.Collections.ArrayList]@()
    $acceptedNames = [System.Collections.Generic.HashSet[string]]@()
    if (-not [string]::IsNullOrWhiteSpace($ProjectName)) {
        [void]$acceptedNames.Add($ProjectName)
    }
    # Reserved unconditionally — see .DESCRIPTION above.
    foreach ($url in $RepoList) { [void]$acceptedNames.Add((_Get-RepoFolderName -Url $url)) }
    $index = 1

    Write-Section "Extra Workspace Folders"
    Write-Host "  Optional folders from the host machine to mount and include in the" -ForegroundColor "DarkGray"
    Write-Host "  generated .code-workspace. Leave blank to skip." -ForegroundColor "DarkGray"
    Write-Host ""
    Write-Host "  Path formats:" -ForegroundColor $Colors['Info']
    Write-Host "    C:\Users\me\vault" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "          absolute Windows path, used as-is" -ForegroundColor "DarkGray"
    Write-Host "    Documents\vault" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "            relative to your Windows home (%USERPROFILE%)" -ForegroundColor "DarkGray"
    Write-Host "    /srv/data/vault" -NoNewline -ForegroundColor $Colors['Highlight']
    Write-Host "            absolute path on the Docker host, not verified" -ForegroundColor "DarkGray"
    Write-Host ""

    while ($true) {
        $rawPath = Read-Host "Extra folder $index path (blank to finish)"
        if ([string]::IsNullOrWhiteSpace($rawPath)) {
            return @($accepted.ToArray())
        }

        # A path on the Docker daemon's host is absolute, and unverifiable from
        # here, so it skips the Test-Path check below.
        $isPosix    = Test-DockerHostPath -Path $rawPath
        $isAbsolute = $isPosix -or ($rawPath -match '^[A-Za-z]:[\\/]')
        if (-not $isPosix) {
            $hostPath = Resolve-ExtraFolderHostPath -RawPath $rawPath
            if (-not (Test-Path -Path $hostPath -PathType Container)) {
                Write-Message "[!] Folder not found: $hostPath. Re-enter or leave blank to skip." -Level 'Warning'
                continue
            }
        }

        $name = Read-Host "  Name (used as /workspace/<name>)"
        if ([string]::IsNullOrWhiteSpace($name)) {
            Write-Message "[!] Name is required. Entry skipped." -Level 'Warning'
            continue
        }
        if ($name -notmatch '^[a-zA-Z0-9_-]+$') {
            Write-Message "[!] Name must contain only letters, numbers, hyphens and underscores. Entry skipped." -Level 'Warning'
            continue
        }
        if ($acceptedNames.Contains($name)) {
            Write-Message "[!] Name '$name' is already in use. Entry skipped." -Level 'Warning'
            continue
        }

        [void]$accepted.Add([ordered]@{ Name = $name; RawPath = $rawPath; IsAbsolute = $isAbsolute; IsPosix = $isPosix })
        [void]$acceptedNames.Add($name)
        $index++
    }
}
