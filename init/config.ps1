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
        container. Shared write path behind Add-MountsToConfig and
        Add-ExtraFolderMountsToConfig.
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
        Adds the host %USERPROFILE%\.config\.env secret mount and selected feature
        mounts. Dockerfile/image configurations also mount the shared persistent-data
        volume; Compose owns that mount in docker-compose.yml.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER SelectedEntries
        Array of selected entry objects; entries without a .mount value are ignored.
    #>
    param([string]$FilePath, [array]$SelectedEntries, [bool]$UseCompose = $false)

    # Listed alphabetically for readability; Write-MountsArray sorts the final array anyway.
    $mounts = [System.Collections.ArrayList]@()
    [void]$mounts.Add('source=${localEnv:USERPROFILE}\.config\.env,target=/tmp/.env,type=bind,consistency=cached,readonly')
    if (-not $UseCompose) {
        [void]$mounts.Add('source=devcontainer-shared-data,target=/var/lib/devcontainer,type=volume')
    }
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
        Reads the existing mounts array (already populated by Add-MountsToConfig),
        appends one bind mount per extra folder using
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
        Multi-repo projects and projects with extra folders open the /workspace root;
        a single repository opens /workspace/<project>. All modes retain one project
        volume at /workspace, while Compose declares its mounts in docker-compose.yml.
    .PARAMETER Source
        Path to the source template directory (typically $PSScriptRoot).
    .PARAMETER Destination
        Absolute path to the destination project folder.
    .PARAMETER ProjectName
        Project name used to replace the "project-name" placeholder.
    .PARAMETER UseCompose
        When $true, copies devcontainer.compose.json as devcontainer.json.
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
        Add-MountsToConfig             -FilePath $destConfig -SelectedEntries $SelectedEntries -UseCompose $UseCompose
        Set-SshSigningFlag             -FilePath $destConfig -SelectedEntries $SelectedEntries
        Set-RepoSourcesInConfig        -FilePath $destConfig -RepoList $RepoList

        if ($RepoList.Count -gt 1 -or $ExtraFolders.Count -gt 0) {
            Set-WorkspaceMountInConfig -FilePath $destConfig -ProjectName $ProjectName -UseCompose $UseCompose
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
            'workspaceMount'  { "source=$ProjectName-data,target=/workspace,type=volume" }
            default           { $config.$k }
        }
    }
    Write-JsonFile -FilePath $FilePath -Config $sorted

    if ($UseCompose) {
        Write-LogEntry "workspaceFolder promoted to /workspace" -Status Success
    } else {
        Write-LogEntry "workspaceMount updated to $ProjectName-data" -Status Success
    }
}
