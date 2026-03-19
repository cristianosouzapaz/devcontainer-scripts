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

