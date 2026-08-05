import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = path.join(root, 'dist');
export const artifactsDir = path.join(root, 'artifacts');
export const targets = ['chromium', 'firefox'];

export function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

export const buildConfig = readJson('config/build.json');
export const sharedManifest = readJson('config/manifest.shared.json');

export function assertInsideRoot(targetPath, { allowRoot = false } = {}) {
  const resolved = path.resolve(targetPath);
  if ((!allowRoot && resolved === root) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    throw new Error(`Refusing unsafe path outside project root: ${targetPath}`);
  }
  return resolved;
}

function assertSafeRelativeFile(label, value) {
  if (typeof value !== 'string' || !value || value.length > 160) {
    throw new Error(`${label} must be a non-empty relative file path`);
  }
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..') || value.endsWith('/')) {
    throw new Error(`${label} must stay inside the project: ${value}`);
  }
  return value;
}

function validateBuildConfig() {
  if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(buildConfig.name)) {
    throw new Error(`Invalid package/artifact name: ${buildConfig.name}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(buildConfig.version)) {
    throw new Error(`Invalid semantic version: ${buildConfig.version}`);
  }
  if (!Array.isArray(buildConfig.extensionFiles) || !buildConfig.extensionFiles.length) {
    throw new Error('config/build.json extensionFiles must be a non-empty array');
  }
  for (const file of buildConfig.extensionFiles) assertSafeRelativeFile('extensionFiles entry', file);

  if (!buildConfig.sourceFiles || typeof buildConfig.sourceFiles !== 'object' || Array.isArray(buildConfig.sourceFiles)) {
    throw new Error('config/build.json sourceFiles must be an object');
  }
  for (const [dest, source] of Object.entries(buildConfig.sourceFiles)) {
    assertSafeRelativeFile('sourceFiles destination', dest);
    assertSafeRelativeFile('sourceFiles source', source);
    if (!buildConfig.extensionFiles.includes(dest)) {
      throw new Error(`sourceFiles destination is not allowlisted in extensionFiles: ${dest}`);
    }
  }

  if (!Array.isArray(buildConfig.hostMatches) || !buildConfig.hostMatches.every((match) =>
    match === 'https://chat.chatto.run/*' || match === 'https://chatto.pixel-box.net/*')) {
    throw new Error('hostMatches must be restricted to the intended Chatto domains');
  }
  if (typeof buildConfig.geckoId !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(buildConfig.geckoId)) {
    throw new Error(`Invalid Gecko extension id: ${buildConfig.geckoId}`);
  }
}

validateBuildConfig();

export function removeKnownDir(relativePath) {
  const full = assertInsideRoot(path.join(root, relativePath));
  const base = path.basename(full);
  if (!['dist', 'artifacts'].includes(base)) {
    throw new Error(`Refusing to remove unexpected directory: ${relativePath}`);
  }
  fs.rmSync(full, { recursive: true, force: true });
}

export function ensureDir(dir) {
  fs.mkdirSync(assertInsideRoot(dir), { recursive: true });
}

export function copyFile(sourceRelative, destRoot, destRelative) {
  const source = assertInsideRoot(path.join(root, sourceRelative));
  const dest = assertInsideRoot(path.join(destRoot, destRelative));
  ensureDir(path.dirname(dest));
  fs.copyFileSync(source, dest);
}

export function manifestFor(target) {
  const manifest = structuredClone(sharedManifest);
  manifest.version = buildConfig.version;
  manifest.content_scripts = manifest.content_scripts.map((script) => ({
    ...script,
    matches: [...buildConfig.hostMatches],
  }));
  manifest.web_accessible_resources = manifest.web_accessible_resources.map((entry) => ({
    ...entry,
    matches: [...buildConfig.hostMatches],
  }));

  if (target === 'chromium') {
    delete manifest.browser_specific_settings;
  } else if (target === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: buildConfig.geckoId,
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
  return manifest;
}

export function writeJson(filePath, value) {
  fs.writeFileSync(assertInsideRoot(filePath), `${JSON.stringify(value, null, 2)}\n`);
}

export function listFiles(dir, prefix = '') {
  const full = assertInsideRoot(dir, { allowRoot: true });
  if (!fs.existsSync(full)) return [];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name).replaceAll(path.sep, '/');
    const abs = path.join(full, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function extensionOutputDir(target) {
  return path.join(distDir, target);
}
