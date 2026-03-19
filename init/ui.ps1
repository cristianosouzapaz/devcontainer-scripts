#Requires -Version 5.1
<#
.SYNOPSIS
    UI utility functions: console output helpers and interactive prompts.
#>

$Colors = @{
    Success   = "Green"
    Error     = "Red"
    Warning   = "Yellow"
    Info      = "Cyan"
    Header    = "Magenta"
    Highlight = "White"
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

function Get-ProjectTypeSelection {
    <#
    .SYNOPSIS
        Prompts the user to choose between a standard or Docker Compose project type.
    .OUTPUTS
        System.Boolean — $true for Docker Compose, $false for standard single-container.
    #>
    $options = @(
        "Standard (single container)",
        "Docker Compose (multi-container)"
    )
    $index = Select-ProjectType -Title "Project Type Selection" -Options $options -Default 0
    return ($index -eq 1)
}

function Select-Features {
    <#
    .SYNOPSIS
        Presents an interactive terminal UI for selecting optional devcontainer features.
    .DESCRIPTION
        Mandatory entries are always included. Optional entries are displayed as a
        toggleable checklist navigated with arrow keys, Space to toggle, and Enter
        to confirm. Returns the combined set of mandatory plus chosen optional entries.

        Key bindings (VirtualKeyCode):
          38 — VK_UP     : move cursor up
          40 — VK_DOWN   : move cursor down
          32 — VK_SPACE  : toggle the item under the cursor
          13 — VK_RETURN : confirm selection and exit the loop
    .PARAMETER Manifest
        Array of entry objects loaded from the manifest (see Get-EntryManifest).
    .OUTPUTS
        Array of selected entry objects (mandatory + toggled-on optional).
    #>
    param($Manifest)

    $mandatory = @($Manifest | Where-Object { $_.mandatory -eq $true })
    $optional  = @($Manifest | Where-Object { $_.mandatory -ne $true })

    $state  = @{}
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

        $key = _Get-RawKey
        switch ($key.VirtualKeyCode) {
            38 { if ($cursor -gt 0) { $cursor-- } }
            40 { if ($cursor -lt ($optional.Count - 1)) { $cursor++ } }
            32 { $k = $optional[$cursor].key; $state[$k] = -not $state[$k] }
            13 { $done = $true }
        }
    }

    $selected = [System.Collections.ArrayList]@()
    foreach ($f in $mandatory) { [void]$selected.Add($f) }
    foreach ($f in $optional)  { if ($state[$f.key]) { [void]$selected.Add($f) } }
    return $selected.ToArray()
}

function Select-ProjectType {
    <#
    .SYNOPSIS
        Presents an interactive terminal UI for selecting one option from a list.
    .DESCRIPTION
        Displays a list with a movable cursor. Navigate with Up/Down arrows,
        Enter confirms the highlighted selection.

        Key bindings (VirtualKeyCode):
          38 — VK_UP     : move cursor up
          40 — VK_DOWN   : move cursor down
          13 — VK_RETURN : confirm selection and exit the loop
    .PARAMETER Title
        Section title displayed above the options.
    .PARAMETER Options
        Array of option label strings.
    .PARAMETER Default
        Zero-based index of the pre-selected option. Defaults to 0.
    .OUTPUTS
        System.Int32 — zero-based index of the confirmed selection.
    #>
    param(
        [string]$Title,
        [string[]]$Options,
        [int]$Default = 0
    )

    $cursor = $Default
    $done   = $false

    while (-not $done) {
        Clear-Host
        Write-Host ""
        Write-Host $Title -ForegroundColor $Colors['Header']
        Write-Host ""
        Write-Host "  Up/Down to navigate, Enter to confirm:" -ForegroundColor $Colors['Info']
        Write-Host ""

        for ($i = 0; $i -lt $Options.Length; $i++) {
            if ($i -eq $cursor) {
                Write-Host "  > $($Options[$i])" -ForegroundColor $Colors['Success']
            } else {
                Write-Host "    $($Options[$i])" -ForegroundColor $Colors['Highlight']
            }
        }
        Write-Host ""

        $key = _Get-RawKey
        switch ($key.VirtualKeyCode) {
            38 { if ($cursor -gt 0) { $cursor-- } }
            40 { if ($cursor -lt ($Options.Length - 1)) { $cursor++ } }
            13 { $done = $true }
        }
    }

    return $cursor
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
