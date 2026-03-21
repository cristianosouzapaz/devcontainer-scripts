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

function Add-MountsToConfig {
    <#
    .SYNOPSIS
        Injects the required bind mounts into devcontainer.json.
    .DESCRIPTION
        Always prepends the host ~/.config/.env secret mount, then appends any
        per-feature mounts declared in the selected entries.
        Because ConvertTo-Json serialises arrays of plain strings as JSON arrays of
        strings (which is correct), but the mounts property in devcontainer.json must
        be a JSON array of strings rather than an array of objects, a placeholder
        string is inserted first and then replaced in the raw JSON to preserve the
        correct array-of-strings structure after pretty-printing.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER SelectedEntries
        Array of selected entry objects; entries without a .mount value are ignored.
    #>
    param([string]$FilePath, [array]$SelectedEntries)

    $config = Read-JsonFile -FilePath $FilePath

    $mounts = [System.Collections.ArrayList]@()
    [void]$mounts.Add('source=${localEnv:USERPROFILE}\.config\.env,target=/tmp/.env,type=bind,consistency=cached,readonly')
    [void]$mounts.Add('source=claude-auth-data,target=/root/.claude,type=volume')
    foreach ($e in ($SelectedEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.mount) })) {
        [void]$mounts.Add($e.mount)
    }

    $placeholder  = '__MOUNTS_ARRAY_PLACEHOLDER__'
    $mountsJson   = ConvertTo-JsonStringArray -Items $mounts.ToArray()
    $sortedConfig = Set-ConfigProperty -Config $config -Key 'mounts' -Value $placeholder
    Write-JsonFile -FilePath $FilePath -Config $sortedConfig -Replacements @{ $placeholder = $mountsJson }
    Write-LogEntry "Mounts injected ($($mounts.Count) total)" -Status Success
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
        For multi-repo projects (RepoList.Count -gt 1), additionally updates the
        workspace mount to the root layout, appends per-repo volume mounts, sets the
        onCreateCommand, and (in compose mode) generates docker-compose.yml.
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
    #>
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ProjectName,
        [bool]$UseCompose,
        [array]$SelectedEntries,
        [string[]]$RepoList = @()
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
            Set-WorkspaceMountInConfig  -FilePath $destConfig -ProjectName $ProjectName
            Add-RepoMountsToConfig      -FilePath $destConfig -ProjectName $ProjectName -RepoList $RepoList
            Set-OnCreateCommandInConfig -FilePath $destConfig -RepoList $RepoList

            if ($UseCompose) {
                $templateFile = Join-Path -Path $Source -ChildPath $DockerComposeYml
                New-ComposeWithRepoVolumes -TemplateFile $templateFile -ProjectName $ProjectName `
                    -RepoList $RepoList -Destination $destDevContainerPath
            }
        }
    } else {
        Write-LogEntry "Template not found: $srcConfig" -Status Error
        throw "Missing template: $srcConfig"
    }
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

    $enabled   = if ($SelectedEntries | Where-Object { $_.key -eq 'ssh-signing' }) { 'true' } else { 'false' }
    $config    = Read-JsonFile -FilePath $FilePath
    $remoteEnv = [ordered]@{}
    foreach ($key in ($config.remoteEnv.PSObject.Properties.Name | Sort-Object)) {
        $remoteEnv[$key] = if ($key -eq 'SSH_SIGNING') { $enabled } else { $config.remoteEnv.$key }
    }
    Write-JsonFile -FilePath $FilePath -Config (Set-ConfigProperty -Config $config -Key 'remoteEnv' -Value $remoteEnv)
    Write-LogEntry "SSH_SIGNING set to $enabled" -Status Success
}

function Set-WorkspaceMountInConfig {
    <#
    .SYNOPSIS
        Updates workspaceFolder and workspaceMount in devcontainer.json for the
        multi-repo workspace root layout.
    .PARAMETER FilePath
        Absolute path to the devcontainer.json file to update.
    .PARAMETER ProjectName
        Project name used to construct the workspace root volume name.
    #>
    param([string]$FilePath, [string]$ProjectName)

    $config   = Read-JsonFile -FilePath $FilePath
    $allKeys  = @($config.PSObject.Properties.Name | Where-Object { $_ -notin @('workspaceFolder', 'workspaceMount') }) +
                @('workspaceFolder', 'workspaceMount') | Sort-Object
    $sorted   = [ordered]@{}
    foreach ($k in $allKeys) {
        $sorted[$k] = switch ($k) {
            'workspaceFolder' { '/workspace' }
            'workspaceMount'  { "source=$ProjectName-workspace,target=/workspace,type=volume" }
            default           { $config.$k }
        }
    }
    Write-JsonFile -FilePath $FilePath -Config $sorted
    Write-LogEntry "workspaceMount updated to $ProjectName-workspace" -Status Success
}
