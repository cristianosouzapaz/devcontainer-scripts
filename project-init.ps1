#Requires -Version 5.1
<#
.SYNOPSIS
    DevContainer Project Initializer
    Automates copying and configuring devcontainer files for new projects.

.DESCRIPTION
    This script copies the devcontainer template structure, including configuration files,
    to a new project folder and replaces placeholders with the specified project name.

.PARAMETER DestinationPath
    Absolute path to the destination folder

.PARAMETER ProjectName
    Project name

.EXAMPLE
    .\project-init.ps1
    .\project-init.ps1 -DestinationPath "G:\My Drive\docker\project-app" -ProjectName "project-app"

.NOTES
    Author: Project Initializer Script
    Requires: Windows PowerShell 5.1 or later
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

# ============================================================================
# CONFIGURATION
# ============================================================================

$ErrorActionPreference = "Stop"
$SourceDevContainerPath = $PSScriptRoot
$DevContainerFolderName = ".devcontainer"
$DockerIgnoreFile = ".dockerignore"
$DockerfileName = "Dockerfile"
$DevContainerJson = "devcontainer.json"
$DevContainerJsonCompose = "devcontainer-compose.json"
$EntryManifestPath = Join-Path -Path $PSScriptRoot -ChildPath "devcontainer.entries.json"

# Professional color palette
$Colors = @{
    Success   = "Green"
    Error     = "Red"
    Warning   = "Yellow"
    Info      = "Cyan"
    Header    = "Magenta"
    Highlight = "White"
}

# ============================================================================
# LOGGING AND OUTPUT FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Writes a formatted section header
#>
function Write-Section {
    param([string]$Title)
    Write-Host ""
    if ($Title) {
        Write-Host $Title -ForegroundColor $Colors['Header']
    }
    Write-Host ""
}

<#
.SYNOPSIS
    Writes a formatted message with color and timestamp
#>
function Write-Message {
    param(
        [string]$Message,
        [string]$Level = "Info"
    )

    $timestamp = Get-Date -Format "HH:mm:ss"
    $color = if ($Colors[$Level]) { $Colors[$Level] } else { $Colors["Info"] }
    $prefix = "[$timestamp]"

    Write-Host $prefix -ForegroundColor "DarkGray" -NoNewline
    Write-Host " $Message" -ForegroundColor $color
}

<#
.SYNOPSIS
    Writes a log entry with status indicator
#>
function Write-LogEntry {
    param(
        [string]$Message,
        [ValidateSet('Success', 'Error', 'Warning')]
        [string]$Status = 'Success'
    )
    
    $indicator = switch ($Status) {
        'Success' { '[+]' }
        'Error' { '[-]' }
        'Warning' { '[!]' }
    }
    
    $color = $Colors[$Status]
    Write-Host "  $indicator " -NoNewline
    Write-Host $Message -ForegroundColor $color
}

# ============================================================================
# JSON FORMATTING FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Reformats a JSON string with consistent 4-space indentation.
    Works around PowerShell 5.1 ConvertTo-Json value-alignment quirks.
