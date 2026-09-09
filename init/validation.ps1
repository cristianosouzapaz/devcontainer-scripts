#Requires -Version 5.1
<#
.SYNOPSIS
    Input validation functions for destination path and project name.
#>

function Test-DestinationPath {
    <#
    .SYNOPSIS
        Validates that the destination path is absolute, its parent exists, and
        prompts the user for confirmation if the folder already exists.
    .PARAMETER Path
        The absolute destination path to validate.
    .OUTPUTS
        System.Boolean - $true if the path is acceptable, $false otherwise.
    #>
    param([string]$Path)
    Write-Message "Validating destination path" -Level "Info"
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        Write-Message "Path must be absolute (e.g. X:\workspaces\docker\project-app)" -Level "Error"
        return $false
    }
    $parentPath = Split-Path -Parent $Path
    if (-not (Test-Path -Path $parentPath -PathType Container)) {
        Write-Message "Parent directory does not exist: $parentPath" -Level "Error"
        return $false
    }
    if (Test-Path -Path $Path -PathType Container) {
        Write-Message "Folder already exists: $Path" -Level "Warning"
        $response = Read-Host "Continue and overwrite .devcontainer files (Y/N)"
        if ($response -ne "Y" -and $response -ne "y") {
            Write-Message "Operation cancelled" -Level "Warning"
            return $false
        }
    }
    Write-Message "Destination path validated" -Level "Success"
    return $true
}

function Test-PathCoherence {
    <#
    .SYNOPSIS
        Warns when the secrets path and the extra folders disagree about which
        machine the Docker daemon runs on.
    .DESCRIPTION
        The secrets path and each extra folder are independent inputs by design -
        the shape of what the user types is the only signal, and no "remote mode"
        exists to keep them in step. So a run can end with the two disagreeing,
        and either direction is the same silent failure: Docker resolves a mount
        source on the daemon's filesystem, finds nothing there, and creates an
        empty directory instead of failing. The container comes up either without
        credentials or with an empty folder where the vault should be, and the
        first symptom arrives much later.

        Warns rather than rejects: these are the user's paths, and a mixed setup
        may be deliberate (a folder shared into the daemon's filesystem under a
        client-side path, say). Returns $false only to report that a warning was
        emitted; the caller is not expected to abort.
    .PARAMETER SecretsPath
        The secrets file mount source, as chosen by Get-SecretsPathSelection or
        passed via -SecretsPath.
    .PARAMETER ExtraFolders
        Array of extra folder objects as returned by Get-ExtraFolderList. Empty
        is coherent by definition - there is nothing to disagree with.
    .OUTPUTS
        System.Boolean - $true when the inputs agree (or there is nothing to
        compare), $false when a warning was emitted.
    #>
    param([string]$SecretsPath, [array]$ExtraFolders = @())

    if ($ExtraFolders.Count -eq 0) { return $true }

    $secretsOnDockerHost = Test-DockerHostPath -Path $SecretsPath
    $foldersOnDockerHost = @($ExtraFolders | Where-Object { $_.IsPosix })
    $foldersOnClient     = @($ExtraFolders | Where-Object { -not $_.IsPosix })

    if ($foldersOnDockerHost.Count -gt 0 -and -not $secretsOnDockerHost) {
        Write-Message "Extra folders use Docker-host paths but the secrets file does not." -Level "Warning"
        Write-Message "If the daemon is remote, the container starts without credentials." -Level "Warning"
        return $false
    }

    if ($secretsOnDockerHost -and $foldersOnClient.Count -gt 0) {
        $names = ($foldersOnClient | ForEach-Object { $_.Name }) -join ', '
        Write-Message "The secrets file uses a Docker-host path but these extra folders do not: $names." -Level "Warning"
        Write-Message "If the daemon is remote, they mount as empty folders it creates on the spot." -Level "Warning"
        return $false
    }

    return $true
}

function Test-ProjectName {
    <#
    .SYNOPSIS
        Validates that the project name contains only letters, numbers, and hyphens,
        and does not exceed 255 characters.
    .PARAMETER Name
        The project name string to validate.
    .OUTPUTS
        System.Boolean - $true if valid, $false otherwise.
    #>
    param([string]$Name)
    Write-Message "Validating project name" -Level "Info"
    if ($Name -notmatch "^[a-zA-Z0-9-]+$") {
        Write-Message "Project name must contain only letters, numbers, and hyphens" -Level "Error"
        return $false
    }
    if ($Name.Length -gt 255) {
        Write-Message "Project name is too long (max 255 characters)" -Level "Error"
        return $false
    }
    Write-Message "Project name validated" -Level "Success"
    return $true
}
