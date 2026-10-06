import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Inventory } from './inventory';
import { readFirst, scanDirectory } from './scan';
import { tagValue } from './scan/network';
import { Sf, pool, toArray } from './sf';
import { Item, Progress, ResolveResult, SiteSummary } from './types';

/**
 * Types the site bundle already covers, so a development manifest does not need them.
 * They are still found and shown, just left unticked.
 */
export const COVERED_BY_BUNDLE = ['CspTrustedSite', 'Audience', 'Network'];

/** Untick scanned items the site bundle already covers. */
export function applyDefaultTicks(items: Item[], covered: string[] = COVERED_BY_BUNDLE): Item[] {
  for (const item of items) {
    if (item.origin === 'scan' && covered.includes(item.type)) item.checked = false;
  }
  return items;
}

/** Code types whose dependencies can be followed when added by hand. */
export const FOLLOWABLE = ['LightningComponentBundle', 'AuraDefinitionBundle', 'ApexClass', 'ApexPage', 'ApexComponent', 'Flow'];

/** Types whose source is retrieved and scanned for further references. */
const SCANNABLE = new Set([
  'LightningComponentBundle', 'AuraDefinitionBundle', 'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent',
  'Flow', 'NamedCredential', 'Network', 'CustomSite', 'DigitalExperienceBundle', 'ExperienceBundle',
]);

const INDEXED_TYPES = [
  // site core
  'Network', 'CustomSite', 'DigitalExperienceBundle', 'DigitalExperienceConfig', 'ExperienceBundle', 'SiteDotCom',
  'NetworkBranding', 'NavigationMenu', 'ManagedContentType', 'Audience', 'ManagedTopics',
  'CspTrustedSite', 'CorsWhitelistOrigin',
  // code and its dependencies
  'LightningComponentBundle', 'AuraDefinitionBundle', 'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent',
  'StaticResource', 'CustomObject', 'CustomLabel', 'CustomMetadata', 'NamedCredential', 'ExternalCredential',
  'Flow', 'ContentAsset', 'LightningMessageChannel', 'CustomPermission', 'PermissionSet',
];

/** MetadataComponentDependency type names that map straight onto package.xml types. */
const DEPENDENCY_TYPES = new Set([
  'ApexClass', 'ApexPage', 'ApexComponent', 'StaticResource', 'CustomObject', 'CustomLabel',
  'LightningComponentBundle', 'AuraDefinitionBundle', 'Flow',
]);

const MAX_ROUNDS = 15;
const soqlString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export interface ResolveOptions {
  includeTestClasses?: boolean;
  /** Keep bundle-covered types ticked (the pre-0.3 behaviour). */
  includeCovered?: boolean;
}

export async function listSites(sf: Sf): Promise<SiteSummary[]> {
  const rows = await sf.query<any>('SELECT Id, Name, UrlPathPrefix, Status FROM Network ORDER BY Name');
  return rows.map((r) => ({ id: r.Id, name: r.Name, urlPathPrefix: r.UrlPathPrefix ?? '', status: r.Status ?? '' }));
}

export class Resolver {
  private readonly items = new Map<string, Item>();
  private pending: Item[] = [];
  private readonly scanned = new Set<string>();
  private round = 0;
  private readonly warnings: string[] = [];
  private readonly excluded: string[] = [];
  private apiVersion = '';
  private tmp = '';

  constructor(
    private readonly sf: Sf,
    private readonly inv: Inventory,
    private readonly progress: Progress = () => {},
    private readonly options: ResolveOptions = {},
  ) {}

  async resolve(site: SiteSummary): Promise<ResolveResult> {
    this.apiVersion = (await this.sf.orgDisplay()).apiVersion;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-site-pkg-'));
    try {
      await this.inv.preload(INDEXED_TYPES, (m) => this.progress(m, 'index'));
      if (this.inv.failed.length) this.warnings.push(`Could not list these metadata types (skipped): ${this.inv.failed.join(', ')}`);

      await this.siteCore(site);
      await this.closure();
      await this.dependencyApiCrossCheck();
      await this.closure();
    } finally {
      fs.rmSync(this.tmp, { recursive: true, force: true });
    }

    const items = this.sorted();
    if (!this.options.includeCovered) applyDefaultTicks(items);
    return { site, apiVersion: this.apiVersion, items, excluded: this.excluded, warnings: this.warnings };
  }

