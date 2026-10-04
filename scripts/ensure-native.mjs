// Vite 8 needs a native binary per platform (rolldown, lightningcss). npm sometimes skips these
// optional packages (npm/cli#4828, or an `omit=optional` setting), and Vite then fails to start.
// This runs before `npm run dev` / `npm run build` and installs the right one if it is missing.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read package.json files directly: some packages (lightningcss) don't export them to require().
const modules = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const readPkg = (name) => JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
const installed = (name) => existsSync(join(modules, name, 'package.json'));
const { platform, arch } = process;
const musl = platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime;

/** Pick this platform's binding from a package's optionalDependencies. */
function bindingFor(pkgName) {
  if (!installed(pkgName)) return null; // not installed at all; plain `npm install` handles it
  const pkg = readPkg(pkgName);
  const names = Object.keys(pkg.optionalDependencies ?? {}).filter((n) => n.includes(`${platform}-${arch}`));
  const name =
    names.find((n) => (platform === 'win32' ? n.endsWith('msvc') : platform === 'linux' ? n.endsWith(musl ? 'musl' : 'gnu') : true)) ??
    names[0];
  return name ? { name, version: pkg.optionalDependencies[name] } : null;
}

const missing = [];
for (const pkgName of ['rolldown', 'lightningcss']) {
  const b = bindingFor(pkgName);
  if (!b) continue;
  if (!installed(b.name)) missing.push(`${b.name}@${b.version}`);
}

if (missing.length) {
  console.log(`[ensure-native] installing missing native packages: ${missing.join(' ')}`);
  const res = spawnSync('npm', ['install', '--no-save', '--include=optional', ...missing], { stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error('[ensure-native] install failed. Try: npm install --no-save ' + missing.join(' '));
    process.exit(res.status ?? 1);
  }
}
