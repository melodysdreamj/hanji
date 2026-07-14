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
  const dockerfile = read('backend/Dockerfile');
  const edgebaseConfig = read('backend/edgebase.config.ts');
  const launcher = read('scripts/selfhost-docker.sh');
  const persistedSecretList = entrypoint.match(/const secretNames = \[([\s\S]*?)\];/)?.[1] ?? '';

  assert.match(entrypoint, /process\.env\.HANJI_BROWSER_SETUP \|\|= 'true'/);
  assert.match(entrypoint, /process\.env\.HANJI_TRUST_SELF_HOSTED_PROXY \|\|= 'true'/);
  assert.match(entrypoint, /process\.env\.EDGEBASE_CONFIG_ENV_ALLOWLIST/);
  assert.match(entrypoint, /for \(const name of secretNames\) configEnvAllowlist\.add\(name\)/);
  assert.match(entrypoint, /name\.startsWith\('HANJI_'\)/);
  assert.match(entrypoint, /const devVarsPath = '\/app\/\.dev\.vars'/);
  assert.match(entrypoint, /mode: 0o600/);
  assert.doesNotMatch(entrypoint, /CLOUDFLARE_INCLUDE_PROCESS_ENV\s*\|\|=\s*'true'/);
  assert.doesNotMatch(dockerfile, /ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true/);
  assert.match(entrypoint, /process\.env\.LOCAL_PROTOCOL \|\| 'http'/);
  assert.match(
    edgebaseConfig,
    /const ALLOW_INSECURE_LOCALHOST_AUTH = ALLOW_DEV_GUEST_LOGIN \|\| TRUST_SELF_HOSTED_PROXY/,
  );
  assert.match(edgebaseConfig, /allowInsecureLocalhost:\s*ALLOW_INSECURE_LOCALHOST_AUTH/);
  assert.doesNotMatch(edgebaseConfig, /allowInsecureLocalhost:\s*BROWSER_SETUP_ENABLED/);
  assert.match(edgebaseConfig, /trustSelfHostedProxy:\s*TRUST_SELF_HOSTED_PROXY/);
  assert.match(edgebaseConfig, /const TRUST_SELF_HOSTED_PROXY = envFlag\('HANJI_TRUST_SELF_HOSTED_PROXY'\)/);
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
    /EDGEBASE_CONFIG_ENV_ALLOWLIST=\$\{EDGEBASE_CONFIG_ENV_ALLOWLIST:-HANJI_ALLOW_DEV_GUEST_LOGIN,HANJI_BROWSER_SETUP\}/,
    'the config-time guest and browser-setup flags must remain the explicit default allowlist while permitting a caller to add named keys',
  );
  assert.match(devScript, /HANJI_BROWSER_SETUP=true/);
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

test('live CI runtimes complete the browser setup endpoint without stored master env', () => {
  const ci = read('.github/workflows/ci.yml');
  const runtimeSteps = ci.match(
    /- name: Start EdgeBase dev runtime\n[\s\S]*?(?=\n      - name:)/g,
  ) ?? [];

  assert.equal(runtimeSteps.length, 2, 'expected API and UI live-runtime jobs');
  for (const step of runtimeSteps) {
    assert.match(step, /echo "HANJI_BROWSER_SETUP=true"/);
    assert.match(step, /\} > \.dev\.vars/);
    assert.doesNotMatch(step, /HANJI_MASTER_(?:EMAIL|PASSWORD)=/);
  }
  const setupSteps = ci.match(
    /- name: Complete browser first-run setup for (?:API|UI) smokes\n[\s\S]*?(?=\n      - name:)/g,
  ) ?? [];
  assert.equal(setupSteps.length, 2, 'expected API and UI browser-setup completion steps');
  for (const step of setupSteps) {
    assert.match(step, /api\/functions\/instance-bootstrap/);
    assert.match(step, /action: "completeSetup"/);
    assert.match(step, /email: "master@hanji\.local"/);
    assert.match(step, /password: "HanjiMaster!2026"/);
    assert.match(step, /response\.status !== 201/);
  }
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
  assert.match(String(scripts.deploy ?? ''), /prepare-browser-setup\.mjs/);
  assert.match(String(scripts.deploy ?? ''), /--print-url/);
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
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/melodysdreamj\/hanji/);
  assert.match(workflow, /DOCKERHUB_IMAGE: melodysdreamj\/hanji/);
  assert.equal(
    workflow.match(/username: \$\{\{ vars\.DOCKERHUB_USERNAME \}\}/g)?.length,
    2,
    'both the platform and manifest jobs must authenticate to Docker Hub through the environment variable',
  );
  assert.equal(
    workflow.match(/password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/g)?.length,
    2,
    'both the platform and manifest jobs must use the Docker Hub environment secret',
  );
  assert.doesNotMatch(
    workflow,
    /DOCKERHUB_(?:USERNAME|TOKEN):\s*(?:melodysdreamj|dckr_pat_)/,
    'Docker Hub credentials must never be embedded in the workflow',
  );
  assert.match(
    workflow,
    /outputs: type=image,"name=\$\{\{ env\.IMAGE_NAME \}\},\$\{\{ env\.DOCKERHUB_IMAGE \}\}",push-by-digest=true,name-canonical=true,push=true/,
    'one image exporter must push its single attested digest under both registry names',
  );
  assert.equal(
    workflow.match(/outputs: type=image,/g)?.length,
    1,
    'separate image exporters would generate registry-specific provenance digests',
  );
  assert.match(workflow, /Verify both registries received the exact platform digest/);
  assert.match(workflow, /cmp ghcr-platform\.json dockerhub-platform\.json/);
  assert.match(workflow, /Create tags only from verified platform digests/);
  assert.equal(
    workflow.match(/docker buildx imagetools create/g)?.length,
    2,
    'each registry manifest must be assembled from its already-verified platform digests',
  );
  assert.match(workflow, /ghcr_refs\+=\("\$IMAGE_NAME@\$digest"\)/);
  assert.match(workflow, /dockerhub_refs\+=\("\$DOCKERHUB_IMAGE@\$digest"\)/);
  assert.match(workflow, /\[\[ "\$ghcr_digest" == "\$dockerhub_digest" \]\]/);
  assert.match(workflow, /cmp ghcr-index\.json dockerhub-index\.json/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(workflow, /subject-name: \$\{\{ env\.IMAGE_NAME \}\}/);
  assert.match(workflow, /Require anonymous pullability and registry parity/);
  assert.match(workflow, /docker logout ghcr\.io/);
  assert.match(workflow, /docker logout docker\.io/);
  assert.match(workflow, /cmp anonymous-ghcr\.json anonymous-dockerhub\.json/);
  assert.match(workflow, /docker buildx imagetools inspect/);
  assert.equal(
    workflow.match(/type=raw,value=alpha,enable=\$\{\{ contains\(github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name, '-alpha'\) \}\}/g)?.length,
    2,
    'alpha releases must advance the moving alpha tag in both metadata phases',
  );
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
