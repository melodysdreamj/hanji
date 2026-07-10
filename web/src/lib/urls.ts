export function safeStoredFileUrl(value: string | undefined, dataPrefixes: string[] = []) {
  const url = value?.trim() ?? "";
  if (!url) return "";
  if (/^(https?:\/\/|\/|blob:)/i.test(url)) return url;
  const lower = url.toLowerCase();
  if (dataPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return url;
  return "";
}
