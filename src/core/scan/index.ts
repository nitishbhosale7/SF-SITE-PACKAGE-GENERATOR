import * as fs from 'fs';
import * as path from 'path';
import { Lookup, Ref } from '../types';
import { scanApex, scanFlow, scanNamedCredential, scanVisualforce } from './apex';
import { scanBundleJson } from './bundle';
import { SourceFile, scanAura, scanLwc } from './lwc';
import { scanCustomSite, scanNetwork } from './network';

export interface Scanned {
  from: { type: string; name: string };
  refs: Ref[];
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(full, base, out);
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * In an org with its own namespace, Salesforce writes that namespace where an org without one
 * writes `c` (`myns:header`, `myns.MyClass`). Rewrite those to the plain form the scanners expect.
 */
export function withoutOwnNamespace(text: string, namespace: string | undefined): string {
  if (!namespace) return text;
  const ns = namespace.replace(/[^\w]/g, '');
  return text
    .replace(new RegExp(`\\b${ns}:(?=\\w)`, 'gi'), 'c:')
    .replace(new RegExp(`(@salesforce/label/|\\$Label\\.)${ns}\\.`, 'gi'), '$1c.')
    .replace(new RegExp(`\\b${ns}\\.(?=[A-Za-z_])`, 'gi'), '');
}

const stripMeta = (file: string, ext: string) => file.replace(new RegExp(`\\.${ext}(-meta\\.xml)?$`), '');

/**
 * Scan a retrieved metadata directory (metadata or source format) and return, per component
 * found there, the components it references.
 */
export function scanDirectory(root: string, lk: Lookup): Scanned[] {
  const read = (rel: string) => withoutOwnNamespace(fs.readFileSync(path.join(root, rel), 'utf8'), lk.ownNamespace);
  const bundles = new Map<string, { type: string; name: string; files: SourceFile[] }>();
  const results: Scanned[] = [];

  const bundleFile = (type: string, name: string, rel: string) => {
    const key = `${type}:${name}`;
    if (!bundles.has(key)) bundles.set(key, { type, name, files: [] });
    bundles.get(key)!.files.push({ path: rel, text: read(rel) });
  };

  for (const rel of walk(root)) {
    let m: RegExpExecArray | null;
    if ((m = /(?:^|\/)lwc\/([^/]+)\/.+\.(?:js|ts|html|css)$/.exec(rel))) {
      bundleFile('LightningComponentBundle', m[1], rel);
    } else if ((m = /(?:^|\/)aura\/([^/]+)\/.+\.(?:cmp|app|evt|intf|design|js)$/.exec(rel))) {
      bundleFile('AuraDefinitionBundle', m[1], rel);
    } else if ((m = /(?:^|\/)digitalExperiences\/site\/([^/]+)\/.+\.json$/.exec(rel))) {
      bundleFile('DigitalExperienceBundle', `site/${m[1]}`, rel);
    } else if ((m = /(?:^|\/)experiences\/([^/]+)\/.+\.json$/.exec(rel))) {
      bundleFile('ExperienceBundle', m[1], rel);
    } else if ((m = /(?:^|\/)classes\/([^/]+\.cls)$/.exec(rel))) {
      const name = stripMeta(m[1], 'cls');
      results.push({ from: { type: 'ApexClass', name }, refs: scanApex(read(rel), name, lk) });
    } else if ((m = /(?:^|\/)triggers\/([^/]+\.trigger)$/.exec(rel))) {
      const name = stripMeta(m[1], 'trigger');
      results.push({ from: { type: 'ApexTrigger', name }, refs: scanApex(read(rel), name, lk) });
    } else if ((m = /(?:^|\/)pages\/([^/]+\.page)$/.exec(rel))) {
      results.push({ from: { type: 'ApexPage', name: stripMeta(m[1], 'page') }, refs: scanVisualforce(read(rel), lk) });
    } else if ((m = /(?:^|\/)components\/([^/]+\.component)$/.exec(rel))) {
      results.push({ from: { type: 'ApexComponent', name: stripMeta(m[1], 'component') }, refs: scanVisualforce(read(rel), lk) });
    } else if ((m = /(?:^|\/)flows\/([^/]+\.flow(?:-meta\.xml)?)$/.exec(rel))) {
      results.push({ from: { type: 'Flow', name: stripMeta(m[1], 'flow') }, refs: scanFlow(read(rel), lk) });
    } else if ((m = /(?:^|\/)namedCredentials\/([^/]+\.namedCredential(?:-meta\.xml)?)$/.exec(rel))) {
      results.push({ from: { type: 'NamedCredential', name: stripMeta(m[1], 'namedCredential') }, refs: scanNamedCredential(read(rel), lk) });
    } else if ((m = /(?:^|\/)networks\/([^/]+\.network(?:-meta\.xml)?)$/.exec(rel))) {
      results.push({ from: { type: 'Network', name: safeDecode(stripMeta(m[1], 'network')) }, refs: scanNetwork(read(rel), lk) });
    } else if ((m = /(?:^|\/)sites\/([^/]+\.site(?:-meta\.xml)?)$/.exec(rel))) {
      results.push({ from: { type: 'CustomSite', name: stripMeta(m[1], 'site') }, refs: scanCustomSite(read(rel), lk) });
    }
  }

  for (const b of bundles.values()) {
    let refs: Ref[];
    if (b.type === 'LightningComponentBundle') refs = scanLwc(b.files, b.name, lk);
    else if (b.type === 'AuraDefinitionBundle') refs = scanAura(b.files, b.name, lk);
    else refs = b.files.flatMap((f) => scanBundleJson(f.text, lk));
    results.push({ from: { type: b.type, name: b.name }, refs });
  }
  return results;
}

/** Text of the first file under `root` whose relative path matches, e.g. the retrieved Network XML. */
export function readFirst(root: string, pattern: RegExp): string | undefined {
  const rel = walk(root).find((r) => pattern.test(r));
  return rel ? fs.readFileSync(path.join(root, rel), 'utf8') : undefined;
}
