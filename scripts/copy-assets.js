const fs = require('fs');
const path = require('path');

// Create dist directory if it doesn't exist
const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Files to copy from src to dist
const filesToCopy = [
    'index.html',
    'demo-scan.jpg',
    'scan-detect.ps1',
    'scan.ps1'
];

// Copy each file
filesToCopy.forEach(file => {
    const srcPath = path.join(__dirname, '../src', file);
    const destPath = path.join(distDir, file);
    
    try {
        fs.copyFileSync(srcPath, destPath);
        console.log(`✓ Copied ${file} to dist/`);
    } catch (err) {
        console.error(`✗ Error copying ${file}:`, err.message);
        process.exit(1);
    }
});

console.log('✓ All assets copied successfully');
