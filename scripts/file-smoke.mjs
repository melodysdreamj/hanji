#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_FILE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const SAMPLE_DMG_BYTES = new Uint8Array([0x78, 0x01, 0x73, 0x0d, 0x62, 0x62, 0x60, 0x60]);
const SAMPLE_MULTIPART_BYTES = new Uint8Array(MULTIPART_UPLOAD_THRESHOLD_BYTES + 1024);
const SAMPLE_MP4_BYTES = new Uint8Array([
  0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109,
  0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50,
]);

const options = parseArgs(process.argv.slice(2));

let owner;
let viewer;
let workspaceId = '';
let organizationId = '';
let pageId = '';
let blockId = '';
let videoBlockId = '';
let permissionId = '';
const uploadIds = [];
// Routing hints for the workspace-DO split: keys embed the workspace id.
const uploadKeysById = new Map();

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL file smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`File smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);
  viewer = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  organizationId = bootstrap?.organization?.id ?? '';
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(organizationId, 'workspace-bootstrap must return an organization id');

  pageId = crypto.randomUUID();
  const created = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `File smoke ${new Date().toISOString()}`,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'owner must be able to create a smoke page');

  blockId = crypto.randomUUID();
  const block = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'file',
    content: { rich: [], url: '', fileName: 'file-smoke.txt' },
    plainText: 'file-smoke.txt',
    position: 1,
  });
  assert(block?.block?.id === blockId, 'owner must be able to create a file block');

  videoBlockId = crypto.randomUUID();
  const videoBlock = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: videoBlockId,
    pageId,
    parentId: null,
    type: 'video',
    content: { rich: [], url: '' },
    plainText: '',
    position: 2,
  });
  assert(videoBlock?.block?.id === videoBlockId, 'owner must be able to create a video block');

  const ownerFileBytes = new TextEncoder().encode('notionlike file smoke owner');
  const prepared = await prepareUpload(baseUrl, owner.token, {
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-owner.txt',
    size: ownerFileBytes.byteLength,
    contentType: 'text/plain',
  });
  const ownerUploadId = prepared?.upload?.id;
  assert(ownerUploadId, 'prepareUpload must return an upload id');
  uploadIds.push(ownerUploadId);
  assert(prepared.upload.status === 'pending', 'new upload grants must start pending');
  assert(prepared.upload.pageId === pageId, 'upload grant must be attached to the page');
  assert(prepared.upload.blockId === blockId, 'upload grant must be attached to the block');
  console.log('PASS owner can prepare a page/block-scoped file upload grant.');

  const ownerFiles = await listFiles(baseUrl, owner.token, { pageId });
  assert(
    ownerFiles.some((upload) => upload.id === ownerUploadId),
    'owner file listing must include the prepared upload grant',
  );

  const report = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'report',
    workspaceId,
    maintenanceLimit: 5,
  });
  assert(report?.totals?.files >= 1, 'file report must include prepared uploads');
  assert(
    (report?.byStatus?.pending?.count ?? 0) >= 1,
    'file report must count pending upload grants',
  );
  console.log('PASS owner can list uploads and read workspace file usage report.');

  const completedOwnerUpload = await uploadPreparedFile(
    baseUrl,
    owner.token,
    prepared,
    ownerFileBytes,
    'text/plain',
  );
  assert(completedOwnerUpload.status === 'uploaded', 'owner upload must complete before download policy checks');
  const ownerDownload = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  });
  assert(ownerDownload?.url, 'uploaded file must return a signed download URL');

  const dmgPrepared = await prepareUpload(baseUrl, owner.token, {
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-installer.dmg',
    size: SAMPLE_DMG_BYTES.byteLength,
    contentType: 'application/x-apple-diskimage',
  });
  const dmgUploadId = dmgPrepared?.upload?.id;
  assert(dmgUploadId, 'DMG file prepareUpload must return an upload id');
  uploadIds.push(dmgUploadId);
  const completedDmgUpload = await uploadPreparedFile(
    baseUrl,
    owner.token,
    dmgPrepared,
    SAMPLE_DMG_BYTES,
    'application/x-apple-diskimage',
  );
  assert(completedDmgUpload.status === 'uploaded', 'DMG file upload must complete');
  assert(completedDmgUpload.scope === 'blocks/files', 'DMG upload must keep the blocks/files scope');
  assert(completedDmgUpload.contentType === 'application/x-apple-diskimage', 'DMG upload must preserve content type');
  assert(completedDmgUpload.key.endsWith('.dmg'), 'DMG upload key must preserve the .dmg extension');
  await deleteUpload(baseUrl, owner.token, dmgUploadId);
  removeUploadId(dmgUploadId);
  console.log('PASS DMG file uploads complete as regular file attachments.');

  const multipartPrepared = await prepareUpload(baseUrl, owner.token, {
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-multipart.bin',
    size: SAMPLE_MULTIPART_BYTES.byteLength,
    contentType: 'application/octet-stream',
  });
  const multipartUploadId = multipartPrepared?.upload?.id;
  assert(multipartUploadId, 'multipart file prepareUpload must return an upload id');
  uploadIds.push(multipartUploadId);
  const completedMultipartUpload = await uploadPreparedFile(
    baseUrl,
    owner.token,
    multipartPrepared,
    SAMPLE_MULTIPART_BYTES,
    'application/octet-stream',
  );
  assert(completedMultipartUpload.status === 'uploaded', 'signed multipart upload must complete');
  assert(completedMultipartUpload.scope === 'blocks/files', 'multipart upload must keep the blocks/files scope');
  assert(completedMultipartUpload.size === SAMPLE_MULTIPART_BYTES.byteLength, 'multipart upload must preserve requested size metadata');
  await deleteUpload(baseUrl, owner.token, multipartUploadId);
  removeUploadId(multipartUploadId);
  console.log('PASS signed multipart file uploads complete through regular file attachments.');

  const videoPrepared = await prepareUpload(baseUrl, owner.token, {
    pageId,
    blockId: videoBlockId,
    scope: 'blocks/videos',
    name: 'file-smoke-video.mp4',
    size: SAMPLE_MP4_BYTES.byteLength,
    contentType: 'video/mp4',
  });
  const videoUploadId = videoPrepared?.upload?.id;
  assert(videoUploadId, 'video block prepareUpload must return an upload id');
  uploadIds.push(videoUploadId);
  const completedVideoUpload = await uploadPreparedFile(
    baseUrl,
    owner.token,
    videoPrepared,
    SAMPLE_MP4_BYTES,
    'video/mp4',
  );
  assert(completedVideoUpload.status === 'uploaded', 'video block upload must complete');
  assert(completedVideoUpload.scope === 'blocks/videos', 'video block upload must keep the blocks/videos scope');
  assert(completedVideoUpload.blockId === videoBlockId, 'video block upload must stay attached to the video block');
  assert(completedVideoUpload.contentType === 'video/mp4', 'video block upload must preserve video content type');
  const videoDownload = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: videoUploadId,
      key: uploadKeysById.get(videoUploadId),
  });
  assert(videoDownload?.url, 'video block upload must return a signed download URL');
  assertSignedDownloadCarriesFileMetadata(
    videoDownload.url,
    SAMPLE_MP4_BYTES.byteLength,
    'video/mp4',
    'video block signed download',
  );
  await assertSignedDownloadSupportsRange(videoDownload.url, SAMPLE_MP4_BYTES, 'video block signed download');
  const tooLargeVideo = await expectFunctionStatus(baseUrl, owner.token, 'file-mutation', {
    action: 'prepareUpload',
    pageId,
    blockId: videoBlockId,
    scope: 'blocks/videos',
    name: 'file-smoke-too-large.mp4',
    size: MAX_FILE_UPLOAD_BYTES + 1,
    contentType: 'video/mp4',
  }, 400);
  assert(/large/i.test(tooLargeVideo?.message ?? ''), 'oversized video uploads must return a clear size error');
  assert(/5 GB/i.test(tooLargeVideo?.message ?? ''), 'oversized video error must mention the 5 GB upload limit');
  await deleteUpload(baseUrl, owner.token, videoUploadId);
  removeUploadId(videoUploadId);
  console.log('PASS video block uploads complete, support ranged playback, and over-limit videos fail clearly.');

  const organizationReport = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'organizationReport',
    organizationId,
    maintenanceLimit: 5,
  });
  assert(organizationReport?.organizationId === organizationId, 'organization file report must echo organization id');
  assert(
    organizationReport?.workspaceCount >= 1,
    'organization file report must include organization workspaces',
  );
  assert(
    organizationReport?.totals?.activeStorageBytes >= ownerFileBytes.byteLength,
    'organization file report must aggregate uploaded bytes across workspaces',
  );
  assert(
    organizationReport?.byWorkspace?.some((item) => item.workspaceId === workspaceId),
    'organization file report must include workspace breakdown',
  );
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'organizationReport',
    organizationId,
  }, 403);
  console.log('PASS organization admins can read organization-wide storage usage reports.');
  const storageLimitBytes = ownerFileBytes.byteLength + 8;
  const limitedOrganization = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes,
  });
  assert(
    limitedOrganization?.organization?.storageLimitBytes === storageLimitBytes,
    'organization owners must be able to set a storage soft limit',
  );
  await expectFunctionStatus(baseUrl, owner.token, 'file-mutation', {
    action: 'prepareUpload',
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-over-limit.txt',
    size: 32,
    contentType: 'text/plain',
  }, 403);
  const unlimitedOrganization = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: null,
  });
  assert(
    unlimitedOrganization?.organization?.storageLimitBytes == null,
    'organization owners must be able to remove the storage soft limit',
  );
  console.log('PASS organization storage soft limits block new upload grants.');
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { fileDownloads: false },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { fileDownloads: true },
  });
  console.log('PASS organization file download policy gates signed download URLs.');

  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'list',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  }, 403);
  console.log('PASS unshared viewer cannot list or download page-scoped files.');

  const share = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'File smoke viewer',
    role: 'view',
  });
  permissionId = share?.permission?.id;
  assert(permissionId, 'share invite must return a permission id');

  const viewerFiles = await listFiles(baseUrl, viewer.token, { pageId });
  assert(
    viewerFiles.some((upload) => upload.id === ownerUploadId),
    'view access must allow listing page-scoped file metadata',
  );
  const viewerDownload = await callFunction(baseUrl, viewer.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  });
  assert(viewerDownload?.url, 'view access must allow signed file downloads when organization policy allows them');
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'prepareUpload',
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-viewer-blocked.txt',
    size: 16,
    contentType: 'text/plain',
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'delete',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  }, 403);
  const afterViewDeleteDenied = await listFiles(baseUrl, owner.token, { pageId });
  assert(
    afterViewDeleteDenied.some((upload) => upload.id === ownerUploadId),
    'view access delete denial must leave the owner upload listed',
  );
  console.log('PASS view access can list/download file metadata but cannot prepare uploads or delete files.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId,
    role: 'edit',
  });
  const viewerPrepared = await prepareUpload(baseUrl, viewer.token, {
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-viewer.txt',
    size: 32,
    contentType: 'text/plain',
  });
  const viewerUploadId = viewerPrepared?.upload?.id;
  assert(viewerUploadId, 'edit access must allow viewer upload preparation');
  uploadIds.push(viewerUploadId);
  console.log('PASS edit access allows preparing page/block-scoped uploads.');

  const cleanupDryRun = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'cleanupExpired',
    workspaceId,
    dryRun: true,
    limit: 10,
  });
  assert(cleanupDryRun?.dryRun === true, 'cleanupExpired dry run must report dryRun true');
  assert(Array.isArray(cleanupDryRun?.expired), 'cleanupExpired dry run must return an expired list');
  console.log('PASS expired upload cleanup dry-run is available through product API.');

  await deleteUpload(baseUrl, viewer.token, viewerUploadId);
  removeUploadId(viewerUploadId);
  const remaining = await listFiles(baseUrl, owner.token, { pageId });
  assert(
    !remaining.some((upload) => upload.id === viewerUploadId) &&
      remaining.some((upload) => upload.id === ownerUploadId),
    'deleted viewer upload grants must be hidden while the owner upload remains listed',
  );
  console.log('PASS deleted upload grants disappear from default listings.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId,
  });
  permissionId = '';
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'list',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'file-mutation', {
    action: 'signedUrl',
    uploadId: ownerUploadId,
      key: uploadKeysById.get(ownerUploadId),
  }, 403);
  console.log('PASS revoking page access blocks file listing and signed downloads again.');

  await deleteUpload(baseUrl, owner.token, ownerUploadId);
  removeUploadId(ownerUploadId);
  const afterOwnerDelete = await listFiles(baseUrl, owner.token, { pageId });
  assert(
    !afterOwnerDelete.some((upload) => upload.id === ownerUploadId),
    'deleted owner upload grant must be hidden from default file listing',
  );
  console.log('PASS owner upload grants can be deleted and disappear from default listings.');

  const cleanupPrepared = await prepareUpload(baseUrl, owner.token, {
    pageId,
    blockId,
    scope: 'blocks/files',
    name: 'file-smoke-page-delete-cleanup.txt',
    size: 40,
    contentType: 'text/plain',
  });
  const cleanupUploadId = cleanupPrepared?.upload?.id;
  assert(cleanupUploadId, 'owner must be able to prepare an upload for page delete cleanup');
  uploadIds.push(cleanupUploadId);

  const deleted = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: pageId,
  });
  assert(
    deleted?.cleanup?.fileUploads >= 1,
    'permanent page delete must clean attached file upload grants',
  );
  removeUploadId(cleanupUploadId);
  pageId = '';
  blockId = '';
  console.log('PASS permanent page delete cleans attached file upload grants.');

  console.log('\nPASS multi-user file grant flow works through product APIs.');
}

async function prepareUpload(baseUrl, token, input) {
  const prepared = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'prepareUpload',
    ...input,
  });
  if (prepared?.upload?.id && prepared.upload.key) {
    uploadKeysById.set(prepared.upload.id, prepared.upload.key);
  }
  return prepared;
}

async function listFiles(baseUrl, token, input) {
  const result = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'list',
    ...input,
  });
  return result?.uploads ?? [];
}

async function deleteUpload(baseUrl, token, uploadId) {
  const result = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'delete',
    uploadId,
    key: uploadKeysById.get(uploadId),
  });
  assert(result?.upload?.status === 'deleted', `upload ${uploadId} must be marked deleted`);
  return result.upload;
}

async function uploadPreparedFile(baseUrl, token, prepared, bytes, contentType) {
  const upload = prepared?.upload;
  assert(upload?.id && upload?.key, 'prepared upload must include an id and key');
  assert(prepared.uploadUrl, 'prepareUpload must return a signed upload URL');

  const metadata = {
    uploadId: upload.id,
    workspaceId: upload.workspaceId,
    pageId: upload.pageId ?? '',
    blockId: upload.blockId ?? '',
    originalName: upload.name ?? 'file-smoke.txt',
  };

  if (bytes.byteLength > MULTIPART_UPLOAD_THRESHOLD_BYTES) {
    await uploadPreparedMultipartFile(prepared.uploadUrl, upload.key, bytes, contentType, metadata);
  } else {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType }), upload.key);
    form.append('key', upload.key);
    form.append('customMetadata', JSON.stringify(metadata));

    const uploadResponse = await fetchWithTimeout(prepared.uploadUrl, {
      method: 'POST',
      body: form,
    });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      throw new Error(`signed file upload returned HTTP ${uploadResponse.status}: ${text.slice(0, 200)}`);
    }
  }

  const completed = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'completeUpload',
    id: upload.id,
    key: upload.key,
    url: storageUrl(baseUrl, upload.bucket || 'files', upload.key),
  });
  return completed?.upload;
}

async function uploadPreparedMultipartFile(uploadUrl, key, bytes, contentType, metadata) {
  let uploadId = '';
  try {
    const created = await postMultipartJson(uploadUrl, 'create', key, {
      key,
      contentType,
      customMetadata: metadata,
    });
    uploadId = created?.uploadId;
    assert(uploadId, 'signed multipart create must return an upload id');
    const parts = [];
    for (let start = 0, partNumber = 1; start < bytes.byteLength; partNumber += 1) {
      const end = Math.min(start + MULTIPART_PART_SIZE_BYTES, bytes.byteLength);
      const partUrl = new URL(signedMultipartEndpoint(uploadUrl, 'upload-part', key));
      partUrl.searchParams.set('uploadId', uploadId);
      partUrl.searchParams.set('partNumber', String(partNumber));
      const response = await fetchWithTimeout(partUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body: new Blob([bytes.subarray(start, end)], { type: contentType }),
      });
      const part = await readMultipartJson(response, `signed multipart part ${partNumber}`);
      assert(part?.partNumber === partNumber && typeof part?.etag === 'string', 'signed multipart part must return part metadata');
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      start = end;
    }
    await postMultipartJson(uploadUrl, 'complete', key, {
      uploadId,
      key,
      parts,
    });
  } catch (error) {
    if (uploadId) {
      await postMultipartJson(uploadUrl, 'abort', key, { uploadId, key }).catch(() => {});
    }
    throw error;
  }
}

function signedMultipartEndpoint(uploadUrl, action, key) {
  const url = new URL(uploadUrl);
  const token = url.searchParams.get('token');
  const signedKey = url.searchParams.get('key');
  assert(token, 'signed multipart upload requires an upload token');
  assert(!signedKey || signedKey === key, 'signed multipart upload key must match prepared key');
  assert(url.pathname.endsWith('/upload'), 'signed upload URL must end with /upload');
  url.pathname = url.pathname.replace(/\/upload$/, `/multipart/${action}`);
  url.search = '';
  url.searchParams.set('token', token);
  url.searchParams.set('key', key);
  return url.toString();
}

async function postMultipartJson(uploadUrl, action, key, body) {
  const response = await fetchWithTimeout(signedMultipartEndpoint(uploadUrl, action, key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readMultipartJson(response, `signed multipart ${action}`);
}

async function readMultipartJson(response, label) {
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

async function assertSignedDownloadSupportsRange(url, bytes, label) {
  assert(bytes.byteLength >= 12, `${label} fixture must be large enough for a range probe`);
  const start = 4;
  const end = 11;
  const expectedLength = end - start + 1;
  const partial = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/octet-stream',
      Range: `bytes=${start}-${end}`,
    },
  });
  const body = new Uint8Array(await partial.arrayBuffer());
  assert(partial.status === 206, `${label} range request must return HTTP 206, got ${partial.status}`);
  assert(partial.headers.get('accept-ranges') === 'bytes', `${label} must advertise byte ranges`);
  assert(
    /^private,\s*max-age=\d+$/i.test(partial.headers.get('cache-control') ?? ''),
    `${label} signed range response must allow private browser caching until the signed URL expires`,
  );
  assert(
    partial.headers.get('content-range') === `bytes ${start}-${end}/${bytes.byteLength}`,
    `${label} must return the requested Content-Range header`,
  );
  assert(
    partial.headers.get('content-length') === String(expectedLength),
    `${label} must return the ranged Content-Length header`,
  );
  assert(body.byteLength === expectedLength, `${label} ranged body length must match the requested bytes`);
  for (let i = 0; i < expectedLength; i += 1) {
    assert(body[i] === bytes[start + i], `${label} ranged body byte ${i} must match the stored file`);
  }

  const unsatisfiable = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/octet-stream',
      Range: `bytes=${bytes.byteLength}-`,
    },
  });
  await unsatisfiable.arrayBuffer();
  assert(unsatisfiable.status === 416, `${label} out-of-range request must return HTTP 416`);
  assert(
    unsatisfiable.headers.get('content-range') === `bytes */${bytes.byteLength}`,
    `${label} out-of-range response must include Content-Range size`,
  );
}

function assertSignedDownloadCarriesFileMetadata(url, size, contentType, label) {
  const token = new URL(url).searchParams.get('token') ?? '';
  const [version, payload] = token.split('.', 3);
  assert(version === 'v2' && payload, `${label} token must carry signed file metadata`);
  const json = JSON.parse(Buffer.from(toBase64(payload), 'base64').toString('utf8'));
  assert(json?.file?.size === size, `${label} token must include the file size for range seeks`);
  assert(json?.file?.contentType === contentType, `${label} token must include the file content type`);
  assert(!('customMetadata' in (json?.file ?? {})), `${label} token must not expose custom storage metadata`);
  assert(!('uploadedBy' in (json?.file ?? {})), `${label} token must not expose uploader identity metadata`);
}

function toBase64(base64Url) {
  return `${base64Url.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - base64Url.length % 4) % 4)}`;
}

function storageUrl(baseUrl, bucket, key) {
  return `${baseUrl}/api/storage/${encodeURIComponent(bucket)}/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  if (organizationId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'updateOrganizationSettings',
      organizationId,
      storageLimitBytes: null,
      sharingPolicy: { fileDownloads: true },
    }).catch(() => {});
  }

  if (permissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId,
    }).catch(() => {});
    permissionId = '';
  }

  for (const uploadId of [...uploadIds].reverse()) {
    await callFunction(baseUrl, owner.token, 'file-mutation', {
      action: 'delete',
      uploadId,
    }).catch(() => {});
    removeUploadId(uploadId);
  }

  if (pageId) {
    await callFunction(baseUrl, owner.token, 'page-mutation', {
      action: 'delete',
      id: pageId,
    }).catch(() => {});
    pageId = '';
    blockId = '';
    videoBlockId = '';
  }
}

function removeUploadId(uploadId) {
  const index = uploadIds.indexOf(uploadId);
  if (index >= 0) uploadIds.splice(index, 1);
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/file-smoke.mjs [options]

Checks multi-user file upload grant permissions, listings, reports, deletion,
and cleanup dry-run against a running Notionlike EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(
    response.status === 201 || response.ok,
    `anonymous sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`,
  );
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectFunctionStatus(baseUrl, token, name, body, status) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function postFunction(baseUrl, token, name, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}: ${text.slice(0, 200)}`);
  }
}

async function fetchWithTimeout(url, init) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
