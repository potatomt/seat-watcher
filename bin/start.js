#!/usr/bin/env node
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PORT = process.env.PORT || 5173;

function ensureDeps() {
  if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
    console.log('Installing dependencies (first run)...');
    execSync('npm install', { cwd: root, stdio: 'inherit' });
  }
}

function ensureBrowser() {
  try {
    const { chromium } = require(path.join(root, 'node_modules', 'playwright'));
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) return; // already installed
  } catch (e) {
    // fall through to install
  }
  console.log('Installing Playwright Chromium (first run)...');
  execSync('npx playwright install chromium', { cwd: root, stdio: 'inherit' });
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (e) {
    console.warn('Could not auto-open browser, open manually:', url);
  }
}

ensureDeps();
ensureBrowser();

const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

setTimeout(() => openBrowser(`http://localhost:${PORT}`), 1500);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
