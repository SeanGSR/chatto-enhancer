import fs from 'node:fs';
import path from 'node:path';
import {
  buildConfig,
  copyFile,
  distDir,
  ensureDir,
  extensionOutputDir,
  manifestFor,
  removeKnownDir,
  targets,
  writeJson,
} from './common.mjs';

removeKnownDir('dist');
ensureDir(distDir);

for (const target of targets) {
  const outDir = extensionOutputDir(target);
  ensureDir(outDir);
  writeJson(path.join(outDir, 'manifest.json'), manifestFor(target));
  for (const [dest, source] of Object.entries(buildConfig.sourceFiles)) {
    copyFile(source, outDir, dest);
  }
}

console.log(`Built ${targets.map((target) => `dist/${target}`).join(' and ')}`);
