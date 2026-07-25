export const MAX_EDGEBASE_CONFIG_BYTES = 1024 * 1024;

export function serializeEdgeBaseConfigModule(rawConfig) {
  if (rawConfig === undefined || rawConfig === '') return null;
  if (typeof rawConfig !== 'string') {
    throw new Error('EDGEBASE_CONFIG must be a string containing one JSON object.');
  }
  if (Buffer.byteLength(rawConfig, 'utf8') > MAX_EDGEBASE_CONFIG_BYTES) {
    throw new Error(
      `EDGEBASE_CONFIG must not exceed ${MAX_EDGEBASE_CONFIG_BYTES} UTF-8 bytes.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new Error('EDGEBASE_CONFIG must be valid JSON containing one object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'EDGEBASE_CONFIG must contain one JSON object; arrays, null, and scalar values are not supported.',
    );
  }

  return `const config = ${JSON.stringify(parsed)};\n\nexport default config;\n`;
}
