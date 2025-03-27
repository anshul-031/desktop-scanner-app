import { app, BrowserWindow } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ScannerDevice, listScanners, constructScanCommand } from './utils';

let mainWindow: BrowserWindow | null = null;
let wss: WebSocketServer;
const PORT = 3500;

// Logger with timestamps
const logger = {
  info: (...args: any[]) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO]`, ...args);
  },
  error: (...args: any[]) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR]`, ...args);
  }
};

// Create a demo scan image
const createDemoScan = async (): Promise<string> => {
  const outputPath = path.join(os.tmpdir(), `demo-scan-${Date.now()}.jpg`);
  logger.info('Creating demo scan:', outputPath);

  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      // On macOS, use sips to create an image
      const command = `sips -s format jpeg ${path.join(__dirname, '../src/demo-scan.jpg')} --out ${outputPath}`;
      exec(command, (error) => {
        if (error) {
          logger.error('Error creating demo scan:', error);
          reject(error);
          return;
        }
        resolve(outputPath);
      });
    } else {
      // For other platforms, copy the demo image
      fs.copyFile(path.join(__dirname, '../src/demo-scan.jpg'), outputPath, (error) => {
        if (error) {
          logger.error('Error copying demo scan:', error);
          reject(error);
          return;
        }
        resolve(outputPath);
      });
    }
  });
};

// Perform scan operation
const performScan = async (deviceId: string): Promise<{ success: boolean; base64: string }> => {
  // Handle demo scanner
  if (deviceId === 'demo-scanner') {
    try {
      const demoPath = await createDemoScan();
      const demoImage = await fs.promises.readFile(demoPath);
      const base64Data = demoImage.toString('base64');
      return {
        success: true,
        base64: `data:image/jpeg;base64,${base64Data}`
      };
    } catch (error) {
      logger.error('Error creating demo scan:', error);
      throw new Error('Failed to create demo scan');
    }
  }

  logger.info('Starting scan...');

  return new Promise((resolve, reject) => {
    // Since we're not using temp files anymore, we don't need outputPath
    const command = constructScanCommand(deviceId, 'unused');
    
    let isHandled = false;
    let scanOutput = '';

    const scanTimeout = setTimeout(() => {
      if (!isHandled) {
        isHandled = true;
        logger.error('Scan timeout after 120 seconds');
        reject(new Error('Scanner timeout - no response from device'));
      }
    }, 120000);

    logger.info('Executing scan command...');
    const scanProcess = exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      clearTimeout(scanTimeout);
      
      if (isHandled) return;
      isHandled = true;

      if (error) {
        const errorMessage = stderr.toString() || error.message;
        logger.error('Scan error:', errorMessage);

        if (errorMessage.includes('Result code: 0x80210015')) {
          reject(new Error('Scanner is in use by another application'));
        } else if (errorMessage.includes('Result code: 0x80210006')) {
          reject(new Error('No document in scanner'));
        } else if (errorMessage.includes('Access is denied')) {
          reject(new Error('Access denied - please run as administrator'));
        } else {
          reject(new Error(errorMessage));
        }
        return;
      }

      // Process output from scanner - get the base64 data
      const output = stdout.toString().trim();
      const base64Match = output.match(/(data:image\/jpeg;base64,[\w+/=]+)/);
      if (!base64Match) {
        reject(new Error('Invalid image data received from scanner'));
        return;
      }

      resolve({
        success: true,
        base64: base64Match[1]
      });
    });

    // Handle process output for logging
    if (scanProcess.stdout) {
      scanProcess.stdout.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message.startsWith('[SCAN]')) {
          logger.info(message);
        }
      });
    }
  });
};

// Create main window
const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.openDevTools();
};

// Custom WebSocket type with cache
interface ExtendedWebSocket extends WebSocket {
scannerCache?: string;
lastScannerRequest?: number;
}

