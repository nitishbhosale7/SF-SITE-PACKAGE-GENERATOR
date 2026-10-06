import { Lookup, Ref } from '../types';
import { Refs, addCustomObjects } from './refs';

/** Apex class or trigger source → classes, objects, labels, flows and named credentials it uses. */
export function scanApex(src: string, self: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  const strings: string[] = [];
  // One pass so that `//` inside a string literal is not mistaken for a comment.
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'/g, (m) => {
    if (m[0] !== "'") return ' ';
    strings.push(m.slice(1, -1));
    return "''";
  });

  // Identifiers not reached through member access (`foo.Bar` is a member, `Bar.foo` is a type).
  const identifiers = new Set<string>();
  for (const m of code.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)) identifiers.add(m[0]);
  for (const id of identifiers) {
    if (id !== self) refs.addExact('ApexClass', id, 'referenced in Apex');
  }

  for (const m of code.matchAll(/\bLabel\.(\w+)/gi)) refs.add('CustomLabel', m[1], 'custom label used in Apex');
  for (const m of code.matchAll(/\bFlow\.Interview\.(\w+)/gi)) refs.add('Flow', m[1], 'flow started from Apex');
  for (const m of code.matchAll(/\bPage\.(\w+)/g)) refs.add('ApexPage', m[1], 'page referenced in Apex');
  addCustomObjects(refs, code, 'used in Apex');

  for (const s of strings) {
    for (const m of s.matchAll(/callout:([A-Za-z0-9_]+)/g)) refs.add('NamedCredential', m[1], 'callout endpoint in Apex');
    addCustomObjects(refs, s, 'named in an Apex string (dynamic SOQL or describe)');
    // Type.forName('Foo') and similar dynamic class loading.
    if (/^[A-Za-z_]\w*$/.test(s) && s !== self) refs.addExact('ApexClass', s, 'class name in an Apex string');
  }
  return refs.list;
}

/** Visualforce page or component markup. */
export function scanVisualforce(src: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const m of src.matchAll(/\bcontroller\s*=\s*"([\w.]+)"/gi)) refs.add('ApexClass', m[1], 'Visualforce controller');
  for (const m of src.matchAll(/\bextensions\s*=\s*"([^"]+)"/gi)) {
    for (const name of m[1].split(',')) refs.add('ApexClass', name.trim(), 'Visualforce controller extension');
  }
  for (const m of src.matchAll(/<c:(\w+)/g)) refs.add('ApexComponent', m[1], 'Visualforce component');
  for (const m of src.matchAll(/\$Resource\.(\w+)/g)) refs.add('StaticResource', m[1], 'static resource in Visualforce');
  for (const m of src.matchAll(/\$Label\.(\w+)/g)) refs.add('CustomLabel', m[1], 'custom label in Visualforce');
  for (const m of src.matchAll(/\$Page\.(\w+)/g)) refs.add('ApexPage', m[1], 'page linked from Visualforce');
  addCustomObjects(refs, src, 'used in Visualforce');
  return refs.list;
}

/** Flow definition XML. */
export function scanFlow(xml: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const block of xml.matchAll(/<actionCalls>[\s\S]*?<\/actionCalls>/g)) {
    if (!/<actionType>apex<\/actionType>/.test(block[0])) continue;
    const name = /<actionName>([^<]+)<\/actionName>/.exec(block[0]);
    if (name) refs.add('ApexClass', name[1], 'invocable Apex action in flow');
  }
  for (const m of xml.matchAll(/<apexClass>([^<]+)<\/apexClass>/g)) refs.add('ApexClass', m[1], 'Apex type in flow');
  for (const m of xml.matchAll(/<flowName>([^<]+)<\/flowName>/g)) refs.add('Flow', m[1], 'subflow');
  for (const m of xml.matchAll(/<(?:object|objectType)>([^<]+)<\/(?:object|objectType)>/g)) {
    addCustomObjects(refs, m[1], 'object used in flow');
  }
  return refs.list;
}

/** Named credential XML → the external credential it authenticates with. */
export function scanNamedCredential(xml: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const m of xml.matchAll(/<externalCredential>([^<]+)<\/externalCredential>/g)) {
    refs.add('ExternalCredential', m[1], 'external credential of the named credential');
  }
  return refs.list;
}
