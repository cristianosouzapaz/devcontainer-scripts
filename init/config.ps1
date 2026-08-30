#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for transforming and writing devcontainer configuration files.
#>

function Add-FeaturesToConfig {
    <#
    .SYNOPSIS
        Injects the selected devcontainer features into devcontainer.json.
    .DESCRIPTION
        Builds an ordered features object keyed by feature URL (sorted for deterministic
        output), merges it back into the config with all keys alphabetically sorted,
        and overwrites the file with pretty-printed JSON.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER SelectedEntries
        Array of selected entry objects; entries without a .feature property are ignored.
    #>
    param([string]$FilePath, [array]$SelectedEntries)

    $config      = Read-JsonFile -FilePath $FilePath
    $featuresObj = [ordered]@{}
    foreach ($e in ($SelectedEntries | Where-Object { $null -ne $_.feature } | Sort-Object { $_.feature.url })) {
        $featuresObj[$e.feature.url] = $e.feature.options
    }

    Write-JsonFile -FilePath $FilePath -Config (Set-ConfigProperty -Config $config -Key 'features' -Value $featuresObj)
    Write-LogEntry "Features injected ($(@($SelectedEntries | Where-Object { $null -ne $_.feature }).Count) selected)" -Status Success
}

function Write-MountsArray {
    <#
    .SYNOPSIS
        Overwrites devcontainer.json's "mounts" property with the given list of
        mount strings.
    .DESCRIPTION
        Because ConvertTo-Json serialises arrays of plain strings as JSON arrays of
        strings (which is correct), but the mounts property in devcontainer.json must
        be a JSON array of strings rather than an array of objects, a placeholder
        string is inserted first and then replaced in the raw JSON to preserve the
        correct array-of-strings structure after pretty-printing.
        Mounts are alphabetically sorted before writing, purely for a stable, readable
        diff in devcontainer.json — mount order has no functional effect on the
        container. Shared write path behind Add-MountsToConfig, Add-RepoMountsToConfig,
        and Add-ExtraFolderMountsToConfig.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER Mounts
        List of mount strings to write as the new "mounts" array (sorted before writing).
    .PARAMETER LogMessage
        Message passed to Write-LogEntry once the write succeeds.
    #>
    param([string]$FilePath, [array]$Mounts, [string]$LogMessage)

    $config       = Read-JsonFile -FilePath $FilePath
    $placeholder  = '__MOUNTS_ARRAY_PLACEHOLDER__'
    $mountsJson   = ConvertTo-JsonStringArray -Items ($Mounts | Sort-Object)
    $sortedConfig = Set-ConfigProperty -Config $config -Key 'mounts' -Value $placeholder
    Write-JsonFile -FilePath $FilePath -Config $sortedConfig -Replacements @{ $placeholder = $mountsJson }
    Write-LogEntry $LogMessage -Status Success
}

function Add-MountsToConfig {
    <#
    .SYNOPSIS
        Injects the required bind mounts into devcontainer.json.
    .DESCRIPTION
        Always prepends the host %USERPROFILE%\.config\.env secret mount and the
        persistent Claude Code and Codex CLI auth volumes, then appends any per-feature
        mounts declared in the selected entries (e.g. the GitHub CLI auth volume, when
        that feature is selected).
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER SelectedEntries
        Array of selected entry objects; entries without a .mount value are ignored.
    #>
    param([string]$FilePath, [array]$SelectedEntries)

    $mounts = [System.Collections.ArrayList]@()
    [void]$mounts.Add('source=${localEnv:USERPROFILE}\.config\.env,target=/tmp/.env,type=bind,consistency=cached,readonly')
    [void]$mounts.Add('source=claude-auth-data,target=/root/.claude,type=volume')
    [void]$mounts.Add('source=codex-auth-data,target=/root/.codex,type=volume')
    foreach ($e in ($SelectedEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.mount) })) {
        [void]$mounts.Add($e.mount)
    }

    Write-MountsArray -FilePath $FilePath -Mounts $mounts.ToArray() -LogMessage "Mounts injected ($($mounts.Count) total)"
}

