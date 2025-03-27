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
      // Windows scanner detection using the comprehensive PowerShell script
      const scriptPath = require('path').join(__dirname, 'scan-detect.ps1');
      const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
      
      exec(command, (error, stdout) => {
        if (error) {
          console.error('Error listing Windows scanners:', error);
          resolve([]);
          return;
        }
        try {
          const devices = JSON.parse(stdout.substring(stdout.lastIndexOf('['))|| '[]');
          resolve(devices.map((device: any) => ({
            id: device.DeviceID,
            name: device.Name,
            model: device.Description || device.Type,
            rawInfo: JSON.stringify({
              ...device,
              source: device.Source,
              status: device.Status
            })
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

export const constructScanCommand = (deviceId: string, outputPath?: string): string => {
  if (process.platform === 'win32') {
    // Handle different scanner ID formats and clean up any double backslashes
    const sanitizedDeviceId = deviceId.replace(/\\\\/g, '\\');
    const scriptPath = require('path').join(__dirname, 'scan.ps1');

    // For Windows, outputPath is ignored as the PowerShell script handles temp files
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -deviceId "${sanitizedDeviceId}" -outputPath "unused"`;
  } else {
    // For SANE systems, outputPath is required
    if (!outputPath) {
      throw new Error('outputPath is required for non-Windows systems');
    }

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