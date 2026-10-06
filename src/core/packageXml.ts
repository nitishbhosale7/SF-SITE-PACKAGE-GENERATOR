const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Profiles are never emitted: the guest user profile travels with the site bundle. */
const NEVER_EMIT = new Set(['Profile']);

export function buildPackageXml(members: { type: string; name: string }[], apiVersion: string): string {
  const byType = new Map<string, Set<string>>();
  for (const m of members) {
    if (NEVER_EMIT.has(m.type)) continue;
    if (!byType.has(m.type)) byType.set(m.type, new Set());
    byType.get(m.type)!.add(m.name);
  }
  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push('\t<types>');
    for (const name of [...byType.get(type)!].sort((a, b) => a.localeCompare(b))) {
      lines.push(`\t\t<members>${escapeXml(name)}</members>`);
    }
    lines.push(`\t\t<name>${type}</name>`, '\t</types>');
  }
  lines.push(`\t<version>${apiVersion}</version>`, '</Package>', '');
  return lines.join('\n');
}

export function manifestFileName(siteName: string): string {
  return `package-${siteName.replace(/[^A-Za-z0-9_-]+/g, '_')}.xml`;
}
