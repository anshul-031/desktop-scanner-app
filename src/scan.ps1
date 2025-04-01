# Scanner configuration and execution script
param(
    [Parameter(Mandatory=$true)]
    [string]$deviceId,
    
    [Parameter(Mandatory=$false)]
    [int]$resolution = 300,
    
    [Parameter(Mandatory=$false)]
    [string]$area = "A4",
    
    [Parameter(Mandatory=$false)]
    [string]$colorMode = "Color"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Runtime.InteropServices

function Initialize-Scanner {
    Write-Host '[SCAN] Creating WIA device manager...'
    try {
        $deviceManager = New-Object -ComObject WIA.DeviceManager
        return $deviceManager
    } catch {
        throw "Failed to initialize WIA: $($_.Exception.Message)"
    }
}

function Get-ScannerDevice {
    param($deviceManager, $targetDeviceId)
    
    Write-Host '[SCAN] Finding device...'
    try {
        Write-Host "[SCAN] Looking for device ID: $targetDeviceId"
        foreach ($dev in $deviceManager.DeviceInfos) {
            try {
                $id = $dev.DeviceID
                Write-Host "[SCAN] Checking device: $id"
                if ($id -eq $targetDeviceId) {
                    Write-Host "[SCAN] Found exact match: $($dev.Properties('Name').Value)"
                    $device = $dev.Connect()
                    Start-Sleep -Seconds 1
                    
                    if (!$device) {
                        throw 'Device connection returned null'
                    }
                    Write-Host '[SCAN] Successfully connected to scanner'
                    return $device
                }
            } catch {
                continue
            }
        }
        throw 'No matching scanner device found'
    } catch {
        throw "Failed to connect to scanner: $($_.Exception.Message)"
    }
}

function Get-ScannerItem {
    param($device)
    
    Write-Host '[SCAN] Finding scanner item...'
    try {
        Write-Host "[SCAN] Trying to get scanner item"
        if ($device.Items.Count -gt 0) {
            $item = $device.Items.Item(1)
            Write-Host "[SCAN] Successfully got scanner item"
            return $item
        }
        throw 'No scanner item found'
    } catch {
        throw "Failed to get scanner item: $($_.Exception.Message)"
    }
}

function Set-ScannerProperties {
    param($scannerItem)
    
    Write-Host '[SCAN] Configuring scanner...'
    
    # Map color modes to WIA values
    $colorModeMap = @{
        'Color' = 1        # WIA_IPS_CUR_INTENT_COLOR
        'Grayscale' = 2    # WIA_IPS_CUR_INTENT_GRAYSCALE
        'BlackAndWhite' = 4 # WIA_IPS_CUR_INTENT_TEXT
    }

    # Map paper sizes (in inches)
    $pageSizeMap = @{
        'A4' = @{width = 8.27; height = 11.69}
        'A5' = @{width = 5.83; height = 8.27}
        'A6' = @{width = 4.13; height = 5.83}
        'Legal' = @{width = 8.5; height = 14}
        'Letter' = @{width = 8.5; height = 11}
    }

    # Get page dimensions
    $pageSize = $pageSizeMap[$area]
    if (-not $pageSize) {
        Write-Host "[SCAN] Warning: Unknown page size '$area', defaulting to A4"
        $pageSize = $pageSizeMap['A4']
    }

    # Convert inches to 1000ths of an inch (WIA's unit)
    $widthInThousandths = [int]($pageSize.width * 1000)
    $heightInThousandths = [int]($pageSize.height * 1000)

    # Build properties dictionary
    $properties = @{
        'Horizontal Resolution' = $resolution
        'Vertical Resolution' = $resolution
        'Horizontal Extent' = $widthInThousandths
        'Vertical Extent' = $heightInThousandths
        'Current Intent' = $colorModeMap[$colorMode]
    }

    Write-Host "[SCAN] Setting properties:"
    Write-Host "[SCAN] Resolution: $resolution DPI"
    Write-Host "[SCAN] Page Size: $area ($($pageSize.width)x$($pageSize.height) inches)"
    Write-Host "[SCAN] Color Mode: $colorMode"

    foreach ($prop in $properties.GetEnumerator()) {
        try {
            $scannerItem.Properties($prop.Key).Value = $prop.Value
            Write-Host "[SCAN] Set $($prop.Key) = $($prop.Value)"
        } catch {
            Write-Host "[SCAN] Could not set property $($prop.Key)"
        }
    }
}

function Start-Scanning {
    param($scannerItem)
    
    Write-Host '[SCAN] Starting scan...'
    try {
        Write-Host '[SCAN] Starting transfer...'
        Write-Host "[SCAN] Attempting scan using FormatTransfer method..."
        
        # Use explicit JPEG format for transfer
        $wiaFormatJPEG = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
        $image = $scannerItem.Transfer($wiaFormatJPEG)

        if (!$image) {
            throw "Scanner did not return an image"
        }

        Write-Host "[SCAN] Transfer successful"
        return $image
    } catch {
        $errorMsg = $_.Exception.Message
        switch -Regex ($errorMsg) {
            '0x80210015' { throw 'Scanner is in use by another application' }
            '0x80210006' { throw 'Scanner feed is empty. Please insert a document' }
            '0x80210064' { throw 'Scanner is busy. Please wait and try again' }
            '0x80210005' { throw 'Scanner communication error. Please check connection' }
            '0x8021006B' { throw 'Scanner is warming up. Please wait and try again' }
            '0x80210003' { throw 'Scanner is offline or unplugged' }
            '0x80210001' { throw 'Scanner is not ready. Please check if it is powered on' }
            Default { throw "Scan failed: $errorMsg" }
        }
    }
}

function Convert-WiaToBytes {
    param($image)
    
    Write-Host '[SCAN] Converting image...'
    $imageProcess = $null
    $convertedImage = $null
    $tempJpg = $null
    
    try {
        # Create WIA image process for conversion
        $imageProcess = New-Object -ComObject Wia.ImageProcess

        # Set up JPEG conversion
        $filter = $imageProcess.FilterInfos.Item("Convert").FilterID
        $imageProcess.Filters.Add($filter)
        $imageProcess.Filters.Item(1).Properties.Item("FormatID").Value = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
        $imageProcess.Filters.Item(1).Properties.Item("Quality").Value = 100

        # Apply conversion
        $convertedImage = $imageProcess.Apply($image)

        # Create a temporary JPEG file
        $tempJpg = Join-Path $env:TEMP "scan_$([Guid]::NewGuid()).jpg"
        Write-Host "[SCAN] Using temporary file: $tempJpg"

        # Save the image
        $convertedImage.SaveFile($tempJpg)
        
        if (-not (Test-Path $tempJpg)) {
            throw "Failed to save temporary JPEG file"
        }

        # Convert to base64 in a single operation
        $bytes = [System.IO.File]::ReadAllBytes($tempJpg)
        $base64 = [Convert]::ToBase64String($bytes)
        
        Write-Host "[SCAN] Successfully converted image"
        Write-Output "data:image/jpeg;base64,$base64"
        return $true
    }
    catch {
        throw "Failed to convert image: $($_.Exception.Message)"
    }
    finally {
        # Clean up resources
        if ($convertedImage) {
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($convertedImage) | Out-Null
        }
        if ($imageProcess) {
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($imageProcess) | Out-Null
        }
        
        # Clean up temporary file
        if ($tempJpg -and (Test-Path $tempJpg)) {
            Remove-Item $tempJpg -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    $deviceManager = Initialize-Scanner
    $device = Get-ScannerDevice -deviceManager $deviceManager -targetDeviceId $deviceId
    $scannerItem = Get-ScannerItem -device $device
    Set-ScannerProperties -scannerItem $scannerItem
    $image = Start-Scanning -scannerItem $scannerItem
    
    # Convert and output image data
    Convert-WiaToBytes -image $image
    exit 0
} catch {
    Write-Error "[SCAN] $($_.Exception.Message)"
    exit 1
} finally {
    # Clean up COM objects
    $comObjects = @()
    
    if ($image) { $comObjects += $image }
    if ($scannerItem) { $comObjects += $scannerItem }
    if ($device) { $comObjects += $device }
    if ($deviceManager) { $comObjects += $deviceManager }
    
    foreach ($obj in $comObjects) {
        if ($obj) {
            try {
                [System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) | Out-Null
            } catch {
                Write-Host "[SCAN] Warning: Failed to release COM object: $($_.Exception.Message)"
            }
        }
    }
    
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    Remove-Variable -Name comObjects -ErrorAction SilentlyContinue
    [System.GC]::Collect()
}