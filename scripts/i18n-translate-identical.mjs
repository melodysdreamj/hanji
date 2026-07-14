import fs from 'node:fs/promises';
import path from 'node:path';

const locales = ['ro', 'si', 'sk', 'sl', 'sr'];
const root = path.resolve('web/src/locales');
const files = (await fs.readdir(path.join(root, 'en'))).filter((f) => f.endsWith('.json') && f !== '_meta.json');
const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' && v !== null ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
const unflat = (entries) => { const out = {}; for (const [key, value] of entries) { const parts = key.split('.'); let cur = out; for (const p of parts.slice(0, -1)) cur = cur[p] ??= {}; cur[parts.at(-1)] = value; } return out; };
const en = new Map();
for (const file of files) for (const [k, v] of flat(JSON.parse(await fs.readFile(path.join(root, 'en', file), 'utf8')))) en.set(`${file}:${k}`, v);
const tokenPattern = /\{\{[^}]+\}\}|<[^>]+>/g;
const protect = (s) => { const tokens = s.match(tokenPattern) ?? []; let i = 0; return { text: s.replace(tokenPattern, () => `___HANJI_TOKEN_${i++}___`), tokens }; };
const restore = (s, tokens) => tokens.reduce((x, t, i) => x.replaceAll(`___HANJI_TOKEN_${i}___`, t), s);
const translate = async (text, lang) => { const { text: safe, tokens } = protect(text); const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${lang}&dt=t&q=${encodeURIComponent(safe)}`; for (let attempt = 0; attempt < 4; attempt++) { try { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); const j = await r.json(); return restore(j[0].map((x) => x[0]).join(''), tokens); } catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); } } };
for (const locale of locales) {
  const all = new Map();
  for (const file of files) for (const [k, v] of flat(JSON.parse(await fs.readFile(path.join(root, locale, file), 'utf8')))) all.set(`${file}:${k}`, v);
  const jobs = [...en].filter(([k, v]) => typeof v === 'string' && all.get(k) === v);
  let done = 0;
  for (let i = 0; i < jobs.length; i += 100) {
    const batch = jobs.slice(i, i + 100);
    const results = await Promise.all(batch.map(async ([k, v]) => [k, await translate(v, locale)]));
    for (const [k, v] of results) all.set(k, v);
    done += batch.length;
    if (done % 100 === 0 || done === jobs.length) console.log(`${locale}: ${done}/${jobs.length}`);
  }
  for (const file of files) {
    const entries = [...all].filter(([k]) => k.startsWith(`${file}:`)).map(([k, v]) => [k.slice(file.length + 1), v]);
    await fs.writeFile(path.join(root, locale, file), `${JSON.stringify(unflat(entries), null, 2)}\n`);
  }
}
