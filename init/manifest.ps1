#Requires -Version 5.1
<#
.SYNOPSIS
    Functions for loading the devcontainer entry manifest.
#>

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

function Get-CodingAgentEntries {
    <#
    .SYNOPSIS
        Lists the coding agents from their packs, as entries Select-Features can show.
    .DESCRIPTION
        One entry per <id>/agent.json under $CodingAgentPacksPath, sorted by id: the
        folder name is the key, the pack's label the label. A pack declaring
        "default": true is pre-selected, the same packs setup installs when
        CODING_AGENTS is unset.
    .OUTPUTS
        Array of PSCustomObject entries with key, label, mandatory and default.
    #>
    $packs = @(Get-ChildItem -Path $CodingAgentPacksPath -Filter "agent.json" -Recurse -Depth 1 -File -ErrorAction SilentlyContinue |
        Sort-Object { $_.Directory.Name })
    if ($packs.Count -eq 0) {
        Write-Message "No coding agent packs found under: $CodingAgentPacksPath" -Level "Error"
        throw "Missing coding agent packs"
    }
    return @($packs | ForEach-Object {
        $pack = Get-Content -Path $_.FullName -Raw | ConvertFrom-Json
        [PSCustomObject]@{
            key       = $_.Directory.Name
            label     = $pack.label
            mandatory = $false
            default   = ($pack.default -eq $true)
        }
    })
}

