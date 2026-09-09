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

.PARAMETER SecretsPath
    Bind mount source for the secrets file, resolved on the Docker daemon's
    filesystem (not the client's). Defaults to the local Windows path; when the
    Docker daemon is remote, set the DEVCONTAINER_SECRETS_PATH environment
    variable so it appears as a selectable option, or pass this parameter directly.

.PARAMETER DockerContext
    Optional Docker CLI context name to pin the generated project to, written to
    .vscode/settings.json as containers.environment.DOCKER_CONTEXT. Passed as an
    empty string, the generated project is unchanged, it inherits whatever context
    is active, and the prompt is skipped - the way to decline the pin without an
    interactive answer. Omitted entirely, the prompt is shown.
    Only honoured with the VS Code Container Tools extension installed.

.EXAMPLE
    .\project-init.ps1
    .\project-init.ps1 -DestinationPath "X:\workspaces\docker\project-app" -ProjectName "project-app"
    .\project-init.ps1 -SecretsPath "/srv/data/.config/.env"
    .\project-init.ps1 -DockerContext "homeserver"
#>

param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationPath,

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [ValidateLength(1, 255)]
    [string]$ProjectName,

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$SecretsPath,

    # No ValidateNotNullOrEmpty: an empty string is the meaningful "no pin"
    # answer, and passing it is how a non-interactive caller skips the prompt.
    [Parameter(Mandatory = $false)]
    [string]$DockerContext
)

$ErrorActionPreference = "Stop"
$SourceDevContainerPath  = $PSScriptRoot
$DevContainerFolderName  = ".devcontainer"
$DockerIgnoreFile        = ".dockerignore"
$DockerfileName          = "Dockerfile"
$DevContainerJson        = "devcontainer.json"
$DevContainerJsonCompose = "devcontainer.compose.json"
$DockerComposeYml        = "docker-compose.yml"
$EntryManifestPath       = Join-Path -Path $PSScriptRoot -ChildPath "devcontainer.entries.json"

. "$PSScriptRoot/init/utils.ps1"
. "$PSScriptRoot/init/ui.ps1"
. "$PSScriptRoot/init/validation.ps1"
. "$PSScriptRoot/init/manifest.ps1"
. "$PSScriptRoot/init/config.ps1"
. "$PSScriptRoot/init/vscode.ps1"
. "$PSScriptRoot/init/repos.ps1"
. "$PSScriptRoot/init/extra-folders.ps1"

if ($MyInvocation.InvocationName -ne '.') {

# ----- INPUT COLLECTION -------------------------------------------------------

$useCompose      = Get-ProjectTypeSelection
$entryManifest   = Get-EntryManifest
$selectedEntries = Select-Features -Manifest $entryManifest

# Runs before any output below: the selector clears the screen, so it must
# happen while the terminal still has nothing worth preserving on it.
# Keyed on whether the parameter was passed, not on its value: -DockerContext ''
# is the explicit "no pin, don't ask" answer, so it must not re-open the prompt.
if (-not $PSBoundParameters.ContainsKey('SecretsPath'))   { $SecretsPath   = Get-SecretsPathSelection }
if (-not $PSBoundParameters.ContainsKey('DockerContext')) { $DockerContext = Get-DockerContextInput }

Write-Section "DevContainer Setup"

if (-not $DestinationPath) {
    Write-Message "Enter absolute path for destination folder" -Level "Highlight"
    Write-Host "Example: X:\workspaces\docker\project-app" -ForegroundColor "DarkGray"
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

$repoList     = @(Get-RepoList)
$extraFolders = @(Get-ExtraFolderList -ProjectName $ProjectName -RepoList $repoList)

# ----- VALIDATION -------------------------------------------------------------

Write-Section "Input Validation"

if (-not (Test-DestinationPath -Path $DestinationPath)) { exit 1 }
if (-not (Test-ProjectName     -Name $ProjectName))      { exit 1 }

# ----- EXECUTION --------------------------------------------------------------

Write-Section "DevContainer Configuration"

try {
    Copy-ConfigurationFiles -Source $SourceDevContainerPath -Destination $DestinationPath `
        -ProjectName $ProjectName -UseCompose $useCompose -SelectedEntries $selectedEntries `
        -RepoList $repoList -ExtraFolders $extraFolders -SecretsPath $SecretsPath

    # Not part of copying the devcontainer templates: this writes the editor's
    # own settings, outside .devcontainer, and must not inherit that step's
    # "only if the template exists" condition.
    Set-DockerContextInSettings -Destination $DestinationPath -DockerContext $DockerContext

    Write-Section "Setup Completed"
    Write-Message "Destination : $DestinationPath" -Level "Info"
    Write-Message "Project     : $ProjectName" -Level "Info"
    Write-Message "DevContainer: $(Join-Path -Path $DestinationPath -ChildPath $DevContainerFolderName)" -Level "Info"
    Write-Message "Secrets     : $(Format-SecretsPathForDisplay -SecretsPath $SecretsPath)" -Level "Info"

    if (-not [string]::IsNullOrWhiteSpace($DockerContext)) {
        Write-Message "Docker ctx  : $DockerContext" -Level "Info"
        Write-Message "Requires the VS Code Container Tools extension (ms-azuretools.vscode-containers); otherwise ignored." -Level "Warning"
    }

    # Deliberately here rather than in the validation section: a warning printed
    # before the generation output would be scrolled off the screen by it.
    [void](Test-PathCoherence -SecretsPath $SecretsPath -ExtraFolders $extraFolders)

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
