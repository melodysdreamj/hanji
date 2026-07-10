#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const edgebaseRoot = resolve(
  process.env.EDGEBASE_LOCAL_PATH ?? process.env.EDGEBASE_ROOT ?? join(root, '..', 'edgebase'),
);
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const backendPackage = JSON.parse(readFileSync(join(root, 'backend', 'package.json'), 'utf8'));
const webPackage = JSON.parse(readFileSync(join(root, 'web', 'package.json'), 'utf8'));
const pinnedEdgebaseVersion = backendPackage.devDependencies?.['@edge-base/cli'];

if (!existsSync(join(edgebaseRoot, 'package.json'))) {
  const guidance =
    `No local EdgeBase checkout at ${edgebaseRoot}. ` +
    'Linking a local EdgeBase source tree is optional; the published @edge-base/* ' +
    'registry packages are used otherwise. Set EDGEBASE_LOCAL_PATH (or EDGEBASE_ROOT) ' +
    'to link one.';
  if (checkOnly) {
    console.log(guidance);
    process.exit(0);
  }
  throw new Error(guidance);
}

const linkedEdgebaseVersion = JSON.parse(
  readFileSync(join(edgebaseRoot, 'package.json'), 'utf8'),
).version;

if (!/^\d+\.\d+\.\d+$/.test(pinnedEdgebaseVersion ?? '')) {
  throw new Error('backend @edge-base/cli must be pinned to an exact release version.');
}
if (backendPackage.devDependencies?.['@edge-base/shared'] !== pinnedEdgebaseVersion) {
  throw new Error('backend @edge-base/shared must match the exact @edge-base/cli version.');
}
if (webPackage.dependencies?.['@edge-base/web'] !== pinnedEdgebaseVersion) {
  throw new Error('web @edge-base/web must match the exact backend EdgeBase version.');
}
if (!/^\d+\.\d+\.\d+$/.test(linkedEdgebaseVersion ?? '')) {
  throw new Error(`Local EdgeBase root must declare an exact release version: ${edgebaseRoot}`);
}

if (linkedEdgebaseVersion !== pinnedEdgebaseVersion) {
  console.warn(
    `Using local EdgeBase ${linkedEdgebaseVersion} while registry dependencies remain pinned to ${pinnedEdgebaseVersion}.`,
  );
}

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node scripts/link-local-edgebase.mjs [--check]

Links Notionlike's EdgeBase package slots to the local EdgeBase workspace.

Options:
  --check   Verify the local links without modifying node_modules.
`);
  process.exit(0);
}

for (const arg of args) {
  if (arg !== '--check') {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const packages = {
  '@edge-base/cli': {
    path: 'packages/cli',
    required: ['package.json', 'dist/index.js'],
  },
  '@edge-base/server': {
    path: 'packages/server',
    required: ['package.json', 'src/index.ts', 'admin-build/index.html'],
  },
  '@edge-base/shared': {
    path: 'packages/shared',
    required: ['package.json', 'dist/index.js', 'dist/index.d.ts'],
  },
  '@edge-base/core': {
    path: 'packages/sdk/js/packages/core',
    required: ['package.json', 'dist/index.js', 'dist/index.d.ts'],
  },
  '@edge-base/web': {
    path: 'packages/sdk/js/packages/web',
    required: ['package.json', 'dist/index.js', 'dist/index.d.ts'],
  },
};

const targets = {
  backend: ['@edge-base/cli', '@edge-base/server', '@edge-base/shared', '@edge-base/core'],
  web: ['@edge-base/web', '@edge-base/core', '@edge-base/shared'],
};

function readPackageName(packagePath) {
  const jsonPath = join(packagePath, 'package.json');
  return JSON.parse(readFileSync(jsonPath, 'utf8')).name;
}

function readPackageVersion(packagePath) {
  return JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')).version;
}

function ensurePackage(packageName) {
  const spec = packages[packageName];
  if (!spec) {
    throw new Error(`Unknown package ${packageName}`);
  }

  const packagePath = join(edgebaseRoot, spec.path);
  for (const required of spec.required) {
    const requiredPath = join(packagePath, required);
    if (!existsSync(requiredPath)) {
      throw new Error(
        `${packageName} is not ready at ${packagePath}; missing ${required}. Run EdgeBase install/build first.`,
      );
    }
  }

  const actualName = readPackageName(packagePath);
  if (actualName !== packageName) {
    throw new Error(`Expected ${packageName} at ${packagePath}, found ${actualName}`);
  }
  const actualVersion = readPackageVersion(packagePath);
  if (actualVersion !== linkedEdgebaseVersion) {
    throw new Error(
      `Expected ${packageName}@${linkedEdgebaseVersion} to match the local EdgeBase root at ${packagePath}, found ${actualVersion}`,
    );
  }

  return packagePath;
}

function linkPackage(project, packageName) {
  const source = ensurePackage(packageName);
  const scopeDir = join(root, project, 'node_modules', '@edge-base');
  const linkName = packageName.split('/')[1];
  const destination = join(scopeDir, linkName);

  if (checkOnly) {
    if (!existsSync(destination)) {
      throw new Error(`${project}: ${packageName} is not linked at ${destination}`);
    }
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${project}: ${packageName} is not a symlink at ${destination}`);
    }
    const actual = realpathSync(destination);
    const expected = realpathSync(source);
    if (actual !== expected) {
      throw new Error(`${project}: ${packageName} points to ${actual}, expected ${expected}`);
    }
    console.log(`OK ${project}: ${packageName} -> ${source}`);
    return;
  }

  mkdirSync(scopeDir, { recursive: true });
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink() && !destination.includes(`${project}/node_modules/@edge-base/`)) {
      throw new Error(`Refusing to replace unexpected path ${destination}`);
    }
    rmSync(destination, { recursive: true, force: true });
  }

  symlinkSync(source, destination, 'dir');
  console.log(`${project}: ${packageName} -> ${source}`);
}

for (const [project, packageNames] of Object.entries(targets)) {
  for (const packageName of packageNames) {
    linkPackage(project, packageName);
  }
}