  /**
   * Everything the given hand-added components depend on (the seeds themselves are not returned).
   * Runs the same scan as a site, starting from these components instead of a site bundle.
   */
  async dependenciesOf(seeds: { type: string; name: string }[]): Promise<{ items: Item[]; warnings: string[] }> {
    this.apiVersion = (await this.sf.orgDisplay()).apiVersion;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-site-pkg-'));
    const seedKeys = new Set<string>();
    try {
      await this.inv.preload(INDEXED_TYPES, (m) => this.progress(m, 'index'));
      for (const seed of seeds) {
        const name = this.inv.find(seed.type, seed.name);
        if (!name) continue;
        seedKeys.add(`${seed.type}:${name}`);
        this.add(seed.type, name, 'added by hand');
      }
      await this.closure();
      await this.dependencyApiCrossCheck();
      await this.closure();
    } finally {
      fs.rmSync(this.tmp, { recursive: true, force: true });
    }
    const items = this.sorted().filter((i) => !seedKeys.has(`${i.type}:${i.name}`));
    return { items: applyDefaultTicks(items), warnings: this.warnings };
  }

  private sorted(): Item[] {
    return [...this.items.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- item bookkeeping

  private add(type: string, name: string, why: string, checked = true): void {
    if (type === 'Profile') return;
    const key = `${type}:${name}`;
    const existing = this.items.get(key);
    if (existing) {
      if (!existing.reasons.includes(why) && existing.reasons.length < 8) existing.reasons.push(why);
      if (checked && !existing.checked) {
        existing.checked = true;
        if (SCANNABLE.has(type)) this.pending.push(existing);
      }
      return;
    }
    const item: Item = { type, name, checked, reasons: [why], origin: 'scan' };
    this.items.set(key, item);
    // Unticked items are suggestions only, so their dependencies are not followed.
    if (checked && SCANNABLE.has(type)) this.pending.push(item);
    if (checked) this.onAdded(item);
  }

  private onAdded(item: Item): void {
    if (item.type === 'ApexClass' && this.options.includeTestClasses !== false) {
      const n = item.name;
      for (const candidate of [`${n}Test`, `${n}_Test`, `${n}Tests`, `Test${n}`, `Test_${n}`]) {
        const found = this.inv.find('ApexClass', candidate);
        if (found) this.add('ApexClass', found, `test class for ${n}`);
      }
    }
    if (item.type === 'CustomObject' && /__mdt$/i.test(item.name)) {
      const prefix = item.name.replace(/__mdt$/i, '').toLowerCase() + '.';
      for (const record of this.inv.names('CustomMetadata')) {
        if (record.toLowerCase().startsWith(prefix)) this.add('CustomMetadata', record, `record of ${item.name}`);
      }
    }
  }

  private addIfExists(type: string, name: string | undefined, why: string, checked = true): string | undefined {
    const found = name ? this.inv.find(type, name) : undefined;
    if (found) this.add(type, found, why, checked);
    return found;
  }

  // ---------------------------------------------------------------- stage 1: site core

  private async siteCore(site: SiteSummary): Promise<void> {
    this.progress('Reading the site record', 'core');
    const network = this.inv.find('Network', site.name);
    if (!network) throw new Error(`Network "${site.name}" was not found in the org's metadata.`);
    this.add('Network', network, 'the selected site');

    // The Network XML is the authoritative link to the CustomSite and the Experience Builder site.
    const dir = path.join(this.tmp, 'network');
    this.warnings.push(...(await this.sf.retrieve([{ type: 'Network', name: network }], dir, this.apiVersion)));
    const xml = readFirst(dir, /networks\/.+\.network/) ?? '';
    const customSite = tagValue(xml, 'site');
    const builderSite = tagValue(xml, 'picassoSite');

    this.addIfExists('CustomSite', customSite, 'site record of the network');
    this.addIfExists('ManagedTopics', network, 'topics of the site');
    if (customSite) this.addIfExists('NetworkBranding', `cb${customSite}`, 'login page branding of the site');

    if (builderSite) {
      const hasConfig = this.addIfExists('DigitalExperienceConfig', builderSite, 'Experience Builder site configuration');
      const hasBundle = this.addIfExists('DigitalExperienceBundle', `site/${builderSite}`, 'Experience Builder site (pages, theme, routes)');
      if (!hasBundle) {
        const hasExperienceBundle = this.addIfExists('ExperienceBundle', builderSite, 'Experience Builder site (Aura template)');
        if (!hasExperienceBundle && !hasConfig) this.addIfExists('SiteDotCom', builderSite, 'Experience Builder site (legacy format)');
      }
    } else {
      this.warnings.push('The network has no Experience Builder site; only Visualforce/site settings were followed.');
    }

    await Promise.all([
      this.byNetworkId('NavigationMenu', `SELECT Id FROM NavigationLinkSet WHERE NetworkId = ${soqlString(site.id)}`, 'navigation menu of the site'),
      this.byNetworkId('Audience', `SELECT Id FROM Audience WHERE ContainerId = ${soqlString(site.id)}`, 'audience defined on the site'),
      this.guestProfile(customSite),
      this.cms(site),
    ]);
  }

  private async byNetworkId(type: string, soql: string, why: string): Promise<void> {
    try {
      for (const row of await this.sf.query<any>(soql)) {
        const name = this.inv.byId(type, row.Id);
        if (name) this.add(type, name, why);
      }
    } catch (e: any) {
      this.warnings.push(`Could not look up ${type} for the site: ${e.message}`);
    }
  }

  private async guestProfile(customSite: string | undefined): Promise<void> {
    if (!customSite) return;
    try {
      const rows = await this.sf.query<any>(`SELECT GuestUser.Profile.Name FROM Site WHERE Name = ${soqlString(customSite)}`);
      const name = rows[0]?.GuestUser?.Profile?.Name;
      this.excluded.push(name ? `Profile "${name}" (guest user profile)` : 'Guest user profile');
    } catch {
      this.excluded.push('Guest user profile');
    }
  }

  /** CMS workspaces that publish to this site's channel, and the content types they use. */
  private async cms(site: SiteSummary): Promise<void> {
    try {
      const spaces = toArray<any>((await this.sf.rest('/connect/cms/spaces?pageSize=250', this.apiVersion)).spaces);
      const usedTypes = new Set<string>();
      await pool(spaces, 4, async (space) => {
        const res = await this.sf.rest(`/connect/cms/spaces/${space.id}/channels?pageSize=250`, this.apiVersion);
        const linked = toArray<any>(res.spaceChannels).some((c) => c.channelSummary?.name === site.name);
        if (!linked) return;
        const label = space.name ?? space.apiName;
        if (!this.addIfExists('DigitalExperienceBundle', `content/${space.apiName}`, `CMS workspace "${label}" publishes to the site`)) {
          this.warnings.push(`CMS workspace "${label}" is linked to the site but is not retrievable as metadata (not an enhanced workspace).`);
        }
        const rows = await this.sf.query<any>(
          `SELECT ContentTypeFullyQualifiedName FROM ManagedContent WHERE AuthoredManagedContentSpaceId = ${soqlString(space.id)} GROUP BY ContentTypeFullyQualifiedName`,
        );
        for (const r of rows) usedTypes.add(r.ContentTypeFullyQualifiedName);
      });
      // Custom content types come back as record Ids, standard ones (sfdc_cms__*) by name.
      for (const t of usedTypes) {
        const name = this.inv.byId('ManagedContentType', t) ?? this.inv.find('ManagedContentType', t);
        if (name) this.add('ManagedContentType', name, 'content type used by the site CMS workspace');
      }
    } catch (e: any) {
      this.warnings.push(`Could not resolve CMS workspaces for the site: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- stages 2-3: closure

  private async closure(): Promise<void> {
    for (let round = 1; round <= MAX_ROUNDS && this.pending.length; round++) {
      const batch = this.pending.filter((i) => !this.scanned.has(`${i.type}:${i.name}`));
      this.pending = [];
      if (!batch.length) break;
      batch.forEach((i) => this.scanned.add(`${i.type}:${i.name}`));

      this.round++;
      this.progress(`Round ${this.round} · ${batch.length} component${batch.length === 1 ? '' : 's'}`, 'follow');
      const dir = path.join(this.tmp, `closure-${Date.now()}-${round}`);
      this.warnings.push(...(await this.sf.retrieve(batch, dir, this.apiVersion)));

      for (const result of scanDirectory(dir, this.inv)) {
        for (const ref of result.refs) {
          this.add(ref.type, ref.name, `${ref.why} — ${result.from.type} ${result.from.name}`, ref.checked ?? true);
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Ask the Tooling dependency API about the code we found, to catch what regex scanning missed. */
  private async dependencyApiCrossCheck(): Promise<void> {
    const ids: string[] = [];
    for (const item of this.items.values()) {
      if (!item.checked || !['LightningComponentBundle', 'AuraDefinitionBundle', 'ApexClass', 'ApexPage'].includes(item.type)) continue;
      const id = this.inv.idOf(item.type, item.name);
      if (id) ids.push(id);
    }
    if (!ids.length) return;
    this.progress(`${ids.length} components`, 'check');
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
    try {
      await pool(chunks, 3, async (chunk) => {
        const rows = await this.sf.query<any>(
          'SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType ' +
            `FROM MetadataComponentDependency WHERE MetadataComponentId IN (${chunk.map(soqlString).join(',')})`,
          true,
        );
        for (const r of rows) {
          if (!DEPENDENCY_TYPES.has(r.RefMetadataComponentType)) continue;
          const name = this.inv.find(r.RefMetadataComponentType, r.RefMetadataComponentName);
          if (name) this.add(r.RefMetadataComponentType, name, `dependency reported by Salesforce — ${r.MetadataComponentType} ${r.MetadataComponentName}`);
        }
      });
    } catch (e: any) {
      this.warnings.push(`Dependency API cross-check skipped: ${e.message}`);
    }
  }
}
