# Minimize default output
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = "Stop"
$results = @()

function Test-WIAService {
    $wiaService = Get-Service "stisvc" -ErrorAction SilentlyContinue
    if (!$wiaService) {
        throw "Windows Image Acquisition (WIA) service not found"
    }
    if ($wiaService.Status -ne "Running") {
        try {
            Start-Service "stisvc" -ErrorAction Stop
            # Wait for service to be fully running
            $wiaService.WaitForStatus('Running', '00:00:10')
        } catch {
            throw "Failed to start WIA service: $($_.Exception.Message)"
        }
    }
    return $true
}

function Get-ScannerDevices {
    param (
        [System.Object]$deviceManager
    )
    
    $scanners = @()
    
    foreach ($device in $deviceManager.DeviceInfos) {
        if ($device.Type -eq 1) { # Scanner type
            try {
                # Test basic connectivity
                $deviceName = $device.Properties('Name').Value
                $connectedDevice = $device.Connect()
                
                if ($connectedDevice.Items.Count -gt 0) {
                    $scanners += @{
                        Source = "WIA"
                        DeviceID = $device.DeviceID
                        Name = $deviceName
                        Description = $device.Properties('Description').Value
                        Type = "Scanner"
                        Status = "Connected"
                    }
                } else {
                    $scanners += @{
                        Source = "WIA"
                        DeviceID = $device.DeviceID
                        Name = $deviceName
                        Description = $device.Properties('Description').Value
                        Type = "Scanner"
                        Status = "No Items"
                    }
                }
            } catch {
                # Only add device if we can get basic properties
                if ($device.DeviceID -and $deviceName) {
                    $scanners += @{
                        Source = "WIA"
                        DeviceID = $device.DeviceID
                        Name = $deviceName
                        Description = "Unknown"
                        Type = "Scanner"
                        Status = "Error: $($_.Exception.Message)"
                    }
                }
            } finally {
                if ($connectedDevice) {
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($connectedDevice)
                }
            }
        }
    }
    
    return $scanners
}

try {
    # Check WIA service first
    Test-WIAService | Out-Null
    
    # Initialize WIA
    $deviceManager = New-Object -ComObject WIA.DeviceManager
    $results += Get-ScannerDevices -deviceManager $deviceManager
    
    # Add PnP devices as backup
    Get-PnpDevice -Class "Image" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Status -eq "OK") {
            $results += @{
                Source = "PnP"
                DeviceID = $_.InstanceId
                Name = $_.FriendlyName
                Description = "Image"
                Type = "Image Device"
                Status = $_.Status
            }
        }
    }
} catch {
    # Write error but continue to return results
    $Host.UI.WriteErrorLine($_)
} finally {
    if ($deviceManager) {
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($deviceManager)
    }
}

# Always output results as last line for parsing
$results | ConvertTo-Json