#>
function Format-Json {
    param([string]$Json)

    # Step 1: flatten — strip all whitespace that lives outside string literals
    $flat = [System.Text.StringBuilder]::new($Json.Length)
    $inStr = $false
    $esc   = $false
    foreach ($c in $Json.ToCharArray()) {
        if ($esc)                          { [void]$flat.Append($c); $esc = $false; continue }
        if ($c -eq '\' -and $inStr)        { [void]$flat.Append($c); $esc = $true;  continue }
        if ($c -eq '"')                    { $inStr = -not $inStr; [void]$flat.Append($c); continue }
        if ($inStr)                        { [void]$flat.Append($c); continue }
        if ($c -ne ' ' -and $c -ne "`t" -and $c -ne "`r" -and $c -ne "`n") {
            [void]$flat.Append($c)
        }
    }

    # Step 2: re-serialize with 4-space indentation and a single space after ':'
    $out   = [System.Text.StringBuilder]::new()
    $depth = 0
    $inStr = $false
    $esc   = $false
    $chars = $flat.ToString().ToCharArray()
    $i     = 0
    $nl    = [System.Environment]::NewLine

    while ($i -lt $chars.Length) {
        $c = $chars[$i]

        if ($esc)                   { [void]$out.Append($c); $esc = $false; $i++; continue }
        if ($c -eq '\' -and $inStr) { [void]$out.Append($c); $esc = $true;  $i++; continue }
        if ($c -eq '"') {
            $inStr = -not $inStr
            [void]$out.Append($c)
            $i++
            continue
        }
        if ($inStr) { [void]$out.Append($c); $i++; continue }

        if ($c -eq '{') {
            if ($i + 1 -lt $chars.Length -and $chars[$i + 1] -eq '}') {
                [void]$out.Append('{}'); $i += 2
            } else {
                [void]$out.Append('{'); $depth++
                [void]$out.Append($nl + ('    ' * $depth)); $i++
            }
        } elseif ($c -eq '}') {
            $depth--
            [void]$out.Append($nl + ('    ' * $depth) + '}'); $i++
        } elseif ($c -eq '[') {
            if ($i + 1 -lt $chars.Length -and $chars[$i + 1] -eq ']') {
                [void]$out.Append('[]'); $i += 2
            } else {
                [void]$out.Append('['); $depth++
                [void]$out.Append($nl + ('    ' * $depth)); $i++
            }
        } elseif ($c -eq ']') {
            $depth--
            [void]$out.Append($nl + ('    ' * $depth) + ']'); $i++
        } elseif ($c -eq ',') {
            [void]$out.Append(',')
            [void]$out.Append($nl + ('    ' * $depth)); $i++
        } elseif ($c -eq ':') {
            [void]$out.Append(': '); $i++
        } else {
            [void]$out.Append($c); $i++
        }
    }

    return $out.ToString()
}

# ============================================================================
# FEATURE SELECTION FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Loads the entry manifest from devcontainer.entries.json
#>
function Get-EntryManifest {
    if (-not (Test-Path -Path $EntryManifestPath -PathType Leaf)) {
        Write-Message "Entry manifest not found: $EntryManifestPath" -Level "Error"
        throw "Missing devcontainer.entries.json"
    }
    return @(Get-Content -Path $EntryManifestPath -Raw | ConvertFrom-Json)
}

<#
.SYNOPSIS
    Interactive toggle-based feature selector. Returns the array of selected feature objects.
#>
function Select-Features {
    param($Manifest)

    $mandatory = @($Manifest | Where-Object { $_.mandatory -eq $true })
    $optional  = @($Manifest | Where-Object { $_.mandatory -ne $true })

    # Initialise toggle state from each feature's default value
    $state = @{}
    foreach ($f in $optional) { $state[$f.key] = [bool]$f.default }

    $cursor = 0
    $done   = $false

    while (-not $done) {
        Clear-Host
        Write-Host ""
        Write-Host "Feature Selection" -ForegroundColor $Colors['Header']
        Write-Host ""
        Write-Host "  Always included:" -ForegroundColor "DarkGray"
        foreach ($f in $mandatory) {
            Write-Host "    [*] $($f.label)" -ForegroundColor "DarkGray"
        }
        Write-Host ""
        Write-Host "  Optional (Up/Down navigate, Space to toggle, Enter to confirm):" -ForegroundColor $Colors['Info']
        Write-Host ""

        $i = 0
        foreach ($f in $optional) {
            $mark   = if ($state[$f.key]) { "x" } else { " " }
            $color  = if ($state[$f.key]) { $Colors['Success'] } else { $Colors['Highlight'] }
            $prefix = if ($i -eq $cursor) { "  > " } else { "    " }
            Write-Host "${prefix}[$mark] $($f.label)" -ForegroundColor $color
            $i++
        }

        Write-Host ""

        $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

        switch ($key.VirtualKeyCode) {
            38 { if ($cursor -gt 0) { $cursor-- } }                              # UpArrow
            40 { if ($cursor -lt ($optional.Count - 1)) { $cursor++ } }          # DownArrow
            32 { $k = $optional[$cursor].key; $state[$k] = -not $state[$k] }     # Space
            13 { $done = $true }                                                 # Enter
        }
    }

    $selected = [System.Collections.ArrayList]@()
    foreach ($f in $mandatory) { [void]$selected.Add($f) }
    foreach ($f in $optional)  { if ($state[$f.key]) { [void]$selected.Add($f) } }
    return $selected.ToArray()
}

# ============================================================================
# USER INTERACTION FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Prompts user to select project type
#>
function Get-ProjectTypeSelection {
    Write-Section "Project Type Selection"
    
    $selection = $null
    while ($null -eq $selection) {
        Write-Host ""
        Write-Message "Select project type:" -Level "Highlight"
        Write-Host "  1) Standard (single container)"
        Write-Host "  2) Docker Compose (multi-container)"
        $choice = Read-Host "Enter choice [1-2]"
        
        switch ($choice) {
            '1' { $selection = $false }
            '2' { $selection = $true }
            default { Write-Message "Please enter 1 or 2." -Level "Warning" }
        }
    }
    
    return $selection
}

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Tests the destination path
#>
function Test-DestinationPath {
    param([string]$Path)
    
    Write-Message "Validating destination path" -Level "Info"
    
    # Check if path is absolute
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        Write-Message "Path must be absolute (e.g. G:\My Drive\docker\project-app)" -Level "Error"
        return $false
    }
    
    # Check if parent directory exists
    $parentPath = Split-Path -Parent $Path
    if (-not (Test-Path -Path $parentPath -PathType Container)) {
        Write-Message "Parent directory does not exist: $parentPath" -Level "Error"
        return $false
    }
    
    # If folder exists, ask for confirmation
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

<#
.SYNOPSIS
    Tests the project name
#>
function Test-ProjectName {
    param([string]$Name)
    
    Write-Message "Validating project name" -Level "Info"
    
    # Validate allowed characters (alphanumeric and hyphens only)
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

# ============================================================================
# FILE OPERATIONS FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Injects selected features into the features block of devcontainer.json.
    Only processes entries that have a non-null feature field.
#>
function Add-FeaturesToConfig {
    param(
        [string]$FilePath,
        [array]$SelectedEntries
    )

    $config = Get-Content -Path $FilePath -Raw | ConvertFrom-Json

    $featuresObj = [ordered]@{}
    foreach ($e in ($SelectedEntries | Where-Object { $null -ne $_.feature } | Sort-Object { $_.feature.url })) {
        $featuresObj[$e.feature.url] = $e.feature.options
    }

    # Rebuild config as a sorted ordered hashtable so 'features' lands alphabetically
    $sortedConfig = [ordered]@{}
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -ne 'features' }) + 'features' | Sort-Object
    foreach ($key in $allKeys) {
        $sortedConfig[$key] = if ($key -eq 'features') { $featuresObj } else { $config.$key }
    }

    $json = $sortedConfig | ConvertTo-Json -Depth 10
    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))

    $featureCount = @($SelectedEntries | Where-Object { $null -ne $_.feature }).Count
    Write-LogEntry "Features injected ($($featureCount) selected)" -Status Success
}

