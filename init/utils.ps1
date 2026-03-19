#Requires -Version 5.1
<#
.SYNOPSIS
    Shared utility functions used by multiple init modules.
.DESCRIPTION
    Loaded first by project-init.ps1 so that config.ps1 and repos.ps1 can call
    these helpers without cross-module dependencies.
#>

# ----- PRIVATE HELPERS --------------------------------------------------------

function _Get-RepoFolderName {
    <#
    .SYNOPSIS
        Extracts the last URL path segment without the .git extension.
    .DESCRIPTION
        Used by both config.ps1 (Set-OnCreateCommandInConfig) and repos.ps1.
        Defined here to avoid a cross-module dependency between those two files.
    .PARAMETER Url
        Fully normalised repository URL (https://host/owner/repo.git).
    #>
    param([string]$Url)
    $segment = $Url.Split('/')[-1]
    return $segment -replace '\.git$', ''
}

# ----- PUBLIC FUNCTIONS -------------------------------------------------------

function ConvertTo-JsonStringArray {
    <#
    .SYNOPSIS
        Serialises an array of strings as a compact JSON array string.
    .DESCRIPTION
        Converts each element with ConvertTo-Json -Compress so that special
        characters are properly escaped, then joins them into a JSON array literal.
        Used with the placeholder replacement technique in Write-JsonFile when a
        raw JSON array cannot be stored as a native PowerShell value inside an
        ordered hashtable destined for ConvertTo-Json.
    .PARAMETER Items
        The string values to serialise.
    .OUTPUTS
        System.String — e.g. ["item1","item 2"]
    #>
    param([object[]]$Items)
    return '[' + (@($Items | ForEach-Object { ConvertTo-Json $_ -Compress }) -join ',') + ']'
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

function Read-JsonFile {
    <#
    .SYNOPSIS
        Reads and parses a JSON file, returning a PSCustomObject.
    .PARAMETER FilePath
        Absolute path to the JSON file.
    .OUTPUTS
        PSCustomObject — the deserialised JSON root object.
    #>
    param([string]$FilePath)
    return Get-Content -Path $FilePath -Raw | ConvertFrom-Json
}

function Set-ConfigProperty {
    <#
    .SYNOPSIS
        Returns an alphabetically-sorted ordered hashtable derived from a
        PSCustomObject, with one key inserted or replaced.
    .DESCRIPTION
        Projects the incoming PSCustomObject (typically from Read-JsonFile) into an
        [ordered] hashtable with all keys sorted alphabetically. The target key is
        included in the sort even when it did not previously exist (upsert semantics).
        All other properties are copied verbatim from the source object.
    .PARAMETER Config
        The source PSCustomObject (from Read-JsonFile / ConvertFrom-Json).
    .PARAMETER Key
        The top-level key to insert or replace.
    .PARAMETER Value
        The new value for that key.
    .OUTPUTS
        [ordered] hashtable ready for Write-JsonFile or ConvertTo-Json.
    #>
    param($Config, [string]$Key, $Value)
    $sortedConfig = [ordered]@{}
    $allKeys = @($Config.PSObject.Properties.Name | Where-Object { $_ -ne $Key }) + @($Key) | Sort-Object
    foreach ($k in $allKeys) {
        $sortedConfig[$k] = if ($k -eq $Key) { $Value } else { $Config.$k }
    }
    return $sortedConfig
}

function Write-JsonFile {
    <#
    .SYNOPSIS
        Serialises a config object to a pretty-printed JSON file, applying optional
        raw-string replacements before formatting.
    .DESCRIPTION
        Converts Config to JSON with ConvertTo-Json -Depth 10, applies each entry in
        Replacements (placeholder string → raw JSON fragment), runs Format-Json, and
        writes the result with a trailing newline via [System.IO.File]::WriteAllText.

        Replacements are used to inject raw JSON structures (e.g. string arrays) that
        ConvertTo-Json would otherwise double-encode as escaped strings. The caller
        stores a unique placeholder string as the value for a given key in Config,
        then passes the desired JSON fragment as the corresponding Replacements value.

        Note: [System.IO.File]::WriteAllText is used throughout (not Set-Content) for
        consistent UTF-8 encoding without a byte-order mark across all file writes.
    .PARAMETER FilePath
        Absolute path to the destination file.
    .PARAMETER Config
        The config object or ordered hashtable to serialise.
    .PARAMETER Replacements
        Optional hashtable mapping placeholder strings to raw JSON fragments.
        Example: @{ '__PLACEHOLDER__' = '["a","b"]' }
    #>
    param(
        [string]$FilePath,
        [object]$Config,
        [hashtable]$Replacements = @{}
    )
    $json = $Config | ConvertTo-Json -Depth 10
    foreach ($placeholder in $Replacements.Keys) {
        $json = $json.Replace(('"' + $placeholder + '"'), $Replacements[$placeholder])
    }
    $json = Format-Json -Json $json
    [System.IO.File]::WriteAllText($FilePath, ($json + [System.Environment]::NewLine))
}
