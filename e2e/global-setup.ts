import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { FullConfig } from '@playwright/test';

const HANDLER_DIRS = [
  'platform-admin-handler',
  'platform-user-handler',
  'platform-authorizer',
  'sos-handler',
  'trusted-contacts-handler',
];

async function globalSetup(config: FullConfig) {
  const rootDir = path.resolve(__dirname, '..');
  const lambdaDir = path.join(rootDir, 'lambda');
  const entryFile = path.join(lambdaDir, 'e2e-server.ts');
  const tsxBin = path.join(rootDir, 'node_modules', '.bin', 'tsx');

  for (const dir of HANDLER_DIRS) {
    const awsSdkDir = path.join(lambdaDir, dir, 'node_modules', '@aws-sdk');
    const hiddenDir = awsSdkDir + '.__e2e_hidden';
    if (fs.existsSync(awsSdkDir) && !fs.existsSync(hiddenDir)) {
      fs.renameSync(awsSdkDir, hiddenDir);
    }
  }

  return new Promise<void>((resolve, reject) => {
    const serverProcess = spawn(tsxBin, [entryFile], {
      cwd: lambdaDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let stderrOutput = '';

    serverProcess.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      const match = output.match(/SERVER_READY:(\d+)/);
      if (match) {
        process.env.E2E_BASE_URL = `http://127.0.0.1:${match[1]}`;
        (globalThis as any).__E2E_SERVER_PROCESS = serverProcess;
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      stderrOutput += msg;
      if (!msg.includes('ExperimentalWarning') && !msg.includes('DeprecationWarning')) {
        process.stderr.write(`[e2e-server] ${msg}`);
      }
    });

    serverProcess.on('error', (err) => { restoreHandlerDirs(lambdaDir); reject(err); });
    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        restoreHandlerDirs(lambdaDir);
        reject(new Error(`Server exited with code ${code}.\nstdout: ${output}\nstderr: ${stderrOutput}`));
      }
    });

    setTimeout(() => {
      restoreHandlerDirs(lambdaDir);
      reject(new Error(`Server failed to start within 30s.\nstdout: ${output}\nstderr: ${stderrOutput}`));
    }, 30000);
  });
}

function restoreHandlerDirs(lambdaDir: string) {
  for (const dir of HANDLER_DIRS) {
    const awsSdkDir = path.join(lambdaDir, dir, 'node_modules', '@aws-sdk');
    const hiddenDir = awsSdkDir + '.__e2e_hidden';
    if (fs.existsSync(hiddenDir) && !fs.existsSync(awsSdkDir)) {
      fs.renameSync(hiddenDir, awsSdkDir);
    }
  }
}

export default globalSetup;
