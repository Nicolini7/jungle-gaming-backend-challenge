#Requires -Version 5.1
<#
.SYNOPSIS
Creates a source-only delivery ZIP, verifies its contents and writes SHA-256 manifests.
.EXAMPLE
pwsh -NoProfile -File ./scripts/package-delivery.ps1
.EXAMPLE
pwsh -NoProfile -File ./scripts/package-delivery.ps1 -OutputPath .artifacts/delivery-test.zip -Force
#>
[CmdletBinding()]
param(
    [string]$OutputPath = 'output/jungle-backend-challenge.zip',
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$rootPrefix = $projectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$pathComparison = [StringComparison]::OrdinalIgnoreCase
$archiveRoot = 'jungle-backend-challenge'
$utf8 = [Text.UTF8Encoding]::new($false)
$sourceDirectories = @('src', 'tests', 'examples', 'scripts', '.github', 'docker', 'docs/load')
$publishedDocumentFiles = @(
    'docs/CHALLENGE.md', 'docs/VALIDATION.md', 'docs/EVENT-CONSUMER.md',
    'docs/ENHANCEMENTS.md', 'docs/ENHANCEMENTS.en.md'
)
$publishedDocuments = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in $publishedDocumentFiles) { [void]$publishedDocuments.Add($name) }
$sourceFiles = @(
    'package.json', 'bun.lock', 'tsconfig.json', 'Dockerfile', 'compose.yaml', 'compose.test.yaml',
    '.dockerignore', '.gitignore', '.gitattributes', '.env.example', '.bun-version', 'README.md', 'ARCHITECTURE.md',
    'compose.validation.yaml',
    'LICENSE', 'LICENSE.md'
) + $publishedDocumentFiles
$requiredFiles = @(
    'package.json', 'bun.lock', 'tsconfig.json', 'Dockerfile', 'compose.yaml', 'compose.test.yaml',
    '.env.example', '.gitattributes', 'compose.validation.yaml', 'README.md', 'ARCHITECTURE.md',
    'docs/CHALLENGE.md', 'docs/VALIDATION.md', 'docs/EVENT-CONSUMER.md',
    'src/main.ts', '.github/workflows/ci.yml', 'scripts/package-delivery.ps1',
    'scripts/setup.ts', 'docker/postgres-init.sh', 'docker/postgres-upgrade.sh'
)
$blockedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('.git', 'node_modules', '.local', '.artifacts', '.tools', 'output', 'outputs', 'dist', 'coverage', 'tmp', 'temp', '__pycache__')) {
    [void]$blockedDirectories.Add($name)
}
$allowedExtensions = @('.ts', '.json', '.ps1', '.yaml', '.yml', '.sh', '.sql', '.toml')
$knownSecretPatterns = @(
    '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----',
    '(?:AKIA|ASIA)[A-Z0-9]{16}',
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{40,}',
    'sk-(?:proj-)?[A-Za-z0-9_-]{24,}'
)

function Assert-ProjectPath([string]$AbsolutePath) {
    if (-not $AbsolutePath.StartsWith($rootPrefix, $pathComparison)) {
        throw 'Path must stay inside this project.'
    }
}