<#
.SYNOPSIS
    Injects mounts into devcontainer.json.
    Always adds the .env secrets mount. Also adds mount fields from selected entries.
#>
function Add-MountsToConfig {
    param(
        [string]$FilePath,
        [array]$SelectedEntries
    )

    $config = Get-Content -Path $FilePath -Raw | ConvertFrom-Json

    $mounts = [System.Collections.ArrayList]@()

    # Always inject the .env secrets mount
    [void]$mounts.Add('source=${localEnv:USERPROFILE}\.config\.env,target=/tmp/.env,type=bind,consistency=cached,readonly')

    # Add mount from each selected entry that declares one
    foreach ($e in ($SelectedEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.mount) })) {
        [void]$mounts.Add($e.mount)
    }

    # Build the mounts JSON array manually to avoid PS5.1 single-element array collapse.
    # ConvertTo-Json serialises [string[]] with one element as a plain string, not an array.
    # Using a placeholder guarantees a trivial, regex-safe substitution that works for any count.
    $mountItems  = @($mounts.ToArray() | ForEach-Object { ConvertTo-Json $_ -Compress })
    $mountsJson  = '[' + ($mountItems -join ',') + ']'
    $placeholder = '__MOUNTS_ARRAY_PLACEHOLDER__'

    # Rebuild config as sorted ordered hashtable so 'mounts' lands alphabetically
    $sortedConfig = [ordered]@{}
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -ne 'mounts' }) + @('mounts') | Sort-Object
    foreach ($key in $allKeys) {
        $sortedConfig[$key] = if ($key -eq 'mounts') { $placeholder } else { $config.$key }
    }

    $json = $sortedConfig | ConvertTo-Json -Depth 10

    # Replace the placeholder string with the real JSON array.
    # Escape '$' so .NET regex treats them as literals, not capture-group back-references.
    $safeArray = $mountsJson -replace '\$', '$$$$'
    $json = $json -replace ('"' + $placeholder + '"'), $safeArray

    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))

    Write-LogEntry "Mounts injected ($($mounts.Count) total)" -Status Success
}

