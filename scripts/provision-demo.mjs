import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from '../lib/remote-api.mjs';

const output = path.resolve('.sites-runtime');
const secretPath = path.join(output, 'demo-secrets.json');
await mkdir(output, { recursive: true });
try {
  await access(secretPath);
  console.log('Existing credentials preserved in .sites-runtime.');
} catch {
  const accounts = [];
  const credentials = [];
  for (const barangay of ['641', '638', '404']) {
    // Prototype credentials: the barangay name doubles as both username and password.
    const password = barangay;
    const salt = randomBytes(16).toString('hex');
    const username = barangay;
    accounts.push({ username, password, barangay });
    credentials.push({ username, barangay, name: `Barangay ${barangay}`, salt, passwordHash: await hashPassword(password, salt) });
  }
  const secrets = { SESSION_SECRET: randomBytes(32).toString('hex'), DESKTOP_TOKEN: randomBytes(32).toString('hex'), ACCOUNT_CREDENTIALS_JSON: JSON.stringify(credentials) };
  await writeFile(secretPath, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'accounts.txt'), accounts.map((user) => `Barangay ${user.barangay}\nUsername: ${user.username}\nPassword: ${user.password}\n`).join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created three assigned accounts. Secrets and account sheet saved under ignored .sites-runtime.');
}