function Get-RelativeSourcePath([string]$AbsolutePath) {
    Assert-ProjectPath $AbsolutePath
    return $AbsolutePath.Substring($rootPrefix.Length).Replace('\', '/')
}

function Test-SensitiveName([string]$RelativePath) {
    if ($RelativePath -eq '.env.example') { return $false }
    $leaf = ($RelativePath -split '/')[-1]
    return $leaf -match '(?i)^(\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|service[-_]account(?:\..*)?)$' -or
        $leaf -match '(?i)\.(pem|key|p12|pfx|jks|db|sqlite|sqlite3|dump|bak|log|zip|7z|tar|gz|exe|dll|msi|msix|nupkg|whl)$'
}

function Test-PublishedDocument([string]$RelativePath) {
    if ($publishedDocuments.Contains($RelativePath)) { return $true }
    return $RelativePath -match '^docs/load/(README\.md|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$'
}

function Assert-SourcePath([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.StartsWith('/') -or $RelativePath.Contains('\') -or $RelativePath.Contains(':')) {
        throw 'Invalid archive source path.'
    }
    foreach ($part in ($RelativePath -split '/')) {
        if ($part -in @('', '.', '..') -or $blockedDirectories.Contains($part)) {
            throw "Excluded runtime/output path selected: $RelativePath"
        }
    }
    if (Test-SensitiveName $RelativePath) { throw "Sensitive file selected: $RelativePath" }
    if ($RelativePath.StartsWith('docs/', [StringComparison]::OrdinalIgnoreCase) -and -not (Test-PublishedDocument $RelativePath)) {
        throw "Document outside the publication allowlist: $RelativePath"
    }
}

function Get-StreamSha256([IO.Stream]$Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    try { return Get-StreamSha256 $stream }
    finally { $stream.Dispose() }
}

$records = [Collections.Generic.List[object]]::new()
$selected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Add-SourceFile([IO.FileInfo]$File, [bool]$TopLevel = $false) {
    if ($File.LinkType) { throw 'Linked files are not permitted in the delivery.' }
    $relative = Get-RelativeSourcePath $File.FullName
    if (Test-SensitiveName $relative) { return }
    $isPublishedDocument = Test-PublishedDocument $relative
    if ($relative.StartsWith('docs/', [StringComparison]::OrdinalIgnoreCase) -and -not $isPublishedDocument) { return }
    if (-not $TopLevel -and -not $isPublishedDocument -and $File.Extension -notin $allowedExtensions -and $File.Name -notlike '*Dockerfile') { return }
    Assert-SourcePath $relative
    if (-not $selected.Add($relative)) { throw "Duplicate source path: $relative" }
    if ($File.Length -gt 2MB) { throw "Unexpectedly large source file: $relative" }
    $bytes = [IO.File]::ReadAllBytes($File.FullName)
    $content = $utf8.GetString($bytes)
    if ($content.Contains([char]0)) { throw "Binary/runtime data is not permitted: $relative" }
    foreach ($pattern in $knownSecretPatterns) {
        if ([regex]::IsMatch($content, $pattern)) { throw "Possible credential/private key in source: $relative" }
    }
    $records.Add([pscustomobject]@{ Path = $relative; Bytes = $bytes; Sha256 = (Get-BytesSha256 $bytes) })
}

foreach ($name in $sourceFiles) {
    $candidate = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Add-SourceFile (Get-Item -LiteralPath $candidate -Force) $true }
}
foreach ($directory in $sourceDirectories) {
    $candidate = Join-Path $projectRoot $directory
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($candidate)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $currentItem = Get-Item -LiteralPath $current -Force
        Assert-ProjectPath $currentItem.FullName
        if ($currentItem.LinkType) { throw 'Linked directories are not permitted in the delivery.' }
        foreach ($item in (Get-ChildItem -LiteralPath $current -Force)) {
            if ($item.PSIsContainer) {
                if (-not $blockedDirectories.Contains($item.Name)) { $pending.Push($item.FullName) }
            } else { Add-SourceFile $item }
        }
    }
}
foreach ($required in $requiredFiles) {
    if (-not $selected.Contains($required)) { throw "Required delivery file missing: $required" }
}
$ordered = @($records | Sort-Object -Property Path)

$zipPath = if ([IO.Path]::IsPathRooted($OutputPath)) { [IO.Path]::GetFullPath($OutputPath) }
    else { [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath)) }
Assert-ProjectPath $zipPath
$outputRelative = Get-RelativeSourcePath $zipPath
if ($outputRelative -notmatch '^(output|\.artifacts)/[^/]+\.zip$') {
    throw 'OutputPath must be a ZIP directly inside output/ or .artifacts/.'
}
$checksumPath = "$zipPath.sha256"
$manifestPath = "$zipPath.manifest.json"
foreach ($destination in @($zipPath, $checksumPath, $manifestPath)) {
    if ((Test-Path -LiteralPath $destination) -and -not $Force) { throw 'Delivery already exists; use -Force to replace it.' }
}
$outputDirectory = Split-Path -Parent $zipPath
if (-not (Test-Path -LiteralPath $outputDirectory)) { [void](New-Item -ItemType Directory -Path $outputDirectory) }
if ((Get-Item -LiteralPath $outputDirectory -Force).LinkType) { throw 'Output directory may not be a link.' }