<#
.SYNOPSIS
    Sets SSH_SIGNING_ENABLED in remoteEnv to 'true' or 'false' based on entry selection.
#>
function Set-SshSigningFlag {
    param(
        [string]$FilePath,
        [array]$SelectedEntries
    )

    $enabled = if ($SelectedEntries | Where-Object { $_.key -eq 'ssh-signing' }) { 'true' } else { 'false' }

    $config = Get-Content -Path $FilePath -Raw | ConvertFrom-Json

    $mergedEnv = [ordered]@{}
    foreach ($prop in ($config.remoteEnv.PSObject.Properties | Sort-Object Name)) {
        $mergedEnv[$prop.Name] = if ($prop.Name -eq 'SSH_SIGNING') { $enabled } else { $prop.Value }
    }

    $sortedConfig = [ordered]@{}
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -ne 'remoteEnv' }) + 'remoteEnv' | Sort-Object
    foreach ($key in $allKeys) {
        $sortedConfig[$key] = if ($key -eq 'remoteEnv') { $mergedEnv } else { $config.$key }
    }

    $json = $sortedConfig | ConvertTo-Json -Depth 10
    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))

    Write-LogEntry "SSH_SIGNING set to $enabled" -Status Success
}

<#
.SYNOPSIS
    Replaces project name placeholder in configuration files
#>
function Replace-ProjectNamePlaceholder {
    param(
        [string]$FilePath,
        [string]$ProjectName
    )
    
    if (Test-Path -Path $FilePath -PathType Leaf) {
        Write-Message "Replacing placeholder in $(Split-Path -Leaf $FilePath)" -Level "Info"
        
        $fileContent = Get-Content -Path $FilePath -Raw
        $updatedContent = $fileContent -replace 'project-name', $ProjectName
        Set-Content -Path $FilePath -Value $updatedContent -NoNewline
        
        Write-LogEntry "Placeholder replaced: project-name -> $ProjectName" -Status Success
    }
}

<#
.SYNOPSIS
    Copies configuration files to destination
#>
function Copy-ConfigurationFiles {
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ProjectName,
        [bool]$UseCompose,
        [array]$SelectedEntries
    )
    
    Write-Message "Creating folder structure" -Level "Info"
    
    $destDevContainerPath = Join-Path -Path $Destination -ChildPath $DevContainerFolderName

    # Create destination folder if not exists
    if (-not (Test-Path -Path $Destination -PathType Container)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Write-Message "Folder created: $Destination" -Level "Success"
    }

    # Create .devcontainer folder
    if (-not (Test-Path -Path $destDevContainerPath -PathType Container)) {
        New-Item -ItemType Directory -Path $destDevContainerPath -Force | Out-Null
        Write-Message "Folder created: $destDevContainerPath" -Level "Success"
    }

    # Copy configuration files
    Write-Message "Copying configuration files" -Level "Info"

    $filesToCopy = @(
        $DockerIgnoreFile,
        $DockerfileName
    )

    # Copy .dockerignore and Dockerfile from the source folder
    foreach ($file in $filesToCopy) {
        $sourceFile = Join-Path -Path $Source -ChildPath $file
        $destFile = Join-Path -Path $destDevContainerPath -ChildPath $file

        # Create subdirectories if needed
        $destFileDir = Split-Path -Parent $destFile
        if (-not (Test-Path -Path $destFileDir -PathType Container)) {
            New-Item -ItemType Directory -Path $destFileDir -Force | Out-Null
        }

        if (Test-Path -Path $sourceFile -PathType Leaf) {
            Copy-Item -Path $sourceFile -Destination $destFile -Force
            Write-LogEntry $file -Status Success
        }
        else {
            Write-LogEntry "File not found: $file" -Status Warning
        }
    }

    # Copy devcontainer.json based on project configuration
    Write-Message "Copying devcontainer.json" -Level "Info"

    if ($UseCompose) {
        $sourceDevContainerConfig = Join-Path -Path $Source -ChildPath $DevContainerJsonCompose
        $configLabel = "devcontainer.json (from compose template)"
        $missingMsg  = "Missing $DevContainerJsonCompose"
    } else {
        $sourceDevContainerConfig = Join-Path -Path $Source -ChildPath $DevContainerJson
        $configLabel = "devcontainer.json (from standard template)"
        $missingMsg  = "Missing devcontainer.json"
    }

    $destDevContainerConfig = Join-Path -Path $destDevContainerPath -ChildPath $DevContainerJson

    if (Test-Path -Path $sourceDevContainerConfig -PathType Leaf) {
        Copy-Item -Path $sourceDevContainerConfig -Destination $destDevContainerConfig -Force
        Write-LogEntry $configLabel -Status Success
        Replace-ProjectNamePlaceholder -FilePath $destDevContainerConfig -ProjectName $ProjectName
        Add-FeaturesToConfig -FilePath $destDevContainerConfig -SelectedEntries $SelectedEntries
        Add-MountsToConfig -FilePath $destDevContainerConfig -SelectedEntries $SelectedEntries
        Set-SshSigningFlag -FilePath $destDevContainerConfig -SelectedEntries $SelectedEntries
    } else {
        Write-LogEntry $missingMsg -Status Error
        throw $missingMsg
    }
}


