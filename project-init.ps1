#Requires -Version 5.1
<#
.SYNOPSIS
    Initialises a new DevContainer project from the local template.

.DESCRIPTION
    Copies .devcontainer files to the destination, substitutes the project name,
    injects selected devcontainer features and mounts, sets SSH signing flag,
    collects repository URLs, and configures single- or multi-repo volume layout.

.PARAMETER DestinationPath
    Absolute path to the destination folder.

.PARAMETER ProjectName
    Project name (letters, numbers and hyphens only).

.EXAMPLE
    .\project-init.ps1
    .\project-init.ps1 -DestinationPath "G:\My Drive\docker\project-app" -ProjectName "project-app"
#>

param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationPath,

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 255)]
    [string]$ProjectName
)

$ErrorActionPreference = "Stop"
$SourceDevContainerPath  = $PSScriptRoot
$DevContainerFolderName  = ".devcontainer"
$DockerIgnoreFile        = ".dockerignore"
$DockerfileName          = "Dockerfile"
$DevContainerJson        = "devcontainer.json"
$DevContainerJsonCompose = "devcontainer-compose.json"
$DockerComposeYml        = "docker-compose.yml"
$EntryManifestPath       = Join-Path -Path $PSScriptRoot -ChildPath "devcontainer.entries.json"

. "$PSScriptRoot/init/utils.ps1"
. "$PSScriptRoot/init/ui.ps1"
. "$PSScriptRoot/init/validation.ps1"
. "$PSScriptRoot/init/manifest.ps1"
. "$PSScriptRoot/init/config.ps1"
. "$PSScriptRoot/init/repos.ps1"

if ($MyInvocation.InvocationName -ne '.') {

# ----- INPUT COLLECTION -------------------------------------------------------

$useCompose      = Get-ProjectTypeSelection
$entryManifest   = Get-EntryManifest
$selectedEntries = Select-Features -Manifest $entryManifest

Write-Section "DevContainer Setup"

if (-not $DestinationPath) {
    Write-Message "Enter absolute path for destination folder" -Level "Highlight"
    Write-Host "Example: G:\My Drive\docker\project-app" -ForegroundColor "DarkGray"
    Write-Host ""
    $DestinationPath = Read-Host "Destination path"
    if ([string]::IsNullOrWhiteSpace($DestinationPath)) {
        Write-Message "Path not provided. Script cancelled" -Level "Error"; exit 1
    }
}

if (-not $ProjectName) {
    Write-Message "Enter project name" -Level "Highlight"
    Write-Host "Example: project-app" -ForegroundColor "DarkGray"
    Write-Host ""
    $ProjectName = Read-Host "Project name"
    if ([string]::IsNullOrWhiteSpace($ProjectName)) {
        Write-Message "Project name not provided. Script cancelled" -Level "Error"; exit 1
    }
}

Write-Message "Enter repository URLs" -Level "Highlight"
$repoList = @(Get-RepoList)

# ----- VALIDATION -------------------------------------------------------------

Write-Section "Input Validation"

if (-not (Test-DestinationPath -Path $DestinationPath)) { exit 1 }
if (-not (Test-ProjectName     -Name $ProjectName))      { exit 1 }

# ----- EXECUTION --------------------------------------------------------------

Write-Section "DevContainer Configuration"

try {
    Copy-ConfigurationFiles -Source $SourceDevContainerPath -Destination $DestinationPath `
        -ProjectName $ProjectName -UseCompose $useCompose -SelectedEntries $selectedEntries `
        -RepoList $repoList

    Write-Section "Setup Completed"
    Write-Message "Destination : $DestinationPath" -Level "Info"
    Write-Message "Project     : $ProjectName" -Level "Info"
    Write-Message "DevContainer: $(Join-Path -Path $DestinationPath -ChildPath $DevContainerFolderName)" -Level "Info"
    Write-Host ""
    Write-Message "Open the folder in VS Code to start the devcontainer." -Level "Success"
    Write-Host ""
} catch {
    Write-Section "Error"
    Write-Message $_.Exception.Message -Level "Error"
    Write-Message $_.ScriptStackTrace  -Level "Warning"
    exit 1
}

} # end guard: if ($MyInvocation.InvocationName -ne '.')
