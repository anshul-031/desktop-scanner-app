#!/usr/bin/env node
import { exec } from 'child_process';
import { platform } from 'os';

const checkDependencies = async () => {
  console.log('Checking system dependencies...');

  if (platform() === 'win32') {
    // Check Windows WMI access
    try {
      await new Promise<void>((resolve, reject) => {
        exec('powershell "Get-WmiObject -List"', (error) => {
          if (error) {
            console.error('Error: Windows Management Instrumentation (WMI) is not accessible.');
            console.error('Please ensure you have administrative privileges.');
            reject(error);
          } else {
            console.log('✓ Windows WMI is accessible');
            resolve();
          }
        });
      });
    } catch (error) {
      process.exit(1);
    }
  } else {
    // Check for SANE on Unix-like systems
    try {
      await new Promise<void>((resolve, reject) => {
        exec('which scanimage', async (error) => {
          if (error) {
            console.error('Error: SANE (scanimage) is not installed.');
            console.error('Please install SANE using your package manager:');
            console.error('- Ubuntu/Debian: sudo apt-get install sane');
            console.error('- macOS: brew install sane-backends');
            
            if (platform() === 'darwin') {
              // Check if Homebrew is installed on macOS
              exec('which brew', (brewError) => {
                if (brewError) {
                  console.error('\nHomebrew is not installed. To install Homebrew:');
                  console.error('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
                }
                reject(error);
              });
            } else {
              reject(error);
            }
          } else {
            console.log('✓ SANE is installed');
            resolve();
          }
        });
      });

      // Check SANE configuration
      await new Promise<void>((resolve, reject) => {
        exec('scanimage -L', (error, stdout) => {
          if (error) {
            console.error('Error: Unable to list scanners.');
            console.error('Please check your SANE configuration and ensure your scanner is connected.');
            reject(error);
          } else {
            if (stdout.trim()) {
              console.log('✓ Scanners detected:', stdout.trim());
            } else {
              console.log('! No scanners detected. Please check your scanner connection.');
            }
            resolve();
          }
        });
      });
    } catch (error) {
      process.exit(1);
    }
  }

  console.log('\nAll dependency checks completed.');
};

checkDependencies().catch(console.error);