# ============================================================================
# USER INPUT COLLECTION
# ============================================================================

$useCompose = Get-ProjectTypeSelection
$entryManifest    = Get-EntryManifest
$selectedEntries  = Select-Features -Manifest $entryManifest

Write-Section "DevContainer Setup - Initial Configuration"

# Collect Destination Path
if (-not $DestinationPath) {
    Write-Host ""
    Write-Message "Enter absolute path for destination folder" -Level "Highlight"
    Write-Host "Example: G:\My Drive\docker\project-app" -ForegroundColor "DarkGray"
    Write-Host ""
    
    $DestinationPath = Read-Host "Destination path"
    
    if ([string]::IsNullOrWhiteSpace($DestinationPath)) {
        Write-Message "Path not provided. Script cancelled" -Level "Error"
        exit 1
    }
}

# Collect Project Name
if (-not $ProjectName) {
    Write-Host ""
    Write-Message "Enter project name" -Level "Highlight"
    Write-Host "Example: project-app" -ForegroundColor "DarkGray"
    Write-Host ""
    
    $ProjectName = Read-Host "Project name"
    
    if ([string]::IsNullOrWhiteSpace($ProjectName)) {
        Write-Message "Project name not provided. Script cancelled" -Level "Error"
        exit 1
    }
}

# ============================================================================
# INPUT VALIDATION
# ============================================================================

Write-Section "Input Validation"

if (-not (Test-DestinationPath -Path $DestinationPath)) {
    exit 1
}

if (-not (Test-ProjectName -Name $ProjectName)) {
    exit 1
}

# ============================================================================
# EXECUTION
# ============================================================================

Write-Section "DevContainer Configuration"

try {
    # Copy files and generate devcontainer.json
    Copy-ConfigurationFiles -Source $SourceDevContainerPath -Destination $DestinationPath -ProjectName $ProjectName -UseCompose $useCompose -SelectedEntries $selectedEntries
    
    # Final summary
    Write-Section "Setup Completed"
    
    Write-Host ""
    Write-Message "Configuration details" -Level "Info"
    Write-Host "  - Destination folder: " -ForegroundColor "DarkGray" -NoNewline
    Write-Host "$DestinationPath" -ForegroundColor $Colors["Highlight"]
    Write-Host "  - Project name: " -ForegroundColor "DarkGray" -NoNewline
    Write-Host "$ProjectName" -ForegroundColor $Colors["Highlight"]
    Write-Host "  - DevContainer path: " -ForegroundColor "DarkGray" -NoNewline
    Write-Host "$(Join-Path -Path $DestinationPath -ChildPath $DevContainerFolderName)" -ForegroundColor $Colors["Highlight"]
    Write-Host ""
    
    Write-Message "Configuration files copied and configured successfully" -Level "Success"
    Write-Message "You can now open the folder in VS Code and use the devcontainer" -Level "Info"
    Write-Host ""
}
catch {
    Write-Section "Execution Error"
    Write-Message "An error occurred: $($_.Exception.Message)" -Level "Error"
    Write-Message "Stack trace: $($_.ScriptStackTrace)" -Level "Warning"
    exit 1
}