function Add-ExtraFolderMountsToConfig {
    <#
    .SYNOPSIS
        Appends bind mount entries for extra workspace folders to devcontainer.json.
    .DESCRIPTION
        Reads the existing mounts array (already populated by Add-MountsToConfig /
        Add-RepoMountsToConfig), appends one bind mount per extra folder using
        Get-ExtraFolderDevcontainerSource, and writes the result back. No-ops when
        ExtraFolders is empty, leaving devcontainer.json unchanged.
        Mount format: source=<host-path>,target=/workspace/<name>,type=bind,consistency=cached
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ExtraFolders
        Array of extra folder objects (as returned by Get-ExtraFolderList).
    #>
    param([string]$FilePath, [array]$ExtraFolders)

    if ($ExtraFolders.Count -eq 0) { return }

    $config = Read-JsonFile -FilePath $FilePath
    $mounts = [System.Collections.ArrayList]::new()
    if ($null -ne $config.mounts) {
        @($config.mounts) | ForEach-Object { [void]$mounts.Add($_) }
    }

    foreach ($folder in $ExtraFolders) {
        $source = Get-ExtraFolderDevcontainerSource -Folder $folder
        [void]$mounts.Add("source=$source,target=/workspace/$($folder.Name),type=bind,consistency=cached")
    }

    Write-MountsArray -FilePath $FilePath -Mounts $mounts.ToArray() -LogMessage "Extra folder mounts injected ($($ExtraFolders.Count) total)"
}

function Update-RemoteEnvInConfig {
    <#
    .SYNOPSIS
        Applies additions/overrides to a config's remoteEnv, keeping it alphabetically
        sorted, and returns the updated config object (not yet written to disk).
    .DESCRIPTION
        Reads the existing remoteEnv, drops any RemoveKeys, applies Updates (added or
        overwritten), and re-sorts once. Shared read-modify-sort path behind
        Set-ExtraFoldersInConfig, Set-SshSigningFlag, and Set-RepoSourcesInConfig,
        which only needed to differ in which keys they add/remove.
    .PARAMETER Config
        Config object as returned by Read-JsonFile.
    .PARAMETER Updates
        Hashtable of remoteEnv keys to add or overwrite.
    .PARAMETER RemoveKeys
        Optional list of remoteEnv keys to drop before applying Updates.
    .OUTPUTS
        The config object with remoteEnv replaced by the updated, sorted version.
    #>
    param($Config, [hashtable]$Updates = @{}, [string[]]$RemoveKeys = @())

    $remoteEnv = [ordered]@{}
    foreach ($key in ($Config.remoteEnv.PSObject.Properties.Name | Where-Object { $_ -notin $RemoveKeys })) {
        $remoteEnv[$key] = $Config.remoteEnv.$key
    }
    foreach ($key in $Updates.Keys) { $remoteEnv[$key] = $Updates[$key] }

    $sortedRemoteEnv = [ordered]@{}
    foreach ($key in ($remoteEnv.Keys | Sort-Object)) { $sortedRemoteEnv[$key] = $remoteEnv[$key] }

    return Set-ConfigProperty -Config $Config -Key 'remoteEnv' -Value $sortedRemoteEnv
}

function Set-ExtraFoldersInConfig {
    <#
    .SYNOPSIS
        Sets the EXTRA_FOLDER_N env vars in remoteEnv, one per extra workspace folder.
    .DESCRIPTION
        No-ops when ExtraFolders is empty, leaving remoteEnv unchanged.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ExtraFolders
        Array of extra folder objects (as returned by Get-ExtraFolderList).
    #>
    param([string]$FilePath, [array]$ExtraFolders)

    if ($ExtraFolders.Count -eq 0) { return }

    $updates = @{}
    for ($i = 0; $i -lt $ExtraFolders.Count; $i++) {
        $updates["EXTRA_FOLDER_$($i + 1)"] = $ExtraFolders[$i].Name
    }

    $config = Read-JsonFile -FilePath $FilePath
    Write-JsonFile -FilePath $FilePath -Config (Update-RemoteEnvInConfig -Config $config -Updates $updates)
    Write-LogEntry "Extra folders set ($($ExtraFolders.Count))" -Status Success
}

