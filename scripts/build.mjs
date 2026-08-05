import fs from 'node:fs';
import path from 'node:path';
import {
  assertInsideRoot,
  buildConfig,
  copyFile,
  distDir,
  ensureDir,
  extensionOutputDir,
  manifestFor,
  removeKnownDir,
  root,
  targets,
  writeJson,
} from './common.mjs';

removeKnownDir('dist');
ensureDir(distDir);

/* Giphy issues one API key per app, not per user, so it is injected here
   from an environment variable rather than shipped in the repo or collected
   from installers. The placeholder in src/background.js is what GitHub (and
   anyone browsing the source) actually sees; only the built dist/ and
   artifacts/ output — both gitignored — ever contains the real key. */
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
if (!GIPHY_API_KEY) {
  console.warn(
    'GIPHY_API_KEY is not set — building without it. GIF search will be ' +
    'disabled in this build. Set the environment variable before running ' +
    '"npm run build" to enable it.',
  );
}

function writeBackgroundScript(source, outDir, dest) {
  const text = fs.readFileSync(assertInsideRoot(path.join(root, source)), 'utf8');
  const injected = text.replace('__GIPHY_API_KEY__', () => GIPHY_API_KEY);
  fs.writeFileSync(assertInsideRoot(path.join(outDir, dest)), injected);
}

for (const target of targets) {
  const outDir = extensionOutputDir(target);
  ensureDir(outDir);
  writeJson(path.join(outDir, 'manifest.json'), manifestFor(target));
  for (const [dest, source] of Object.entries(buildConfig.sourceFiles)) {
    if (dest === 'background.js') writeBackgroundScript(source, outDir, dest);
    else copyFile(source, outDir, dest);
  }
}

console.log(`Built ${targets.map((target) => `dist/${target}`).join(' and ')}`);
