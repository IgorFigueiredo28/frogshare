// Publishes dist/FrogShare Setup <version>.exe as GitHub release v<version>, plus a copy named
// FrogShare-Setup.exe (the site's "latest" download link). Downloads both back to confirm they are
// byte-identical, then points LATEST_APP in server/index.js at the release asset (version, url, size,
// sha512) so the in-app updater offers it once the server is deployed.
// Usage: node scripts/publish-release.js <version> "<release notes>"   (needs the gh CLI, logged in)
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'IgorFigueiredo28/frogshare';
const root = path.join(__dirname, '..');
const [version, notes] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !notes) {
  console.error('Usage: node scripts/publish-release.js <version> "<release notes>"');
  process.exit(1);
}
const setup = path.join(root, 'dist', `FrogShare Setup ${version}.exe`);
if (!fs.existsSync(setup)) throw new Error('Build first: missing ' + setup);
const fixed = path.join(os.tmpdir(), 'fs-rel', 'FrogShare-Setup.exe');
fs.mkdirSync(path.dirname(fixed), { recursive: true });
fs.copyFileSync(setup, fixed);

const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' }).trim();
console.log(gh('release', 'create', `v${version}`, setup, fixed, '--repo', REPO, '--title', `FrogShare ${version}`, '--notes', notes));

const local = fs.readFileSync(setup);
const sha512 = crypto.createHash('sha512').update(local).digest('base64');
const assetUrl = `https://github.com/${REPO}/releases/download/v${version}/FrogShare.Setup.${version}.exe`;
const latestUrl = `https://github.com/${REPO}/releases/latest/download/FrogShare-Setup.exe`;

(async () => {
  for (const url of [assetUrl, latestUrl]) {
    const res = await fetch(url, { redirect: 'follow' });
    const got = Buffer.from(await res.arrayBuffer());
    const same = res.ok && got.length === local.length && crypto.createHash('sha512').update(got).digest('base64') === sha512;
    console.log(`${same ? 'IDENTICO' : 'DIFERENTE'} ${got.length} ${url}`);
    if (!same) process.exit(1);
  }
  const serverFile = path.join(root, 'server', 'index.js');
  let s = fs.readFileSync(serverFile, 'utf8');
  const before = s;
  s = s.replace(/(const LATEST_APP = \{\s*\n\s*version: )'[^']*'/, `$1'${version}'`)
    .replace(/(\n\s*url: )'https:\/\/github\.com\/[^']*'/, `$1'${assetUrl}'`)
    .replace(/(\n\s*size: )\d+/, `$1${local.length}`)
    .replace(/(\n\s*sha512: )'[^']*'/, `$1'${sha512}'`);
  if (s === before) throw new Error('LATEST_APP not updated');
  fs.writeFileSync(serverFile, s);
  console.log(`LATEST_APP -> ${version} ${local.length}`);
})().catch(err => { console.error(err.message); process.exit(1); });