$nonce = [Guid]::NewGuid().ToString('N')
$stagedZip = "$zipPath.partial-$nonce"
$stagedChecksum = "$checksumPath.partial-$nonce"
$stagedManifest = "$manifestPath.partial-$nonce"
$sumLines = @($ordered | ForEach-Object { "$($_.Sha256)  $archiveRoot/$($_.Path)" })
$sumContent = [string]::Join("`n", $sumLines) + "`n"
$sumBytes = $utf8.GetBytes($sumContent)
$sumEntryPath = "$archiveRoot/SHA256SUMS"

try {
    $stream = [IO.File]::Open($stagedZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($record in $ordered) {
            $entry = $archive.CreateEntry("$archiveRoot/$($record.Path)", [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $target = $entry.Open()
            try { $target.Write($record.Bytes, 0, $record.Bytes.Length) } finally { $target.Dispose() }
        }
        $sumEntry = $archive.CreateEntry($sumEntryPath, [IO.Compression.CompressionLevel]::Optimal)
        $sumEntry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $target = $sumEntry.Open()
        try { $target.Write($sumBytes, 0, $sumBytes.Length) } finally { $target.Dispose() }
    } finally { $archive.Dispose(); $stream.Dispose() }

    # Verify the actual compressed bytes, paths and the complete allowlist before publishing.
    $expected = @{}
    foreach ($record in $ordered) { $expected["$archiveRoot/$($record.Path)"] = $record.Sha256 }
    $expected[$sumEntryPath] = Get-BytesSha256 $sumBytes
    $stream = [IO.File]::OpenRead($stagedZip)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
        if ($archive.Entries.Count -ne $expected.Count) { throw 'ZIP entry count does not match its manifest.' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            if (-not $seen.Add($entry.FullName) -or -not $expected.ContainsKey($entry.FullName)) { throw 'Unexpected or duplicate ZIP entry.' }
            $relative = $entry.FullName.Substring($archiveRoot.Length + 1)
            Assert-SourcePath $relative
            $contentStream = $entry.Open()
            try { $actual = Get-StreamSha256 $contentStream } finally { $contentStream.Dispose() }
            if ($actual -ne $expected[$entry.FullName]) { throw "ZIP integrity check failed: $relative" }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }

    $stream = [IO.File]::OpenRead($stagedZip)
    try { $zipSha256 = Get-StreamSha256 $stream } finally { $stream.Dispose() }
    $zipName = [IO.Path]::GetFileName($zipPath)
    [IO.File]::WriteAllText($stagedChecksum, "$zipSha256  $zipName`n", $utf8)
    $manifest = [ordered]@{
        formatVersion = 1
        package = $zipName
        archiveRoot = $archiveRoot
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        sha256 = $zipSha256
        sourceFileCount = $ordered.Count
        zipEntryCount = $ordered.Count + 1
        verification = 'Every ZIP entry was checked against SHA-256 and the source-only allowlist.'
        files = @($ordered | ForEach-Object { [ordered]@{ path = $_.Path; sha256 = $_.Sha256; bytes = $_.Bytes.Length } })
    }
    [IO.File]::WriteAllText($stagedManifest, ($manifest | ConvertTo-Json -Depth 6), $utf8)
    Move-Item -LiteralPath $stagedZip -Destination $zipPath -Force:$Force
    Move-Item -LiteralPath $stagedChecksum -Destination $checksumPath -Force:$Force
    Move-Item -LiteralPath $stagedManifest -Destination $manifestPath -Force:$Force
    [pscustomobject]@{ Zip = $zipPath; SourceFiles = $ordered.Count; Sha256 = $zipSha256; Checksum = $checksumPath; Manifest = $manifestPath }
} finally {
    # Only these three known files inside the checked output directory can be removed.
    foreach ($partial in @($stagedZip, $stagedChecksum, $stagedManifest)) {
        Assert-ProjectPath $partial
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
    }
}
