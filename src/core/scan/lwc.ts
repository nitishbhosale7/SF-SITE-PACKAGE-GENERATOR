import { Lookup, Ref } from '../types';
import { Refs, addCustomObjects } from './refs';

export interface SourceFile {
  path: string;
  text: string;
}

const kebabToCamel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `c:name` can be either an LWC or an Aura component; the org index decides. */
export function addComponent(refs: Refs, name: string, why: string): void {
  if (!refs.add('LightningComponentBundle', name, why)) refs.add('AuraDefinitionBundle', name, why);
}

/** All files of one Lightning web component bundle. */
export function scanLwc(files: SourceFile[], self: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const f of files) {
    if (f.path.endsWith('.html')) {
      for (const m of f.text.matchAll(/<c-([a-z0-9-]+)/g)) {
        const name = kebabToCamel(m[1]);
        if (name.toLowerCase() !== self.toLowerCase()) addComponent(refs, name, 'child component in template');
      }
    } else if (f.path.endsWith('.css')) {
      for (const m of f.text.matchAll(/@import\s+['"]c\/(\w+)['"]/g)) addComponent(refs, m[1], 'shared stylesheet');
    } else if (/\.(js|ts)$/.test(f.path)) {
      for (const m of f.text.matchAll(/['"]c\/(\w+)['"]/g)) {
        if (m[1].toLowerCase() !== self.toLowerCase()) addComponent(refs, m[1], 'imported module');
      }
      for (const m of f.text.matchAll(/['"]@salesforce\/(\w+)\/([\w.]+)['"]/g)) scopedImport(refs, m[1], m[2]);
      addCustomObjects(refs, f.text, 'object named in component code');
    }
  }
  return refs.list;
}

function scopedImport(refs: Refs, scope: string, target: string): void {
  const parts = target.split('.');
  switch (scope) {
    case 'apex':
    case 'apexContinuation':
      // Class.method, or namespace.Class.method for managed code (skipped).
      if (parts.length <= 2) refs.add('ApexClass', parts[0], 'Apex method imported by component');
      break;
    case 'resourceUrl':
      refs.add('StaticResource', target, 'static resource imported by component');
      break;
    case 'contentAssetUrl':
      refs.add('ContentAsset', target, 'content asset imported by component');
      break;
    case 'label':
      if (parts[0] === 'c' && parts[1]) refs.add('CustomLabel', parts[1], 'custom label imported by component');
      break;
    case 'schema':
      addCustomObjects(refs, parts[0], 'object imported by component');
      break;
    case 'messageChannel':
      refs.add('LightningMessageChannel', target.replace(/__c$/, ''), 'message channel imported by component');
      break;
    case 'customPermission':
      refs.add('CustomPermission', target, 'custom permission imported by component');
      break;
  }
}

/** All files of one Aura component bundle. */
export function scanAura(files: SourceFile[], self: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const f of files) {
    if (/\.(cmp|app|evt|intf|design)$/.test(f.path)) {
      for (const m of f.text.matchAll(/\bcontroller\s*=\s*"(?:c\.)?(\w+)"/gi)) refs.add('ApexClass', m[1], 'Aura server controller');
      for (const m of f.text.matchAll(/<c:(\w+)/g)) {
        if (m[1].toLowerCase() !== self.toLowerCase()) addComponent(refs, m[1], 'child component in Aura markup');
      }
      for (const m of f.text.matchAll(/\b(?:extends|implements|type)\s*=\s*"c:(\w+)"/g)) addComponent(refs, m[1], 'Aura type reference');
    }
    for (const m of f.text.matchAll(/\$Resource\.(\w+)/g)) refs.add('StaticResource', m[1], 'static resource in Aura component');
    for (const m of f.text.matchAll(/\$Label\.c\.(\w+)/g)) refs.add('CustomLabel', m[1], 'custom label in Aura component');
    for (const m of f.text.matchAll(/\$ContentAsset\.(\w+)/g)) refs.add('ContentAsset', m[1], 'content asset in Aura component');
    addCustomObjects(refs, f.text, 'object named in Aura component');
  }
  return refs.list;
}
