import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  assert.match(
    dockerfile,
    /apt-get install -y --no-install-recommends ca-certificates/,
    'the runtime image must trust public HTTPS APIs through the system CA bundle',
  );
  assert.match(dockerfile, /ENV LOCAL_PROTOCOL=http/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  assert.doesNotMatch(
    dockerfile,
    /corepack\s+(?:enable|prepare)|pnpm@/,
    'the runtime image must not install the unused pnpm toolchain',
  );
});

test('the container enables browser-only setup without a terminal setup secret', () => {
  const entrypoint = read('backend/docker-context/edgebase-entrypoint.mjs');
  const edgebaseConfig = read('backend/edgebase.config.ts');
  const launcher = read('scripts/selfhost-docker.sh');
  const persistedSecretList = entrypoint.match(/const secretNames = \[([\s\S]*?)\];/)?.[1] ?? '';

  assert.match(entrypoint, /process\.env\.HANJI_BROWSER_SETUP \|\|= 'true'/);
  assert.match(entrypoint, /process\.env\.LOCAL_PROTOCOL \|\| 'http'/);
  assert.match(edgebaseConfig, /allowInsecureLocalhost:\s*BROWSER_SETUP_ENABLED/);
  assert.match(edgebaseConfig, /trustSelfHostedProxy:\s*TRUST_SELF_HOSTED_PROXY/);
  assert.match(
    edgebaseConfig,
    /envValue\('HANJI_TRUST_SELF_HOSTED_PROXY'\) === undefined[\s\S]*?BROWSER_SETUP_ENABLED/,
  );
  assert.doesNotMatch(persistedSecretList, /HANJI_SETUP_TOKEN/);
  assert.doesNotMatch(entrypoint, /console\.log\([^\n]*first-run setup code/i);
  assert.doesNotMatch(launcher, /HANJI_SETUP_TOKEN|Code:\s+%s/);
});

test('a registry-pulled image refuses to start when Docker persistence is nearly full', () => {
  const entrypoint = read('backend/docker-context/edgebase-entrypoint.mjs');

  assert.match(entrypoint, /statfsSync\(persistDir\)/);
  assert.match(entrypoint, /HANJI_DOCKER_MIN_FREE_KB \|\| '524288'/);
  assert.match(entrypoint, /HANJI_DOCKER_MIN_FREE_KB must be a non-negative integer/);
  assert.match(
    entrypoint,
    /Docker persistence storage is too full[\s\S]*?Free Docker disk space and restart\. The \/data volume was kept\./,
  );
  assert.ok(
    entrypoint.indexOf('statfsSync(persistDir)') < entrypoint.indexOf('mkdirSync(secretDir'),
    'the disk guard must run before the entrypoint writes persistent secrets',
  );
});

test('local dev allowlists config flags without exposing the parent shell to the worker', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  const devScript = String(backendPackage.scripts?.dev ?? '');
  const refreshScript = read('scripts/refresh-edgebase-dev.mjs');
  const nonvisualScript = read('scripts/nonvisual-verify.mjs');

  assert.match(
    devScript,
    /EDGEBASE_CONFIG_ENV_ALLOWLIST=\$\{EDGEBASE_CONFIG_ENV_ALLOWLIST:-HANJI_ALLOW_DEV_GUEST_LOGIN\}/,
    'the config-time guest flag must remain the explicit default allowlist while permitting a caller to add named keys',
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

test('live CI runtimes provision smoke credentials through worker-visible dev vars', () => {
  const ci = read('.github/workflows/ci.yml');
  const runtimeSteps = ci.match(
    /- name: Start EdgeBase dev runtime\n[\s\S]*?(?=\n      - name:)/g,
  ) ?? [];

  assert.equal(runtimeSteps.length, 2, 'expected API and UI live-runtime jobs');
  for (const step of runtimeSteps) {
    assert.match(step, /echo "HANJI_MASTER_EMAIL=master@hanji\.local"/);
    assert.match(step, /echo "HANJI_MASTER_PASSWORD=HanjiMaster!2026"/);
    assert.match(step, /\} > \.dev\.vars/);
    assert.doesNotMatch(step, /export HANJI_MASTER_(?:EMAIL|PASSWORD)=/);
  }
  assert.match(
    ci,
    /name: Provision CI master account[\s\S]*?api\/functions\/instance-bootstrap[\s\S]*?body\.masterReady !== true/,
    'API smokes must trigger and verify the lazy environment-provisioned master bootstrap before cleanup',
  );
  assert.match(
    ci,
    /name: Build web bundle[\s\S]*?VITE_ALLOW_ANONYMOUS_BOOTSTRAP: "true"/,
    'the production-style UI bundle must explicitly opt into the local-only guest smoke surface',
  );
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

test('release versions and published EdgeBase pins stay aligned', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  const webPackage = JSON.parse(read('web/package.json'));
  const mcpPackage = JSON.parse(read('mcp/package.json'));
  const edgebaseVersion = backendPackage.devDependencies?.['@edge-base/cli'];

  assert.equal(webPackage.version, backendPackage.version);
  assert.equal(mcpPackage.version, backendPackage.version);
  assert.match(backendPackage.version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
  assert.match(edgebaseVersion ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(backendPackage.devDependencies?.['@edge-base/shared'], edgebaseVersion);
  assert.equal(webPackage.dependencies?.['@edge-base/web'], edgebaseVersion);

  const dockerBuild = read('scripts/build-hanji-docker-image.mjs');
  assert.doesNotMatch(
    dockerBuild,
    /cpSync|join\(backendDir, ['"]docker-context['"]\)/,
    'Hanji must rely on the pinned EdgeBase Docker context contract instead of copying support files a second time',
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

test('GitHub-maintained workflow actions stay on reviewed Node 24-compatible releases', () => {
  const expected = new Map([
    [
      'actions/attest-build-provenance',
      {
        sha: '0f67c3f4856b2e3261c31976d6725780e5e4c373',
        version: 'v4.1.1',
      },
    ],
    [
      'actions/checkout',
      {
        sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
        version: 'v7.0.0',
      },
    ],
    [
      'actions/configure-pages',
      {
        sha: '45bfe0192ca1faeb007ade9deae92b16b8254a0d',
        version: 'v6.0.0',
      },
    ],
    [
      'actions/deploy-pages',
      {
        sha: 'cd2ce8fcbc39b97be8ca5fce6e763baed58fa128',
        version: 'v5.0.0',
      },
    ],
    [
      'actions/download-artifact',
      {
        sha: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
        version: 'v8.0.1',
      },
    ],
    [
      'actions/setup-node',
      {
        sha: '48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
        version: 'v6.4.0',
      },
    ],
    [
      'actions/upload-artifact',
      {
        sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        version: 'v7.0.1',
      },
    ],
    [
      'actions/upload-pages-artifact',
      {
        sha: 'fc324d3547104276b827a68afc52ff2a11cc49c9',
        version: 'v5.0.0',
      },
    ],
  ]);
  const counts = new Map([...expected.keys()].map((action) => [action, 0]));

  for (const workflowFile of readdirSync(workflowsDir)) {
    if (!workflowFile.endsWith('.yml') && !workflowFile.endsWith('.yaml')) continue;
    const lines = readFileSync(join(workflowsDir, workflowFile), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const parsed = line.match(
        /^\s*(?:-\s*)?uses:\s*(actions\/[a-z0-9-]+)@([0-9a-f]{40})\s+#\s+(v\d+(?:\.\d+){0,2})\s*$/,
      );
      if (!parsed) continue;
      const [, action, sha, version] = parsed;
      const pin = expected.get(action);
      assert.ok(pin, `${workflowFile}:${index + 1} must add ${action} to the reviewed action pins`);
      assert.equal(sha, pin.sha, `${workflowFile}:${index + 1} must use ${action} ${pin.version}`);
      assert.equal(version, pin.version, `${workflowFile}:${index + 1} version comment must match the reviewed pin`);
      counts.set(action, counts.get(action) + 1);
    }
  }

  for (const [action, count] of counts) {
    assert.ok(count > 0, `expected at least one ${action} use`);
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

  const ignoredTrivyCache = spawnSync(
    'git',
    ['check-ignore', '--verbose', '--no-index', '.cache/trivy/db/trivy.db'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(
    ignoredTrivyCache.status,
    0,
    'Trivy repository cache must stay outside public Git candidates scanned by release preflight',
  );
  assert.match(
    ignoredTrivyCache.stdout,
    /^\.gitignore:\d+:\/\.cache\//,
    'the repository .gitignore must own the Trivy cache exclusion',
  );
});

test('packed runtime file cleanup uses the credentials that provisioned that runtime', () => {
  const packagingScript = read('scripts/verify-edgebase-packaging.mjs');
  const smokeStart = packagingScript.indexOf("run('pack runtime file/storage smoke'");
  const smokeEnd = packagingScript.indexOf('    } catch (error)', smokeStart);
  assert.ok(smokeStart >= 0 && smokeEnd > smokeStart, 'expected the packed runtime file smoke call');

  const smokeCall = packagingScript.slice(smokeStart, smokeEnd);
  assert.match(smokeCall, /HANJI_MASTER_EMAIL:\s*runtimeEnv\.HANJI_MASTER_EMAIL/);
  assert.match(smokeCall, /HANJI_MASTER_PASSWORD:\s*runtimeEnv\.HANJI_MASTER_PASSWORD/);
  assert.match(
    packagingScript,
    /function run\(label, command, args, cwd, env = \{\}\)[\s\S]*?env: \{ \.\.\.process\.env, \.\.\.env, CI: '1' \}/,
    'the subprocess runner must apply scoped environment overrides',
  );
});

test('container releases verify and publish both supported architectures with provenance', () => {
  const workflow = read('.github/workflows/container-release.yml');
  const packagingScript = read('scripts/verify-edgebase-packaging.mjs');

  assert.match(workflow, /tags:\n\s+- 'v\*\.\*\.\*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /platform: linux\/amd64[\s\S]*runner: ubuntu-24\.04/);
  assert.match(workflow, /platform: linux\/arm64[\s\S]*runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /platforms: \$\{\{ matrix\.platform \}\}/);
  assert.match(workflow, /--runtime-image "\$IMAGE_NAME@\$DIGEST"/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /push-by-digest=true,name-canonical=true,push=true/);
  assert.match(workflow, /Create tags only from verified platform digests/);
  assert.match(workflow, /docker buildx imagetools create/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(workflow, /Require anonymous pullability before calling the image public/);
  assert.match(workflow, /docker buildx imagetools inspect/);
  assert.equal(
    workflow.match(/type=raw,value=latest,enable=\$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && !contains\(github\.ref_name, '-'\) \}\}/g)?.length,
    2,
    'prerelease tags must never overwrite latest',
  );
  assert.match(packagingScript, /arg === '--runtime-image'/);
  assert.match(packagingScript, /verifyRegistryFirstRun\(options\.runtimeImage\)/);
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
