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
const performScan = async (deviceId: string): Promise<{ path: string; success: boolean; base64?: string }> => {
  // Handle demo scanner
  if (deviceId === 'demo-scanner') {
    try {
      const demoPath = await createDemoScan();
      return { path: demoPath, success: true };
    } catch (error) {
      logger.error('Error creating demo scan:', error);
      throw new Error('Failed to create demo scan');
    }
  }

  const outputPath = path.join(os.tmpdir(), `scan-${Date.now()}.jpg`);
  logger.info('Starting scan to:', outputPath);

  return new Promise((resolve, reject) => {
    const command = constructScanCommand(deviceId, outputPath);
    logger.info('Executing scan command:', command);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error('Scan error:', error);
        logger.error('Scan stderr:', stderr);
        reject(error);
        return;
      }
      if (stderr) {
        logger.info('Scan stderr (info):', stderr);
      }
      if (stdout) {
        logger.info('Scan stdout:', stdout);
      }
      logger.info('Scan completed successfully');

      // Read the file as base64
      fs.readFile(outputPath, { encoding: 'base64' }, (err, data) => {
        if (err) {
          logger.error('Error reading file as base64:', err);
          reject(err);
          return;
        }
        resolve({ path: outputPath, success: true, base64: data });
      });
    });
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

// Handle WebSocket messages
const handleWebSocketConnection = (ws: WebSocket) => {
  logger.info('Client connected');

  const sendError = (error: string) => {
    ws.send(JSON.stringify({
      type: 'error',
      error
    }));
  };

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message);
      logger.info('Received message:', data);

      switch (data.type) {
        case 'get-scanners':
          try {
            const scanners = await listScanners();
            logger.info('Raw scanner list:', scanners);

            const deviceList = scanners.length > 0 ? scanners : [{
              id: 'demo-scanner',
              name: 'Demo Scanner',
              model: 'Demo Model (No physical scanner found)',
              rawInfo: 'Demo scanner for testing when no physical scanner is available'
            }];

            logger.info('Processed scanner list:', 
              deviceList.map(s => ({ id: s.id, name: s.name }))
            );

            ws.send(JSON.stringify({
              type: 'scanners-list',
              data: deviceList
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

            logger.info('Starting scan with device:', data.deviceId);
            const scanResult = await performScan(data.deviceId);
            logger.info('Scan completed:', scanResult);

            // Verify the scanned file exists
            try {
              await fs.promises.access(scanResult.path);
              logger.info('Scanned file verified:', scanResult.path);
              ws.send(JSON.stringify({
                type: 'scan-complete',
                data: {
                  success: scanResult.success,
                  path: scanResult.path,
                  base64: scanResult.base64
                }
              }));
            } catch (fileError) {
              logger.error('Scanned file not found:', fileError);
              throw new Error('Failed to save scanned image');
            }
          } catch (error) {
            logger.error('Scan failed:', error);
            sendError(error instanceof Error ? error.message : 'Scan failed');
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
