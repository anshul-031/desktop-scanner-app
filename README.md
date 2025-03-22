# Aadhaar Scanner Service

This is a desktop application that provides scanner functionality to the Aadhaar QR Code web application.

## Prerequisites

- Node.js 18 or later
- A TWAIN-compatible scanner (Windows) or SANE-compatible scanner (Linux/macOS)
- For Linux/macOS users: SANE backend installed (`sudo apt-get install sane` for Ubuntu/Debian)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Build the application:
```bash
npm run build
```

3. Start the application:
```bash
npm start
```

## Usage

1. Start the scanner service before using the scanning feature in the web application.
2. The service runs on `ws://localhost:3500` and provides a WebSocket interface for scanner control.
3. A status window will appear showing the service status and connection information.
4. The web application will automatically connect to the scanner service when using the "Scan" tab.

## Features

- Automatic scanner detection
- Real-time scanner status
- Error reporting and logging
- Automatic reconnection handling
- Support for different scanner resolutions
- Local file system integration for scanned images

## Troubleshooting

1. No scanners found:
   - Make sure your scanner is connected and powered on
   - Check if scanner drivers are installed
   - For Linux/macOS: Verify SANE is installed and configured

2. Connection issues:
   - Ensure no other application is using port 3500
   - Check if the service is running (status window should be visible)
   - Try restarting both the scanner service and web application

3. Scanning errors:
   - Check scanner permissions
   - Verify scanner is not in use by another application
   - Try disconnecting and reconnecting the scanner

## Building for Distribution

To create a standalone executable:

```bash
npm run dist
```

This will create platform-specific installers in the `release` directory.

## Development

The scanner service uses:
- Electron for the desktop application
- WebSocket for communication
- Native OS scanner APIs (WIA on Windows, SANE on Linux/macOS)

To run in development mode:
```bash
npm run dev
```

## License

ISC