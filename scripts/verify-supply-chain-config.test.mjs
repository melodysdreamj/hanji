import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(root, '.github', 'workflows');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('the release container base image is pinned to an immutable multi-arch digest', () => {
  const dockerfile = read('backend/Dockerfile');
  const baseImage = dockerfile.match(/^FROM\s+(\S+)\s*$/m)?.[1];

  assert.match(
    baseImage ?? '',
    /^node:22-slim@sha256:[0-9a-f]{64}$/,
    'backend/Dockerfile must pin node:22-slim by its manifest-list digest',
  );
  assert.match(
    dockerfile,
    /npm install -g npm@\d+\.\d+\.\d+/,
    'the npm bundled in the base image must be upgraded to an exact patched version',
  );
  assert.doesNotMatch(
    dockerfile,
    /corepack\s+(?:enable|prepare)|pnpm@/,
    'the runtime image must not install the unused pnpm toolchain',
  );
});

test('local dev allowlists config flags without exposing the parent shell to the worker', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  const devScript = String(backendPackage.scripts?.dev ?? '');
  const refreshScript = read('scripts/refresh-edgebase-dev.mjs');
  const nonvisualScript = read('scripts/nonvisual-verify.mjs');

  assert.match(
    devScript,
    /EDGEBASE_CONFIG_ENV_ALLOWLIST=HANJI_ALLOW_DEV_GUEST_LOGIN/,
    'the config-time guest flag must be explicitly allowlisted',
  );
  for (const [label, source] of [
    ['backend dev command', devScript],
    ['runtime refresh helper', refreshScript],
    ['nonvisual verification helper', nonvisualScript],
  ]) {
    assert.doesNotMatch(
      source,
      /CLOUDFLARE_INCLUDE_PROCESS_ENV\s*[:=]\s*['"]?true/,
      `${label} must not expose the complete parent process environment`,
    );
  }
});

test('deploy uses strict live-link preflight while ordinary local packaging stays offline', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  const webPackage = JSON.parse(read('web/package.json'));
  const scripts = backendPackage.scripts ?? {};

  assert.match(String(scripts['preflight:release:strict'] ?? ''), /--strict-release/);
  assert.match(String(scripts['preflight:release:strict'] ?? ''), /verify:local-edgebase:release/);
  assert.match(String(scripts['preflight:deploy'] ?? ''), /preflight:release:strict/);
  assert.doesNotMatch(String(scripts['preflight:release'] ?? ''), /--strict-release/);
  assert.match(String(scripts['preflight:release'] ?? ''), /verify:local-edgebase:release/);
  assert.match(String(scripts.pack ?? ''), /preflight:release/);
  assert.doesNotMatch(String(scripts.pack ?? ''), /preflight:release:strict/);
  assert.match(
    String(webPackage.scripts?.build ?? ''),
    /verify-hanji-namespace\.mjs --generated/,
    'every deploy, pack, and packaging path that builds the web app must reject old names in generated output',
  );
});

