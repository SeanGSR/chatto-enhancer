import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildConfig,
  extensionOutputDir,
  listFiles,
  manifestFor,
  root,
  sharedManifest,
  targets,
} from './common.mjs';

const errors = [];
const requiredManifestKeys = ['manifest_version', 'name', 'version', 'description', 'permissions', 'content_scripts'];
const extensionSourceFiles = Object.values(buildConfig.sourceFiles);
const jsonFiles = ['package.json', 'config/build.json', 'config/manifest.shared.json'];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const forbiddenFilename = /(^|[/\\])(\.env|.*\.(pem|key|p12|pfx|sqlite|db)|cookies?\.txt|.*token.*|.*secret.*)$/i;
const forbiddenPatterns = [
  ['eval', /\beval\s*\(/],
  ['Function constructor', /\bFunction\s*\(/],
  ['innerHTML write', /\.innerHTML\s*=/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\s*\(/],
  ['DOMParser', /\bDOMParser\b/],
  ['remote script URL', /https?:\/\/[^"']+\.js\b/i],
  ['javascript URL', /javascript\s*:/i],
  ['data URL in executable context', /\b(?:href|src)\s*=\s*["']data:/i],
];

function fail(message) {
  errors.push(message);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

for (const file of jsonFiles) {
  try { JSON.parse(read(file)); } catch (error) { fail(`${file}: invalid JSON: ${error.message}`); }
}

if (sharedManifest.manifest_version !== 3) fail('config/manifest.shared.json: manifest_version must be 3');
if (sharedManifest.version !== buildConfig.version) {
  fail(`manifest/package version mismatch: ${sharedManifest.version} != ${buildConfig.version}`);
}
if (packageJson.version !== buildConfig.version) {
  fail(`package/config version mismatch: ${packageJson.version} != ${buildConfig.version}`);
}
for (const script of ['check', 'build', 'package']) {
  const command = packageJson.scripts?.[script];
  const match = typeof command === 'string' && /^node (scripts\/[a-z]+\.mjs)$/.exec(command);
  if (!match || !fs.existsSync(path.join(root, match[1]))) {
    fail(`package.json script "${script}" must point to an existing scripts/*.mjs file`);
  }
}
if (!Array.isArray(sharedManifest.permissions) || sharedManifest.permissions.join(',') !== 'storage') {
  fail('manifest permissions must be exactly ["storage"]');
}

for (const target of targets) {
  const manifest = manifestFor(target);
  for (const key of requiredManifestKeys) {
    if (!(key in manifest)) fail(`${target} manifest missing ${key}`);
  }
  if (target === 'chromium' && 'browser_specific_settings' in manifest) {
    fail('Chromium manifest must not include browser_specific_settings');
  }
  if (target === 'firefox' && manifest.browser_specific_settings?.gecko?.id !== buildConfig.geckoId) {
    fail('Firefox manifest missing stable Gecko id');
  }
  for (const script of manifest.content_scripts || []) {
    for (const file of [...(script.js || []), ...(script.css || [])]) {
      if (!buildConfig.extensionFiles.includes(file)) fail(`${target} manifest references unexpected file: ${file}`);
    }
    for (const match of script.matches || []) {
      if (!buildConfig.hostMatches.includes(match)) fail(`${target} manifest has unexpected match: ${match}`);
    }
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const file of entry.resources || []) {
      if (file !== 'main-world.js') fail(`${target} exposes unexpected web-accessible resource: ${file}`);
    }
  }
}

for (const [dest, source] of Object.entries(buildConfig.sourceFiles)) {
  if (!fs.existsSync(path.join(root, source))) fail(`Missing source for ${dest}: ${source}`);
}

for (const file of extensionSourceFiles) {
  const text = read(file);
  for (const [label, pattern] of forbiddenPatterns) {
    if (pattern.test(text)) fail(`${file}: forbidden pattern found: ${label}`);
  }
}

for (const file of listFiles(root)) {
  if (file.startsWith('.git/') || file.startsWith('dist/') || file.startsWith('artifacts/')) continue;
  if (forbiddenFilename.test(file)) fail(`Potential secret/private file name should not be committed: ${file}`);
}

for (const file of extensionSourceFiles.filter((file) => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${file}: JavaScript syntax check failed:\n${result.stderr || result.stdout}`);
}

for (const target of targets) {
  const outDir = extensionOutputDir(target);
  if (!fs.existsSync(outDir)) continue;
  const files = listFiles(outDir);
  const allowed = [...buildConfig.extensionFiles].sort();
  if (JSON.stringify(files) !== JSON.stringify(allowed)) {
    fail(`dist/${target} contains unexpected files: ${files.join(', ')}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('Checks passed');