// Handle WebSocket messages
const handleWebSocketConnection = (ws: ExtendedWebSocket) => {
logger.info('Client connected');

// Initialize scanner cache
ws.scannerCache = '';
ws.lastScannerRequest = 0;

const sendError = (error: string) => {
  ws.send(JSON.stringify({
    type: 'error',
    error
  }));
};

const SCANNER_REQUEST_THROTTLE = 2000; // 2 seconds

ws.on('message', async (message: string) => {
  try {
    const data = JSON.parse(message);

    // Only log non-scanner-list messages
    if (data.type !== 'get-scanners') {
      logger.info('Received message:', data);
    }

    switch (data.type) {
      case 'get-scanners':
        // Throttle scanner list requests
        const now = Date.now();
        if (now - (ws.lastScannerRequest || 0) < SCANNER_REQUEST_THROTTLE) {
          return;
        }
        ws.lastScannerRequest = now;
          try {
            const scanners = await listScanners();
            
            // Filter out invalid entries and duplicates
            const validScanners = scanners
              .filter(s => s && s.id && s.name && s.rawInfo && s.rawInfo !== '{}')
              .reduce((unique: ScannerDevice[], scanner) => {
                // Keep only WIA or first occurrence
                const existingIndex = unique.findIndex(s => s.name === scanner.name);
                if (existingIndex >= 0) {
                  // Replace only if new one is WIA and existing isn't
                  const existingIsWIA = unique[existingIndex].rawInfo.includes('"Source":"WIA"');
                  const newIsWIA = scanner.rawInfo.includes('"Source":"WIA"');
                  if (newIsWIA && !existingIsWIA) {
                    unique[existingIndex] = scanner;
                  }
                } else {
                  unique.push(scanner);
                }
                return unique;
              }, []);

            const deviceList = validScanners.length > 0 ? validScanners : [{
              id: 'demo-scanner',
              name: 'Demo Scanner',
              model: 'Demo Model (No physical scanner found)',
              rawInfo: 'Demo scanner for testing when no physical scanner is available'
            }];

            // Sort by WIA first, then by name
            const sortedDevices = deviceList.sort((a, b) => {
              const aIsWIA = a.rawInfo.includes('"Source":"WIA"');
              const bIsWIA = b.rawInfo.includes('"Source":"WIA"');
              if (aIsWIA !== bIsWIA) return aIsWIA ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

            // Cache scanner list to prevent duplicate logging
            const scannerKey = sortedDevices.map(s => {
              const source = s.rawInfo.includes('"Source":"WIA"') ? 'WIA' : 'OTHER';
              return `${s.id}:${source}`;
            }).join(',');
            if (ws.scannerCache !== scannerKey) {
              ws.scannerCache = scannerKey;
              logger.info('Available scanners:\n' +
                sortedDevices.map(s => `${s.name} (${s.id})`).join('\n')
              );
            }

            ws.send(JSON.stringify({
              type: 'scanners-list',
              data: sortedDevices
            }));
          } catch (error) {
            logger.error('Error listing scanners:', error);
            sendError('Failed to get scanner list');
          }
          break;

        case 'start-scan':
          try {
            if (!data.deviceId) {
              throw new Error('No device ID provided');
            }

            // Get latest scanner list
            const scanners = await listScanners();
            let scanDeviceId = data.deviceId;

            // If we get a non-WIA device ID, try to find corresponding WIA device
            if (!data.deviceId.includes('6BDD1FC6-810F-11D0-BEC7-08002BE2092F')) {
              const wiaDevice = scanners.find((d: ScannerDevice) =>
                d.rawInfo.includes('"Source":"WIA"') &&
                d.rawInfo.includes('"Status":"Connected"')
              );
              if (wiaDevice) {
                logger.info('Using WIA device instead of:', data.deviceId);
                scanDeviceId = wiaDevice.id;
              }
            }

            logger.info('Starting scan with device:', scanDeviceId);
            
            try {
              const scanResult = await performScan(scanDeviceId);
              
              if (!scanResult || !scanResult.base64) {
                throw new Error('Scanner did not return any data');
              }

              ws.send(JSON.stringify({
                type: 'scan-complete',
                data: {
                  success: true,
                  base64: scanResult.base64
                }
              }));
              
            } catch (error) {
              logger.error('Scan error:', error);
              
              // Parse PowerShell error messages
              const errorStr = error instanceof Error ? error.message : String(error);
              if (errorStr.includes('Access is denied')) {
                sendError('Access denied. Please run the application as administrator.');
              } else if (errorStr.includes('Device not found') || errorStr.includes('No compatible WIA scanner')) {
                sendError('Scanner not found or not compatible. Please check if it is properly connected.');
              } else if (errorStr.includes('Device is busy') || errorStr.includes('being used by another application')) {
                sendError('Scanner is busy or in use by another application. Please wait and try again.');
              } else if (errorStr.includes('empty file')) {
                sendError('Scanner failed to produce a valid image. Please check if there is a document in the scanner.');
              } else {
                sendError(`Scanning failed: ${errorStr}`);
              }
            }
          } catch (error) {
            logger.error('Scan failed:', error);
            const errorMessage = error instanceof Error ? error.message : 'Scan failed';
            
            // Provide more helpful error messages
            if (errorMessage.toLowerCase().includes('access') || errorMessage.toLowerCase().includes('permission')) {
              sendError('Scanner access denied. Please ensure you have administrator privileges or proper permissions.');
            } else if (errorMessage.toLowerCase().includes('busy')) {
              sendError('Scanner is busy or in use by another application.');
            } else if (errorMessage.toLowerCase().includes('not found') || errorMessage.toLowerCase().includes('no scanner')) {
              sendError('Scanner not found. Please check if it is properly connected and powered on.');
            } else {
              sendError(`Scanning failed: ${errorMessage}. Please check scanner connection and try again.`);
            }
          }
          break;

        default:
          logger.error('Unknown message type:', data.type);
          sendError('Unknown message type');
      }
    } catch (error) {
      logger.error('Error processing message:', error);
      sendError('Invalid message format');
    }
  });

  ws.on('close', () => {
    logger.info('Client disconnected');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
};

// Initialize WebSocket server
const initWebSocket = () => {
  wss = new WebSocketServer({ port: PORT });
  logger.info(`WebSocket server running on ws://localhost:${PORT}`);

  wss.on('connection', handleWebSocketConnection);
  wss.on('error', (error) => {
    logger.error('WebSocket server error:', error);
  });
};

app.whenReady().then(() => {
  createWindow();
  initWebSocket();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  if (wss) {
    wss.close();
  }
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
});
