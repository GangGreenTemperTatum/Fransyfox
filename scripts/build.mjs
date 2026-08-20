import { build } from 'vite';
import { access, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST_CHROME = path.join(ROOT, 'dist', 'chrome');
const DIST_FIREFOX = path.join(ROOT, 'dist', 'firefox');
const ASSETS_DIR = path.join(ROOT, 'assets');
const FIREFOX_MANIFEST = 'manifest.firefox.json';

const staticFiles = [
  'manifest.json',
  'panel.html',
  'panel.css',
  'panel-modals.css',
  'devtools.html'
];

const staticDirs = [
  'icons',
  'lib'
];

const entryBuilds = [
  { entry: 'src/shared/constants.ts', outFile: 'shared/constants.js', name: 'FransceiverSharedConstantsBundle' },
  { entry: 'src/shared/url-utils.ts', outFile: 'shared/url-utils.js', name: 'FransceiverSharedUrlUtilsBundle' },
  { entry: 'src/shared/messages.ts', outFile: 'shared/messages.js', name: 'FransceiverSharedMessagesBundle' },
  { entry: 'src/shared/logger.ts', outFile: 'shared/logger.js', name: 'FransceiverSharedLoggerBundle' },
  { entry: 'src/shared/event-store.ts', outFile: 'shared/event-store.js', name: 'FransceiverSharedEventStoreBundle' },
  { entry: 'src/shared/findings.ts', outFile: 'shared/findings.js', name: 'FransceiverSharedFindingsBundle' },
  { entry: 'src/main.ts', outFile: 'main.js', name: 'FransceiverMainBundle' },
  { entry: 'src/bridge.ts', outFile: 'bridge.js', name: 'FransceiverBridgeBundle' },
  { entry: 'src/background.ts', outFile: 'background.js', name: 'FransceiverBackgroundBundle' },
  { entry: 'src/panel-storage.ts', outFile: 'panel-storage.js', name: 'FransceiverPanelStorageBundle' },
  { entry: 'src/panel-ui-messages.ts', outFile: 'panel-ui-messages.js', name: 'FransceiverPanelUIMessagesBundle' },
  { entry: 'src/panel-ui-findings.ts', outFile: 'panel-ui-findings.js', name: 'FransceiverPanelUIFindingsBundle' },
  { entry: 'src/panel-ui-map.ts', outFile: 'panel-ui-map.js', name: 'FransceiverPanelUIMapBundle' },
  { entry: 'src/panel-ui-timeline.ts', outFile: 'panel-ui-timeline.js', name: 'FransceiverPanelUITimelineBundle' },
  { entry: 'src/panel-ui.ts', outFile: 'panel-ui.js', name: 'FransceiverPanelUIBundle' },
  { entry: 'src/panel-modals.ts', outFile: 'panel-modals.js', name: 'FransceiverPanelModalsBundle' },
  { entry: 'src/panel-main.ts', outFile: 'panel-main.js', name: 'FransceiverPanelMainBundle' },
  { entry: 'src/devtools.ts', outFile: 'devtools.js', name: 'FransceiverDevtoolsBundle' }
];

async function ensureDirFor(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function copyStaticAssets() {
  for (const file of staticFiles) {
    const srcPath = path.join(ASSETS_DIR, file);
    const destPath = path.join(DIST_CHROME, file);
    await ensureDirFor(destPath);
    await cp(srcPath, destPath);
  }

  for (const dir of staticDirs) {
    const srcPath = path.join(ASSETS_DIR, dir);
    const destPath = path.join(DIST_CHROME, dir);
    await cp(srcPath, destPath, { recursive: true });
  }
}

async function runBuild(entryConfig) {
  const entry = path.join(ROOT, entryConfig.entry);
  await build({
    configFile: false,
    logLevel: 'info',
    build: {
      target: 'es2022',
      outDir: DIST_CHROME,
      emptyOutDir: false,
      sourcemap: true,
      minify: false,
      lib: {
        entry,
        formats: ['iife'],
        name: entryConfig.name,
        fileName: () => entryConfig.outFile
      },
      rollupOptions: {
        output: {
          extend: true,
          inlineDynamicImports: true
        }
      }
    }
  });
}

async function assertFileExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Expected build output missing: ${filePath}`);
  }
}

async function buildFirefoxOutput() {
  await assertFileExists(path.join(ASSETS_DIR, FIREFOX_MANIFEST));
  await mkdir(DIST_FIREFOX, { recursive: true });
  const entries = await readdir(DIST_CHROME, { withFileTypes: true });
  for (const entry of entries) {
    await cp(
      path.join(DIST_CHROME, entry.name),
      path.join(DIST_FIREFOX, entry.name),
      { recursive: true }
    );
  }
  await cp(
    path.join(ASSETS_DIR, FIREFOX_MANIFEST),
    path.join(DIST_FIREFOX, 'manifest.json')
  );
  await assertFileExists(path.join(DIST_FIREFOX, 'manifest.json'));

  const firefoxReadmeText = `Fransceiver Firefox build output\nBuilt: ${new Date().toISOString()}\nLoad this folder as a temporary add-on via about:debugging, or check the release artifacts for a signed package.\n`;
  await writeFile(path.join(DIST_FIREFOX, 'README.txt'), firefoxReadmeText);
}

async function run() {
  await rm(path.join(ROOT, 'dist'), { recursive: true, force: true });
  await mkdir(DIST_CHROME, { recursive: true });

  await copyStaticAssets();

  for (const entry of entryBuilds) {
    await runBuild(entry);
  }

  const expectedFiles = [
    'manifest.json',
    'panel.html',
    'panel.css',
    'panel-modals.css',
    ...entryBuilds.map((entry) => entry.outFile)
  ];

  for (const expectedFile of expectedFiles) {
    await assertFileExists(path.join(DIST_CHROME, expectedFile));
  }

  await buildFirefoxOutput();

  const builtAt = new Date().toISOString();
  const markerPath = path.join(DIST_CHROME, '.build-meta.json');
  const marker = {
    builtAt,
    entryCount: entryBuilds.length,
    output: DIST_CHROME,
    firefoxOutput: DIST_FIREFOX
  };
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');

  const readmePath = path.join(DIST_CHROME, 'README.txt');
  const readmeText = `Fransceiver build output\nBuilt: ${builtAt}\nLoad this folder as unpacked extension.\n`;
  await writeFile(readmePath, readmeText, 'utf8');
}

run().catch(async (error) => {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await writeFile(path.join(ROOT, 'dist-build-error.log'), `${msg}\n`, 'utf8');
  console.error(error);
  process.exitCode = 1;
});
