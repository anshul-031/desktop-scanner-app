import { exec } from 'child_process';

export interface ScannerDevice {
  id: string;         // The raw device identifier (e.g., pixma:04A91794_261A03)
  name: string;       // User-friendly name
  model: string;      // Model information
  rawInfo: string;    // Full device information line
}

const parseSANEDeviceLine = (line: string): ScannerDevice | null => {
  // Try to parse SANE device line in format:
  // device `pixma:04A91794_261A03' is a CANON Canon PIXMA G3000 multi-function peripheral
  const match = line.match(/device `([^']+)' is a (.+)/);
  if (!match) {
    console.error('Could not parse device line:', line);
    return null;
  }

  const [_, deviceId, description] = match;
  const modelParts = description.split(' ');
  const manufacturer = modelParts[0];
  const model = modelParts.slice(1).join(' ');

  return {
    id: deviceId,
    name: `${manufacturer} ${model}`,
    model: model,
    rawInfo: line
  };
};

export const listScanners = (): Promise<ScannerDevice[]> => {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Windows scanner detection
      const command = `powershell "Get-WmiObject Win32_PnPEntity | Where-Object{$_.Caption -match 'scanner'} | Select-Object Caption,DeviceID,Manufacturer,Description | ConvertTo-Json"`;
      exec(command, (error, stdout) => {
        if (error) {
          console.error('Error listing Windows scanners:', error);
          resolve([]);
          return;
        }
        try {
          const devices = JSON.parse(stdout.trim() || '[]');
          const scanners = Array.isArray(devices) ? devices : [devices];
          resolve(scanners.map((device: any) => ({
            id: device.DeviceID,
            name: device.Caption,
            model: device.Description || device.Caption,
            rawInfo: JSON.stringify(device)
          })));
        } catch (e) {
          console.error('Error parsing Windows scanner list:', e);
          resolve([]);
        }
      });
    } else {
      // First check SANE version
      exec('scanimage -V', (versionError, versionStdout) => {
        if (versionError) {
          console.error('SANE not available:', versionError);
          resolve([]);
          return;
        }
        console.log('SANE version:', versionStdout.trim());

        // Get list of available devices
        exec('scanimage -L', (error, stdout) => {
          if (error) {
            console.error('Error listing SANE scanners:', error);
            resolve([]);
            return;
          }
          try {
            const output = stdout.trim();
            if (!output || output.includes('No scanners were identified')) {
              console.log('No SANE scanners found');
              resolve([]);
              return;
            }

            const devices = output
              .split('\n')
              .filter(line => line.trim().length > 0)
              .map(parseSANEDeviceLine)
              .filter((device): device is ScannerDevice => device !== null);

            console.log('Found SANE devices:', devices);
            resolve(devices);
          } catch (e) {
            console.error('Error parsing SANE output:', e);
            resolve([]);
          }
        });
      });
    }
  });
};

const escapeShellArg = (arg: string): string => {
  // Escape special characters for shell
  return `'${arg.replace(/'/g, "'\\''")}'`;
};

export const constructScanCommand = (deviceId: string, outputPath: string): string => {
  if (process.platform === 'win32') {
    return `powershell "
      try {
        $deviceManager = New-Object -ComObject WIA.DeviceManager;
        $device = $deviceManager.DeviceInfos | Where-Object { $_.DeviceID -eq '${deviceId}' } | ForEach-Object { $_.Connect() };
        $scanner = $device.Items[1];
        $image = $scanner.Transfer();
        $image.SaveFile('${outputPath}');
        exit 0;
      } catch {
        Write-Error $_.Exception.Message;
        exit 1;
      }
    "`;
  } else {
    // For SANE:
    // 1. Escape device ID and output path
    // 2. Add --progress for status updates
    // 3. Use specific mode and resolution for better compatibility
    const escapedDeviceId = escapeShellArg(deviceId);
    const escapedOutputPath = escapeShellArg(outputPath);
    
    return [
      'scanimage',
      `-d ${escapedDeviceId}`,
      '--format=jpeg',
      '--mode Color',
      '--resolution 300',
      '--progress',
      `--output-file=${escapedOutputPath}`
    ].join(' ');
  }
};