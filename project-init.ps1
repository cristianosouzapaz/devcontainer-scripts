#Requires -Version 5.1
<#
.SYNOPSIS
    Initialises a new DevContainer project from the local template.

.DESCRIPTION
    Copies .devcontainer files to the destination, substitutes the project name,
    injects selected devcontainer features and mounts, and sets SSH signing flag.

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
$SourceDevContainerPath = $PSScriptRoot
$DevContainerFolderName = ".devcontainer"
$DockerIgnoreFile       = ".dockerignore"
$DockerfileName         = "Dockerfile"
$DevContainerJson       = "devcontainer.json"
$DevContainerJsonCompose = "devcontainer-compose.json"
$EntryManifestPath      = Join-Path -Path $PSScriptRoot -ChildPath "devcontainer.entries.json"

$Colors = @{
    Success   = "Green"
    Error     = "Red"
    Warning   = "Yellow"
    Info      = "Cyan"
    Header    = "Magenta"
    Highlight = "White"
}

function Write-Section {
    <#
    .SYNOPSIS
        Prints a blank-line-padded section header to the console.
    .PARAMETER Title
        Text to display as the section title. If empty, only blank lines are printed.
    #>
    param([string]$Title)
    Write-Host ""
    if ($Title) { Write-Host $Title -ForegroundColor $Colors['Header'] }
    Write-Host ""
}

function Write-Message {
    <#
    .SYNOPSIS
        Prints a timestamped message to the console with a colour based on severity level.
    .PARAMETER Message
        The text to display.
    .PARAMETER Level
        Severity level key that maps to a colour in $Colors (Success, Error, Warning, Info, Highlight).
        Defaults to "Info".
    #>
    param([string]$Message, [string]$Level = "Info")
    $color = if ($Colors[$Level]) { $Colors[$Level] } else { $Colors["Info"] }
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')]" -ForegroundColor "DarkGray" -NoNewline
    Write-Host " $Message" -ForegroundColor $color
}

function Write-LogEntry {
    <#
    .SYNOPSIS
        Prints a single indented log line prefixed with a status indicator symbol.
    .PARAMETER Message
        The text to display.
    .PARAMETER Status
        One of Success ([+]), Error ([-]), or Warning ([!]). Determines both the prefix
        symbol and the line colour. Defaults to Success.
    #>
    param(
        [string]$Message,
        [ValidateSet('Success', 'Error', 'Warning')]
        [string]$Status = 'Success'
    )
    $indicator = switch ($Status) { 'Success' { '[+]' } 'Error' { '[-]' } 'Warning' { '[!]' } }
    Write-Host "  $indicator " -NoNewline
    Write-Host $Message -ForegroundColor $Colors[$Status]
}

