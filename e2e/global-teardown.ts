import path from 'path';
import fs from 'fs';

const HANDLER_DIRS = [
  'platform-admin-handler',
  'platform-user-handler',
  'platform-authorizer',
  'sos-handler',
  'trusted-contacts-handler',
];

async function globalTeardown() {
  const proc = (globalThis as any).__E2E_SERVER_PROCESS;
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
      setTimeout(resolve, 5000);
    });
  }

  const lambdaDir = path.resolve(__dirname, '..', 'lambda');
  for (const dir of HANDLER_DIRS) {
    const awsSdkDir = path.join(lambdaDir, dir, 'node_modules', '@aws-sdk');
    const hiddenDir = awsSdkDir + '.__e2e_hidden';
    if (fs.existsSync(hiddenDir) && !fs.existsSync(awsSdkDir)) {
      fs.renameSync(hiddenDir, awsSdkDir);
    }
  }
}

export default globalTeardown;
