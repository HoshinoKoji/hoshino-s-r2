import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { generate, root } from './config.mjs';

function run(binary, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolveResult() : reject(new Error(`${binary} exited: ${code ?? signal}`)));
  });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['dev', 'deploy', 'config'].includes(command)) throw new Error('Use dev, deploy or config');
  let override;
  const index = args.indexOf('--override');
  if (index >= 0) {
    override = args[index + 1];
    if (!override || override.startsWith('--')) throw new Error('--override needs a TOML path');
    args.splice(index, 2);
  }
  const localIndex = args.indexOf('--local');
  const local = command === 'dev' || (command === 'config' && localIndex >= 0);
  if (localIndex >= 0) args.splice(localIndex, 1);
  if (args.some(arg => /^--(?:remote|env|config)(?:=|$)/.test(arg) || /^-[ec]/.test(arg))) {
    throw new Error('Use --override for configuration; dev is local-only');
  }
  const config = await generate(override, local);
  console.log(`Generated TOML for ${config.name}: ${config.r2_buckets.length} buckets (${local ? 'local-only authentication' : 'Access JWT authentication'})`);
  if (command !== 'config') {
    const ext = process.platform === 'win32' ? '.cmd' : '';
    await run(resolve(root, `node_modules/.bin/vite${ext}`), ['build']);
    await run(resolve(root, `node_modules/.bin/wrangler${ext}`), [command, '--config', 'wrangler.generated.toml', ...args]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