function Format-Json {
    <#
    .SYNOPSIS
        Pretty-prints a JSON string with 4-space indentation.
    .DESCRIPTION
        Uses a two-pass character-level approach to avoid the depth limit and
        whitespace quirks of ConvertTo-Json / ConvertFrom-Json round-trips.
        Pass 1 strips all whitespace outside string literals (flattens the JSON).
        Pass 2 re-emits the flat JSON with consistent indentation and newlines.
    .PARAMETER Json
        The raw JSON string to format.
    .OUTPUTS
        System.String — the formatted JSON string (no trailing newline).
    #>
    param([string]$Json)

    # Pass 1 — flatten: remove all whitespace outside string literals.
    # $inStr tracks whether the current character is inside a quoted string;
    # $esc tracks whether the previous character was a backslash escape.
    $flat  = [System.Text.StringBuilder]::new($Json.Length)
    $inStr = $false
    $esc   = $false
    foreach ($c in $Json.ToCharArray()) {
        if ($esc)                   { [void]$flat.Append($c); $esc = $false; continue }
        if ($c -eq '\' -and $inStr) { [void]$flat.Append($c); $esc = $true;  continue }
        if ($c -eq '"')             { $inStr = -not $inStr; [void]$flat.Append($c); continue }
        if ($inStr)                 { [void]$flat.Append($c); continue }
        if ($c -ne ' ' -and $c -ne "`t" -and $c -ne "`r" -and $c -ne "`n") {
            [void]$flat.Append($c)
        }
    }

    # Pass 2 — re-serialize with 4-space indentation.
    # Structural characters ({, }, [, ]) adjust $depth and insert newlines;
    # empty objects/arrays ({} and []) are kept on a single line.
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
            [void]$out.Append($c); $i++; continue
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

function Get-EntryManifest {
    <#
    .SYNOPSIS
        Loads and returns the devcontainer entry manifest as an array of objects.
    .OUTPUTS
        Array of PSCustomObject entries parsed from devcontainer.entries.json.
    #>
    if (-not (Test-Path -Path $EntryManifestPath -PathType Leaf)) {
        Write-Message "Entry manifest not found: $EntryManifestPath" -Level "Error"
        throw "Missing devcontainer.entries.json"
    }
    return @(Get-Content -Path $EntryManifestPath -Raw | ConvertFrom-Json)
}

function _Get-RawKey {
    <#
    .SYNOPSIS
        Reads a single raw keypress from the console.
    .DESCRIPTION
        Thin wrapper around $Host.UI.RawUI.ReadKey extracted so that tests can
        mock the function and inject a synthetic key sequence without needing to
        interact with the real console host.
    .OUTPUTS
        System.Management.Automation.Host.KeyInfo — the key that was pressed.
    #>
    return $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

function Select-Features {
    <#
    .SYNOPSIS
        Presents an interactive terminal UI for selecting optional devcontainer features.
    .DESCRIPTION
        Mandatory entries are always included. Optional entries are displayed as a
        toggleable checklist navigated with arrow keys, Space to toggle, and Enter
        to confirm. Returns the combined set of mandatory plus chosen optional entries.
    .PARAMETER Manifest
        Array of entry objects loaded from the manifest (see Get-EntryManifest).
    .OUTPUTS
        Array of selected entry objects (mandatory + toggled-on optional).
    #>
    param($Manifest)

    $mandatory = @($Manifest | Where-Object { $_.mandatory -eq $true })
    $optional  = @($Manifest | Where-Object { $_.mandatory -ne $true })

    # Initialise toggle state from each entry's default value.
    $state  = @{}
    foreach ($f in $optional) { $state[$f.key] = [bool]$f.default }

    $cursor = 0
    $done   = $false

    # Keyboard-driven selection loop: redraws the list on every keypress.
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

        $key = _Get-RawKey
        switch ($key.VirtualKeyCode) {
            38 { if ($cursor -gt 0) { $cursor-- } }                             # UpArrow
            40 { if ($cursor -lt ($optional.Count - 1)) { $cursor++ } }         # DownArrow
            32 { $k = $optional[$cursor].key; $state[$k] = -not $state[$k] }    # Space
            13 { $done = $true }                                                 # Enter
        }
    }

    $selected = [System.Collections.ArrayList]@()
    foreach ($f in $mandatory) { [void]$selected.Add($f) }
    foreach ($f in $optional)  { if ($state[$f.key]) { [void]$selected.Add($f) } }
    return $selected.ToArray()
}

function Get-ProjectTypeSelection {
    <#
    .SYNOPSIS
        Prompts the user to choose between a standard or Docker Compose project type.
    .OUTPUTS
        System.Boolean — $true for Docker Compose, $false for standard single-container.
    #>
    Write-Section "Project Type Selection"
    $selection = $null
    while ($null -eq $selection) {
        Write-Host ""
        Write-Message "Select project type:" -Level "Highlight"
        Write-Host "  1) Standard (single container)"
        Write-Host "  2) Docker Compose (multi-container)"
        switch (Read-Host "Enter choice [1-2]") {
            '1' { $selection = $false }
            '2' { $selection = $true }
            default { Write-Message "Please enter 1 or 2." -Level "Warning" }
        }
    }
    return $selection
}

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

    $config = Get-Content -Path $FilePath -Raw | ConvertFrom-Json

    # Build a URL-keyed ordered hashtable of features sorted for stable output.
    $featuresObj = [ordered]@{}
    foreach ($e in ($SelectedEntries | Where-Object { $null -ne $_.feature } | Sort-Object { $_.feature.url })) {
        $featuresObj[$e.feature.url] = $e.feature.options
    }

    # Re-assemble the config with all keys alphabetically sorted, placing the
    # new features object in place of the original property.
    $sortedConfig = [ordered]@{}
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -ne 'features' }) + 'features' | Sort-Object
    foreach ($key in $allKeys) {
        $sortedConfig[$key] = if ($key -eq 'features') { $featuresObj } else { $config.$key }
    }

    $json = $sortedConfig | ConvertTo-Json -Depth 10
    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))

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

    $config = Get-Content -Path $FilePath -Raw | ConvertFrom-Json

    $mounts = [System.Collections.ArrayList]@()
    [void]$mounts.Add('source=${localEnv:USERPROFILE}\.config\.env,target=/tmp/.env,type=bind,consistency=cached,readonly')
    foreach ($e in ($SelectedEntries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.mount) })) {
        [void]$mounts.Add($e.mount)
    }

    # Build the raw JSON array string for the mounts, with each string value
    # properly escaped via ConvertTo-Json -Compress.
    $mountsJson  = '[' + (@($mounts.ToArray() | ForEach-Object { ConvertTo-Json $_ -Compress }) -join ',') + ']'
    $placeholder = '__MOUNTS_ARRAY_PLACEHOLDER__'

    # Insert a quoted placeholder string so ConvertTo-Json produces valid JSON,
    # then perform a literal string replacement to inject the real array.
    $sortedConfig = [ordered]@{}
    $allKeys = @($config.PSObject.Properties.Name | Where-Object { $_ -ne 'mounts' }) + @('mounts') | Sort-Object
    foreach ($key in $allKeys) {
        $sortedConfig[$key] = if ($key -eq 'mounts') { $placeholder } else { $config.$key }
    }

    $json = ($sortedConfig | ConvertTo-Json -Depth 10).Replace(('"' + $placeholder + '"'), $mountsJson)
    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))

    Write-LogEntry "Mounts injected ($($mounts.Count) total)" -Status Success
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
    $raw = (Get-Content -Path $FilePath -Raw) -replace '"SSH_SIGNING":\s*"(?:true|false)"', ('"SSH_SIGNING": "' + $enabled + '"')
    [System.IO.File]::WriteAllText($FilePath, $raw)

    Write-LogEntry "SSH_SIGNING set to $enabled" -Status Success
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
        Set-Content -Path $FilePath -Value ((Get-Content -Path $FilePath -Raw) -replace 'project-name', $ProjectName) -NoNewline
        Write-LogEntry "project-name -> $ProjectName" -Status Success
    }
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
        features, mounts, and the SSH signing flag.
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
    #>
    param(
        [string]$Source,
        [string]$Destination,
        [string]$ProjectName,
        [bool]$UseCompose,
        [array]$SelectedEntries
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
    } else {
        Write-LogEntry "Template not found: $srcConfig" -Status Error
        throw "Missing template: $srcConfig"
    }
}

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

# ----- VALIDATION -------------------------------------------------------------

Write-Section "Input Validation"

if (-not (Test-DestinationPath -Path $DestinationPath)) { exit 1 }
if (-not (Test-ProjectName     -Name $ProjectName))      { exit 1 }

# ----- EXECUTION --------------------------------------------------------------

Write-Section "DevContainer Configuration"

try {
    Copy-ConfigurationFiles -Source $SourceDevContainerPath -Destination $DestinationPath `
        -ProjectName $ProjectName -UseCompose $useCompose -SelectedEntries $selectedEntries

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
