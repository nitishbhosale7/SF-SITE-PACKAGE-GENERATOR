#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Inventory } from './core/inventory';
import { buildPackageXml, manifestFileName } from './core/packageXml';
import { Resolver, listSites } from './core/resolver';
import { Sf } from './core/sf';

// Usage (from inside an SFDX project):
//   sf-site-package --list
//   sf-site-package --deps LightningComponentBundle:myComponent
//   sf-site-package "<site name>" [--out manifest/package-site.xml] [--target-org alias] [--why] [--include-covered]
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const targetOrg = flag('--target-org');
  const out = flag('--out');
  const why = args.includes('--why');
  // Also tick what the site bundle already covers (Network, Audience, trusted sites).
  const includeCovered = args.includes('--include-covered');
  const list = args.includes('--list');
  const siteName = args.find((a) => !a.startsWith('--'));

  const sf = new Sf(process.cwd(), 'sf', targetOrg);

  // --deps Type:Name[,Type:Name] lists what the given components depend on, without picking a site.
  const deps = flag('--deps');
  if (deps) {
    const seeds = deps.split(',').map((d) => ({ type: d.slice(0, d.indexOf(':')), name: d.slice(d.indexOf(':') + 1) }));
    const { items, warnings } = await new Resolver(sf, new Inventory(sf), (m, stage) => console.error(`  [${stage}] ${m}`)).dependenciesOf(seeds);
    for (const item of items) console.log(`${item.checked ? '[x]' : '[ ]'} ${item.type}: ${item.name}  (${item.reasons[0]})`);
    for (const w of warnings) console.error(`Warning: ${w}`);
    return;
  }
  const sites = await listSites(sf);
  if (list || !siteName) {
    for (const s of sites) console.log(`${s.name}\t/${s.urlPathPrefix}\t${s.status}`);
    return;
  }
  const site = sites.find((s) => s.name.toLowerCase() === siteName.toLowerCase());
  if (!site) throw new Error(`No site named "${siteName}". Run with --list to see the sites in the org.`);

  const resolver = new Resolver(sf, new Inventory(sf), (m, stage) => console.error(`  [${stage}] ${m}`), { includeCovered });
  const result = await resolver.resolve(site);

  if (why) {
    for (const item of result.items) {
      console.error(`${item.checked ? '[x]' : '[ ]'} ${item.type}: ${item.name}\n      ${item.reasons[0]}`);
    }
  }
  for (const e of result.excluded) console.error(`Excluded: ${e}`);
  for (const w of result.warnings) console.error(`Warning: ${w}`);

  const xml = buildPackageXml(result.items.filter((i) => i.checked), result.apiVersion);
  const file = path.resolve(out ?? path.join('manifest', manifestFileName(site.name)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, xml);
  console.error(`Wrote ${file} (${result.items.filter((i) => i.checked).length} components)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