test('every external GitHub Action is pinned to a full commit with a version comment', () => {
  const workflowFiles = readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  assert.ok(workflowFiles.length > 0, 'expected at least one workflow');

  for (const workflowFile of workflowFiles) {
    const lines = readFileSync(join(workflowsDir, workflowFile), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/^\s*(?:-\s*)?uses:/.test(line)) {
        continue;
      }

      const location = `${workflowFile}:${index + 1}`;
      const parsed = line.match(
        /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(v\d+(?:\.\d+){0,2}))?\s*$/,
      );
      assert.ok(parsed, `${location} must use a simple action reference and version comment`);

      const [, actionReference, versionComment] = parsed;
      if (actionReference.startsWith('./')) {
        continue;
      }

      assert.match(
        actionReference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${location} must pin the external action to a full lowercase commit SHA`,
      );
      assert.ok(versionComment, `${location} must retain the human-readable action version`);
    }
  }
});

test('dependency advisories are gated and docs build code has no deployment token', () => {
  const ci = read('.github/workflows/ci.yml');
  const docs = read('.github/workflows/docs.yml');

  for (const directory of ['backend', 'web', 'mcp']) {
    assert.match(
      ci,
      new RegExp(`working-directory: ${directory}\\n\\s+run: npm audit --audit-level=high`),
      `${directory} dependencies must be audited in CI`,
    );
  }
  assert.match(docs, /run: npm audit --audit-level=high/);
  assert.match(docs, /^permissions:\s*\{\}\s*$/m);

  const buildStart = docs.indexOf('  build:');
  const deployStart = docs.indexOf('  deploy:');
  assert.ok(buildStart >= 0 && deployStart > buildStart, 'expected separate docs build/deploy jobs');
  const build = docs.slice(buildStart, deployStart);
  const deploy = docs.slice(deployStart);
  assert.match(build, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(build, /pages: write|id-token: write|actions\/configure-pages/);
  assert.match(deploy, /permissions:\n\s+contents: read\n\s+pages: write\n\s+id-token: write/);
  assert.match(deploy, /actions\/configure-pages@[0-9a-f]{40}/);
  assert.match(deploy, /actions\/deploy-pages@[0-9a-f]{40}/);
});

test('the Hanji namespace guard blocks both CI and release preflight', () => {
  const ci = read('.github/workflows/ci.yml');
  const releasePreflight = read('scripts/verify-release-config.mjs');
  const rootPackage = JSON.parse(read('package.json'));

  assert.equal(
    rootPackage.scripts?.['verify:namespace'],
    'node scripts/verify-hanji-namespace.mjs',
  );
  assert.equal(
    rootPackage.scripts?.['verify:namespace:generated'],
    'node scripts/verify-hanji-namespace.mjs --generated',
  );
  assert.match(ci, /name: Reject unapproved pre-Hanji namespaces\n\s+run: npm run verify:namespace/);
  assert.match(ci, /name: Test namespace guard and local migration\n\s+run: npm run test:namespace/);
  assert.match(ci, /name: Guard generated Hanji namespace\n\s+run: npm run verify:namespace:generated/);
  assert.match(releasePreflight, /import \{ verifyHanjiNamespace \} from '\.\/verify-hanji-namespace\.mjs';/);
  assert.match(releasePreflight, /verifyHanjiNamespace\(\{ root \}\);/);
});

test('secret scanning never allowlists private runtime or credential paths', () => {
  const config = read('.gitleaks.toml');
  assert.match(config, /id = "forbidden-private-operational-data"/);
  assert.match(config, /id = "forbidden-private-operational-path"/);
  assert.match(config, /tags = \["privacy", "personal-data"\]/);
  for (const forbidden of [
    String.raw`\.edgebase`,
    String.raw`\.git-private`,
    String.raw`\.git-backups`,
    String.raw`\.claude`,
    String.raw`\.dev\.vars`,
    String.raw`\.env\.(?:development|local)`,
  ]) {
    assert.doesNotMatch(
      config,
      new RegExp(forbidden),
      `.gitleaks.toml must scan accidentally committed private path pattern: ${forbidden}`,
    );
  }

  const workflow = read('.github/workflows/secret-scan.yml');
  assert.match(workflow, /gitleaks["']?\s+dir\b/);
  assert.match(workflow, /gitleaks["']?\s+git\b/);
  assert.match(workflow, /--log-opts=["']--all["']/);
});

test('packaging keeps the verified image for an SBOM and a blocking vulnerability scan', () => {
  const packagingScript = read('scripts/verify-edgebase-packaging.mjs');
  const ci = read('.github/workflows/ci.yml');

  assert.match(packagingScript, /keepDockerImage:\s*false/);
  assert.match(packagingScript, /arg === '--keep-docker-image'/);
  assert.match(packagingScript, /imageBuilt && !options\.keepDockerImage/);

  const buildIndex = ci.indexOf('--keep-docker-image');
  const sbomIndex = ci.indexOf('name: Generate container SBOM');
  const reportIndex = ci.indexOf('name: Record all HIGH and CRITICAL container findings');
  const uploadIndex = ci.indexOf('name: Upload container security evidence');
  const scanIndex = ci.indexOf('name: Block HIGH and CRITICAL container vulnerabilities');
  const cleanupIndex = ci.indexOf('name: Remove scanned Docker image');

  assert.ok(buildIndex >= 0, 'CI must retain the runtime-verified image');
  assert.ok(buildIndex < sbomIndex, 'CI must generate the SBOM after the image build');
  assert.ok(sbomIndex < reportIndex, 'CI must record every HIGH/CRITICAL finding');
  assert.ok(reportIndex < uploadIndex, 'CI must upload the SBOM and full finding report');
  assert.ok(uploadIndex < scanIndex, 'CI must preserve the SBOM before the blocking scan');
  assert.ok(scanIndex < cleanupIndex, 'CI must clean up only after the blocking scan');

  const sbomBlock = ci.slice(sbomIndex, reportIndex);
  const reportBlock = ci.slice(reportIndex, uploadIndex);
  const scanBlock = ci.slice(scanIndex, cleanupIndex);

  assert.match(sbomBlock, /format:\s*cyclonedx/);
  assert.match(reportBlock, /format:\s*json/);
  assert.match(reportBlock, /output:\s*hanji-edgebase-vulnerabilities\.json/);
  assert.match(reportBlock, /exit-code:\s*'0'/);
  assert.match(reportBlock, /ignore-unfixed:\s*'false'/);
  assert.match(ci, /if-no-files-found:\s*error/);
  assert.match(scanBlock, /severity:\s*HIGH,CRITICAL/);
  assert.match(scanBlock, /exit-code:\s*'1'/);
  assert.match(scanBlock, /ignore-unfixed:\s*'true'/);
  assert.match(scanBlock, /scanners:\s*vuln/);
  assert.match(ci, /name: Remove scanned Docker image\n\s+if: always\(\)/);

  const imageReference = 'hanji-edgebase-ci:${{ github.sha }}';
  assert.ok(
    ci.split(imageReference).length - 1 >= 5,
    'the build, SBOM, report, scan, and cleanup steps must address the same image',
  );
});

test('every deployable frontend artifact carries the license, exception, and source offer', () => {
  const viteConfig = read('web/vite.config.ts');
  const packagingScript = read('scripts/verify-edgebase-packaging.mjs');
  const sourceOffer = read('SOURCE-OFFER');

  assert.match(viteConfig, /legalArtifactNames\s*=\s*\["LICENSE", "LICENSE-EXCEPTION", "SOURCE-OFFER"\]/);
  assert.match(viteConfig, /copyFileSync/);
  assert.match(packagingScript, /requiredLegalArtifacts\s*=\s*\['LICENSE', 'LICENSE-EXCEPTION', 'SOURCE-OFFER'\]/);
  for (const envName of [
    'HANJI_SOURCE_URL',
    'HANJI_AGPL_LICENSE_URL',
    'HANJI_SPONSOR_EXCEPTION_URL',
  ]) {
    assert.match(sourceOffer, new RegExp(`^${envName}$`, 'm'));
  }
});

test('API smokes keep running after an earlier smoke fails while the runtime is healthy', () => {
  const ci = read('.github/workflows/ci.yml');
  const start = ci.indexOf('      - name: Runtime bundle smoke');
  const end = ci.indexOf('      - name: Dump runtime log on failure', start);
  assert.ok(start >= 0 && end > start, 'expected the API smoke step block');

  const apiBlock = ci.slice(start, end);
  const steps = [...apiBlock.matchAll(/      - name: ([^\n]+)\n([\s\S]*?)(?=\n      - name:|$)/g)]
    .filter((match) => match[2].includes('run: npm run verify:'));
  assert.ok(steps.length >= 10, 'expected the complete API smoke suite');
  for (const [, name, body] of steps) {
    assert.match(
      body,
      /if: \$\{\{ !cancelled\(\) && steps\.runtime\.outcome == 'success' \}\}/,
      `${name} must run after earlier failures whenever runtime health passed`,
    );
  }
});
