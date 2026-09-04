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
        Absolute Windows paths (e.g. C:\Users\me\vault) are used as-is. Paths
        relative to the Windows home are prefixed with ${localEnv:USERPROFILE}.
        Extra folders are only ever mounted through devcontainer.json's mounts
        array — never duplicated as a docker-compose.yml volume — so this is the
        sole source-string builder.
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
    .PARAMETER RawPath
        The raw path as entered by the user.
    .PARAMETER IsAbsolute
        Whether RawPath is an absolute Windows path.
    .OUTPUTS
        System.String — a concrete path resolvable by Test-Path on this machine.
    #>
    param([string]$RawPath, [bool]$IsAbsolute)
    if ($IsAbsolute) { return $RawPath }
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
        Each path is auto-detected as absolute (starts with a drive letter, e.g.
        "C:\..." or "C:/...") or relative to the Windows home (%USERPROFILE%), then
        checked with Test-Path; a path that doesn't exist on this host is rejected
        with a warning and re-prompted, rather than silently generating a mount to
        an empty auto-created folder. The name is validated as a filesystem-safe
        slug and used as both the container mount target (/workspace/<name>) and
        the .code-workspace folder name; it is rejected and re-prompted if it
        duplicates another extra folder's name, the project name, or any repo's
        folder name. These names are reserved beneath the shared /workspace root,
        where the project repository and additional repositories are created.
    .PARAMETER ProjectName
        The project name, reserved because single-repo mode creates its repository
        at /workspace/<ProjectName>.
    .PARAMETER RepoList
        Array of fully normalised repository URLs (as returned by Get-RepoList).
        Every repo's folder name is reserved, since it is created at /workspace/<folder>
        in multi-repo mode.
    .OUTPUTS
        Array of ordered hashtables: @{ Name = <string>; RawPath = <string>; IsAbsolute = <bool> }.
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
    Write-Host ""

    while ($true) {
        $rawPath = Read-Host "Extra folder $index path (blank to finish)"
        if ([string]::IsNullOrWhiteSpace($rawPath)) {
            return @($accepted.ToArray())
        }

        $isAbsolute = $rawPath -match '^[A-Za-z]:[\\/]'
        $hostPath   = Resolve-ExtraFolderHostPath -RawPath $rawPath -IsAbsolute $isAbsolute
        if (-not (Test-Path -Path $hostPath -PathType Container)) {
            Write-Message "[!] Folder not found: $hostPath. Re-enter or leave blank to skip." -Level 'Warning'
            continue
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

        [void]$accepted.Add([ordered]@{ Name = $name; RawPath = $rawPath; IsAbsolute = $isAbsolute })
        [void]$acceptedNames.Add($name)
        $index++
    }
}
