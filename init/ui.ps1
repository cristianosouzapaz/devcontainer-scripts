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

# The local secrets file, in the two notations it is shown and written in: the
# devcontainer.json placeholder that ends up in the generated mount, and the
# %USERPROFILE% form a user recognises. Paired here so the selector, the summary
# and the generated file can never drift apart.
$SecretsPathLocalValue   = '${localEnv:USERPROFILE}\.config\.env'
$SecretsPathLocalDisplay = '%USERPROFILE%\.config\.env'

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
    $index = Select-Option -Title "Project Type Selection" -Options $options -Default 0
    return ($index -eq 1)
}

function Format-SecretsPathForDisplay {
    <#
    .SYNOPSIS
        Renders a secrets file mount source for the console.
    .DESCRIPTION
        The local default is stored as the devcontainer.json placeholder
        ${localEnv:USERPROFILE}\.config\.env, which is what has to reach the
        generated file but is not what the user picked it by. Shows that one
        value as %USERPROFILE%\.config\.env — the same string the selector
        offered — so the summary at the end of a run does not name the local
        path in a notation that appeared nowhere else. Every other path is
        already literal and is returned untouched.
    .PARAMETER SecretsPath
        The mount source to render.
    .OUTPUTS
        System.String — the path as it should be shown to the user.
    #>
    param([string]$SecretsPath)
    if ($SecretsPath -eq $SecretsPathLocalValue) { return $SecretsPathLocalDisplay }
    return $SecretsPath
}

function Get-SecretsPathSelection {
    <#
    .SYNOPSIS
        Prompts the user to choose the secrets file mount source.
    .DESCRIPTION
        Docker resolves a bind mount's `source=` on the daemon's filesystem, so the
        secrets path must match where the Docker daemon runs, not the client. Offers
        the local Windows default, an optional remote Docker host path read from the
        DEVCONTAINER_SECRETS_PATH environment variable, and a manual entry fallback.
    .OUTPUTS
        System.String — the chosen (or typed) secrets file mount source.
    #>
    # Label and value are aligned on column 31, matching the extra-folder legend;
    # Select-Option prints each option behind a four-character cursor prefix.
    $values  = @($SecretsPathLocalValue)
    $options = @(('{0,-27}{1}' -f 'Local Docker', $SecretsPathLocalDisplay))

    $remotePath = $env:DEVCONTAINER_SECRETS_PATH
    if (-not [string]::IsNullOrWhiteSpace($remotePath)) {
        $values  += $remotePath
        $options += ('{0,-27}{1}' -f 'Remote Docker host', $remotePath)
    }

    $options += ('{0,-27}{1}' -f 'Other', 'enter the path manually')

    $index = Select-Option -Title "Secrets File Location" -Options $options -Default 0

    if ($index -lt $values.Count) {
        return $values[$index]
    }

    # Select-Option clears the screen on its way out, so the free-text fallback
    # has to reintroduce itself — otherwise the prompt lands alone on a blank
    # terminal. Mirrors the header Get-DockerContextInput prints for its own.
    Write-Section "Secrets File Location"
    Write-Host "  Where the .env file holding the container's credentials lives." -ForegroundColor "DarkGray"
    Write-Host "  Docker resolves this on the machine the daemon runs on, so give" -ForegroundColor "DarkGray"
    Write-Host "  a path on that machine (e.g. /srv/data/.config/.env) when it is" -ForegroundColor "DarkGray"
    Write-Host "  not this one. Not verified either way." -ForegroundColor "DarkGray"
    Write-Host ""

    $entered = Read-Host "Secrets file path"
    if ([string]::IsNullOrWhiteSpace($entered)) {
        Write-Message "No path given. Falling back to $SecretsPathLocalDisplay." -Level "Warning"
        return $SecretsPathLocalValue
    }
    return $entered.Trim()
}

function Get-DockerContextInput {
    <#
    .SYNOPSIS
        Prompts the user for an optional Docker CLI context name to pin the
        generated project to.
    .DESCRIPTION
        The context name cannot be reached through launcher.ps1, which invokes
        project-init.ps1 without parameters, so the DEVCONTAINER_DOCKER_CONTEXT
        environment variable carries the workstation's daemon — the same escape
        hatch DEVCONTAINER_SECRETS_PATH provides for the secrets file.

        Unset, this is a free-text prompt (not Select-Option — the value is an
        arbitrary name, not a short enumeration). Set, it becomes the arrow
        selector, defaulting to None: pinning a project to a remote daemon stays
        a deliberate act, and Enter keeps today's behaviour. Other falls through
        to the same free-text prompt.

        Left blank (or None), the project inherits whatever Docker context is
        active on the machine that opens it; a chosen name is written verbatim
        into the generated .vscode/settings.json, honoured only by the VS Code
        Container Tools extension.
    .OUTPUTS
        System.String — the trimmed context name, or an empty string when the
        response is blank, whitespace-only, or None.
    #>
    $envContext = $env:DEVCONTAINER_DOCKER_CONTEXT
    if (-not [string]::IsNullOrWhiteSpace($envContext)) {
        $envContext = $envContext.Trim()

        # Label and value are aligned on column 31, matching the secrets selector.
        $options = @(
            ('{0,-27}{1}' -f 'None', 'use whichever context is active')
            ('{0,-27}{1}' -f 'Remote Docker host', $envContext)
            ('{0,-27}{1}' -f 'Other', 'enter a name manually')
        )
        $index = Select-Option -Title "Docker Context" -Options $options -Default 0

        if ($index -eq 0) { return '' }
        if ($index -eq 1) { return $envContext }
    }

    Write-Section "Docker Context"
    Write-Host "  Pins this project to a named Docker CLI context (see 'docker context ls')," -ForegroundColor "DarkGray"
    Write-Host "  instead of whatever context happens to be active when VS Code opens it." -ForegroundColor "DarkGray"
    Write-Host "  Leave blank to skip the pin. Requires the VS Code Container Tools" -ForegroundColor "DarkGray"
    Write-Host "  extension — otherwise the setting is ignored." -ForegroundColor "DarkGray"
    Write-Host ""

    $entered = Read-Host "Docker context name (blank to skip)"
    if ([string]::IsNullOrWhiteSpace($entered)) {
        return ''
    }
    return $entered.Trim()
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

function Select-Option {
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