function Copy-ConfigurationFiles {
    <#
    .SYNOPSIS
        Copies the devcontainer template files to the destination and applies all
        project-specific substitutions.
    .DESCRIPTION
        Creates the destination and .devcontainer sub-folder if needed, copies the
        Dockerfile and .dockerignore, then selects the correct devcontainer.json
        template (standard vs. compose), applies project-name substitution, injects
        features, mounts, the SSH signing flag, and the repo sources.
        For multi-repo projects (RepoList.Count -gt 1), always promotes the workspace
        mount to the root layout. Standard mode additionally appends per-repo volume
        mounts and sets onCreateCommand (Add-RepoMountsToConfig,
        Set-OnCreateCommandInConfig). Compose mode skips both and generates
        docker-compose.yml instead (New-ComposeWithRepoVolumes' multi-repo branch
        already declares each repo's volume there) — duplicating those as
        devcontainer.json mounts at the same targets would conflict with it, and the
        onCreateCommand mkdir is redundant since compose creates each mount point
        itself.
        For single-repo projects (standard or compose) with extra folders, promotes
        workspaceFolder to the shared /workspace root (Set-WorkspaceMountInConfig) so
        the extra folders and the generated .code-workspace file are visible from the
        first attach instead of being invisible siblings of a project-only
        workspaceFolder. Standard mode additionally re-adds the project's own volume
        mount and its onCreateCommand (Add-ProjectMountToConfig,
        Set-OnCreateCommandForProjectInConfig), since Set-WorkspaceMountInConfig just
        overwrote the template's workspaceMount. Compose mode skips both for the same
        conflict-avoidance reason as the multi-repo case above (see
        New-ComposeWithRepoVolumes' single-repo branch).
    .PARAMETER Source
        Path to the source template directory (typically $PSScriptRoot).
    .PARAMETER Destination
        Absolute path to the destination project folder.
    .PARAMETER ProjectName
        Project name used to replace the "project-name" placeholder.
    .PARAMETER UseCompose
        When $true, copies devcontainer-compose.json as devcontainer.json.
    .PARAMETER SelectedEntries
        Array of selected entry objects forwarded to the config injection functions.
    .PARAMETER RepoList
        Array of fully normalised repository URLs. When more than one URL is supplied,
        multi-repo volume layout is applied.
    .PARAMETER ExtraFolders
        Array of extra workspace folder objects (as returned by Get-ExtraFolderList).
        Optional — when empty, devcontainer.json and docker-compose.yml are generated
        exactly as they are without extra folders.
    #>
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ProjectName,
        [bool]$UseCompose,
        [array]$SelectedEntries,
        [string[]]$RepoList = @(),
        [array]$ExtraFolders = @()
    )

    $destDevContainerPath = Join-Path -Path $Destination -ChildPath $DevContainerFolderName

    foreach ($dir in @($Destination, $destDevContainerPath)) {
        if (-not (Test-Path -Path $dir -PathType Container)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Write-Message "Created: $dir" -Level "Success"
        }
    }

    foreach ($file in @($DockerIgnoreFile, $DockerfileName)) {
        $src  = Join-Path -Path $Source -ChildPath $file
        $dest = Join-Path -Path $destDevContainerPath -ChildPath $file
        if (Test-Path -Path $src -PathType Leaf) {
            Copy-Item -Path $src -Destination $dest -Force
            Write-LogEntry $file -Status Success
        } else {
            Write-LogEntry "File not found: $file" -Status Warning
        }
    }

    if ($UseCompose) {
        $srcConfig   = Join-Path -Path $Source -ChildPath $DevContainerJsonCompose
        $configLabel = "devcontainer.json (compose)"
    } else {
        $srcConfig   = Join-Path -Path $Source -ChildPath $DevContainerJson
        $configLabel = "devcontainer.json (standard)"
    }

    $destConfig = Join-Path -Path $destDevContainerPath -ChildPath $DevContainerJson

    if (Test-Path -Path $srcConfig -PathType Leaf) {
        Copy-Item -Path $srcConfig -Destination $destConfig -Force
        Write-LogEntry $configLabel -Status Success
        Replace-ProjectNamePlaceholder -FilePath $destConfig -ProjectName $ProjectName
        Add-FeaturesToConfig           -FilePath $destConfig -SelectedEntries $SelectedEntries
        Add-MountsToConfig             -FilePath $destConfig -SelectedEntries $SelectedEntries
        Set-SshSigningFlag             -FilePath $destConfig -SelectedEntries $SelectedEntries
        Set-RepoSourcesInConfig        -FilePath $destConfig -RepoList $RepoList

        if ($RepoList.Count -gt 1) {
            Set-WorkspaceMountInConfig -FilePath $destConfig -ProjectName $ProjectName -UseCompose $UseCompose

            if (-not $UseCompose) {
                Add-RepoMountsToConfig      -FilePath $destConfig -ProjectName $ProjectName -RepoList $RepoList
                Set-OnCreateCommandInConfig -FilePath $destConfig -RepoList $RepoList
            }
        } elseif ($ExtraFolders.Count -gt 0) {
            # See .DESCRIPTION above for why standard mode re-adds a project mount here
            # and compose mode doesn't.
            Set-WorkspaceMountInConfig -FilePath $destConfig -ProjectName $ProjectName -UseCompose $UseCompose

            if (-not $UseCompose) {
                Add-ProjectMountToConfig              -FilePath $destConfig -ProjectName $ProjectName
                Set-OnCreateCommandForProjectInConfig -FilePath $destConfig -ProjectName $ProjectName
            }
        }

        Add-ExtraFolderMountsToConfig -FilePath $destConfig -ExtraFolders $ExtraFolders
        Set-ExtraFoldersInConfig      -FilePath $destConfig -ExtraFolders $ExtraFolders

        if ($UseCompose) {
            $templateFile = Join-Path -Path $Source -ChildPath $DockerComposeYml
            New-ComposeWithRepoVolumes -TemplateFile $templateFile -ProjectName $ProjectName `
                -RepoList $RepoList -Destination $destDevContainerPath -SelectedEntries $SelectedEntries `
                -ExtraFolders $ExtraFolders
        }
    } else {
        Write-LogEntry "Template not found: $srcConfig" -Status Error
        throw "Missing template: $srcConfig"
    }
}

function Add-ProjectMountToConfig {
    <#
    .SYNOPSIS
        Appends the single-repo project volume mount to devcontainer.json's mounts array.
    .DESCRIPTION
        Used only in single-repo mode when extra workspace folders promote workspaceFolder
        to the shared /workspace root (see Set-WorkspaceMountInConfig): that call replaces
        the template's own workspaceMount, so the project's data volume — otherwise lost —
        must be re-added as a regular nested mount, mirroring Add-RepoMountsToConfig's role
        for multi-repo. Unlike that function, the target is /workspace/<ProjectName> (not a
        repo-derived folder name), matching how 01-git.sh clones single-repo sources.
        Mount format: source=<project>-data,target=/workspace/<project>,type=volume
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ProjectName
        Project name used to construct the volume name and mount target.
    #>
    param([string]$FilePath, [string]$ProjectName)

    $config = Read-JsonFile -FilePath $FilePath
    $mounts = [System.Collections.ArrayList]::new()
    if ($null -ne $config.mounts) {
        @($config.mounts) | ForEach-Object { [void]$mounts.Add($_) }
    }
    [void]$mounts.Add("source=$ProjectName-data,target=/workspace/$ProjectName,type=volume")

    Write-MountsArray -FilePath $FilePath -Mounts $mounts.ToArray() -LogMessage "Project mount injected (/workspace/$ProjectName)"
}

function Set-OnCreateCommandForProjectInConfig {
    <#
    .SYNOPSIS
        Sets onCreateCommand to mkdir -p the single-repo project folder.
    .DESCRIPTION
        Counterpart to Set-OnCreateCommandInConfig for single-repo mode: when extra
        workspace folders promote workspaceFolder to the shared /workspace root, the
        project's volume (added by Add-ProjectMountToConfig) is nested under that root
        and needs its mount point created before the git module clones into it.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ProjectName
        Project name used to derive the mount point path.
    #>
    param([string]$FilePath, [string]$ProjectName)

    $config = Read-JsonFile -FilePath $FilePath
    Write-JsonFile -FilePath $FilePath -Config (Set-ConfigProperty -Config $config -Key 'onCreateCommand' -Value "mkdir -p /workspace/$ProjectName")
    Write-LogEntry "onCreateCommand set (project folder)" -Status Success
}

function Set-OnCreateCommandInConfig {
    <#
    .SYNOPSIS
        Sets the onCreateCommand field in devcontainer.json to create all repo mount points.
    .DESCRIPTION
        Builds the command "mkdir -p /workspace/<folder1> /workspace/<folder2> ..."
        from the repo list and inserts (or replaces) the onCreateCommand key, keeping all
        top-level keys in alphabetical order.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER RepoList
        Array of fully normalised repository URLs used to derive folder names.
    #>
    param([string]$FilePath, [string[]]$RepoList)

    $folders = $RepoList | ForEach-Object { "/workspace/$(_Get-RepoFolderName -Url $_)" }
    $command  = "mkdir -p " + ($folders -join ' ')

    $config = Read-JsonFile -FilePath $FilePath
    Write-JsonFile -FilePath $FilePath -Config (Set-ConfigProperty -Config $config -Key 'onCreateCommand' -Value $command)
    Write-LogEntry "onCreateCommand set ($($RepoList.Count) repos)" -Status Success
}

function Replace-ProjectNamePlaceholder {
    <#
    .SYNOPSIS
        Replaces every occurrence of the literal string "project-name" in a file
        with the actual project name.
    .PARAMETER FilePath
        Absolute path to the file to update. No-ops silently if the file does not exist.
    .PARAMETER ProjectName
        The project name to substitute in place of "project-name".
    #>
    param([string]$FilePath, [string]$ProjectName)
    if (Test-Path -Path $FilePath -PathType Leaf) {
        [System.IO.File]::WriteAllText($FilePath, ((Get-Content -Path $FilePath -Raw) -replace 'project-name', $ProjectName))
        Write-LogEntry "project-name -> $ProjectName" -Status Success
    }
}

function Set-SshSigningFlag {
    <#
    .SYNOPSIS
        Sets the SSH_SIGNING environment variable in devcontainer.json to "true" or
        "false" based on whether the ssh-signing entry was selected.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER SelectedEntries
        Array of selected entry objects used to determine whether ssh-signing is active.
    #>
    param([string]$FilePath, [array]$SelectedEntries)

    $enabled = if ($SelectedEntries | Where-Object { $_.key -eq 'ssh-signing' }) { 'true' } else { 'false' }
    $config  = Read-JsonFile -FilePath $FilePath
    Write-JsonFile -FilePath $FilePath -Config (Update-RemoteEnvInConfig -Config $config -Updates @{ SSH_SIGNING = $enabled })
    Write-LogEntry "SSH_SIGNING set to $enabled" -Status Success
}

function Set-WorkspaceMountInConfig {
    <#
    .SYNOPSIS
        Updates workspaceFolder (and, outside compose mode, workspaceMount) in
        devcontainer.json to the shared /workspace root layout.
    .DESCRIPTION
        Used for multi-repo projects, and for single-repo projects with extra folders
        (see Copy-ConfigurationFiles) — both need /workspace itself, rather than a
        single project folder, to be what VS Code attaches to and mounts, so sibling
        folders (other repos, extra folders, the generated .code-workspace file) are
        visible from the first attach.
        workspaceMount is only ever set outside compose mode: per the devcontainer.json
        schema it's an image/Dockerfile-only property, invalid alongside
        dockerComposeFile — compose mode mounts /workspace entirely through
        docker-compose.yml (see New-ComposeWithRepoVolumes), so workspaceFolder alone
        is enough there.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ProjectName
        Project name used to construct the workspace root volume name.
    .PARAMETER UseCompose
        When $true, workspaceMount is omitted (and removed if already present)
        instead of being set.
    #>
    param([string]$FilePath, [string]$ProjectName, [bool]$UseCompose = $false)

    $config  = Read-JsonFile -FilePath $FilePath
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -notin @('workspaceFolder', 'workspaceMount') }) +
               'workspaceFolder'
    if (-not $UseCompose) { $allKeys += 'workspaceMount' }
    $allKeys = $allKeys | Sort-Object

    $sorted = [ordered]@{}
    foreach ($k in $allKeys) {
        $sorted[$k] = switch ($k) {
            'workspaceFolder' { '/workspace' }
            'workspaceMount'  { "source=$ProjectName-workspace,target=/workspace,type=volume" }
            default           { $config.$k }
        }
    }
    Write-JsonFile -FilePath $FilePath -Config $sorted

    if ($UseCompose) {
        Write-LogEntry "workspaceFolder promoted to /workspace" -Status Success
    } else {
        Write-LogEntry "workspaceMount updated to $ProjectName-workspace" -Status Success
    }
}
