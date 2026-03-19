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
        System.Boolean — $true if the path is acceptable, $false otherwise.
    #>
    param([string]$Path)
    Write-Message "Validating destination path" -Level "Info"
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        Write-Message "Path must be absolute (e.g. G:\My Drive\docker\project-app)" -Level "Error"
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

function Test-ProjectName {
    <#
    .SYNOPSIS
        Validates that the project name contains only letters, numbers, and hyphens,
        and does not exceed 255 characters.
    .PARAMETER Name
        The project name string to validate.
    .OUTPUTS
        System.Boolean — $true if valid, $false otherwise.
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
