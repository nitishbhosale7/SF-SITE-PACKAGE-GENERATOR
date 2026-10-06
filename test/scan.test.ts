import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Inventory } from '../src/core/inventory';
import { buildPackageXml, manifestFileName } from '../src/core/packageXml';
import { COVERED_BY_BUNDLE, applyDefaultTicks } from '../src/core/resolver';
import { scanDirectory, withoutOwnNamespace } from '../src/core/scan';
import { scanApex, scanFlow, scanNamedCredential, scanVisualforce } from '../src/core/scan/apex';
import { scanBundleJson } from '../src/core/scan/bundle';
import { scanAura, scanLwc } from '../src/core/scan/lwc';
import { scanCustomSite, scanNetwork, tagValue } from '../src/core/scan/network';
import { Limiter } from '../src/core/sf';
import { Item, Ref } from '../src/core/types';

function inventory(): Inventory {
  const inv = new Inventory(undefined as any);
  const seed = (type: string, ...names: string[]) => inv.set(type, names.map((fullName) => ({ fullName })));
  seed('LightningComponentBundle', 'siteHeader', 'siteHeaderDropdown', 'siteHCPForm', 'sharedStyles', 'siteUtils');
  seed('AuraDefinitionBundle', 'legacyFooter');
  seed('ApexClass', 'SiteController', 'MapsService', 'MapsWrapper', 'Utils', 'DynamicHandler');
  inv.set('ApexClass', [
    ...['SiteController', 'MapsService', 'MapsWrapper', 'Utils', 'DynamicHandler'].map((fullName) => ({ fullName })),
    { fullName: 'ManagedThing', namespacePrefix: 'pkg' },
  ]);
  seed('ApexPage', 'CommunitiesLanding', 'CustomError', 'Receipt');
  seed('ApexComponent', 'SiteFooter');
  seed('StaticResource', 'SiteAssets', 'SiteLWRAssets', 'SNA_page');
  seed('CustomObject', 'Access_Contact__c', 'Site_Config__mdt', 'Api_Settings__c', 'Account');
  seed('CustomLabel', 'Site_Title', 'Error_Message');
  seed('NamedCredential', 'mapsApi');
  seed('ExternalCredential', 'mapsAuth');
  seed('Flow', 'Site_Signup', 'Send_Confirmation');
  seed('CspTrustedSite', 'GoogleAnalytics');
  seed('PermissionSet', 'Site_Member');
  seed('LightningMessageChannel', 'SiteEvents');
  seed('CustomPermission', 'Can_Submit');
  seed('ContentAsset', 'logo');
  return inv;
}

const keys = (refs: Ref[]) => refs.map((r) => `${r.type}:${r.name}`).sort();

test('LWC: template children, imports and scoped modules', () => {
  const refs = scanLwc(
    [
      { path: 'lwc/siteHeader/siteHeader.html', text: '<template><c-site-header-dropdown></c-site-header-dropdown><c-site-h-c-p-form></c-site-h-c-p-form><c-unknown-thing></c-unknown-thing></template>' },
      { path: 'lwc/siteHeader/siteHeader.css', text: "@import 'c/sharedStyles';" },
      {
        path: 'lwc/siteHeader/siteHeader.js',
        text: `
          import { helper } from 'c/siteUtils';
          import getData from '@salesforce/apex/SiteController.getData';
          import managed from '@salesforce/apex/pkg.ManagedThing.run';
          import ASSETS from '@salesforce/resourceUrl/SiteAssets';
          import TITLE from "@salesforce/label/c.Site_Title";
          import OBJ from '@salesforce/schema/Access_Contact__c';
          import FIELD from '@salesforce/schema/Account.Name';
          import CH from '@salesforce/messageChannel/SiteEvents__c';
          import PERM from '@salesforce/customPermission/Can_Submit';
          import LOGO from '@salesforce/contentAssetUrl/logo';
          import basePath from '@salesforce/community/basePath';
        `,
      },
    ],
    'siteHeader',
    inventory(),
  );
  assert.deepEqual(keys(refs), [
    'ApexClass:SiteController',
    'ContentAsset:logo',
    'CustomLabel:Site_Title',
    'CustomObject:Access_Contact__c',
    'CustomPermission:Can_Submit',
    'LightningComponentBundle:sharedStyles',
    'LightningComponentBundle:siteHCPForm',
    'LightningComponentBundle:siteHeaderDropdown',
    'LightningComponentBundle:siteUtils',
    'LightningMessageChannel:SiteEvents',
    'StaticResource:SiteAssets',
  ]);
});

test('Aura: controller, child components and global value providers', () => {
  const refs = scanAura(
    [{ path: 'aura/legacyFooter/legacyFooter.cmp', text: '<aura:component controller="SiteController"><c:siteHeader/><img src="{!$Resource.SiteAssets + \'/a.png\'}"/>{!$Label.c.Site_Title}</aura:component>' }],
    'legacyFooter',
    inventory(),
  );
  assert.deepEqual(keys(refs), ['ApexClass:SiteController', 'CustomLabel:Site_Title', 'LightningComponentBundle:siteHeader', 'StaticResource:SiteAssets']);
});

test('Apex: classes, callouts, objects, labels and flows; comments and member access ignored', () => {
  const src = `
    // Utils is mentioned only in a comment
    /* DynamicHandler too */
    public with sharing class SiteController {
      public static void run() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:mapsApi/v1/places?x=https://example.com//path');
        MapsWrapper w = MapsService.parse(req);
        Access_Contact__c c = new Access_Contact__c(First_Name__c = 'a');
        Site_Config__mdt cfg = Site_Config__mdt.getInstance('Default');
        Api_Settings__c s = Api_Settings__c.getOrgDefaults();
        String msg = System.Label.Error_Message + cfg.utils.Utils;
        Flow.Interview.Send_Confirmation f = new Flow.Interview.Send_Confirmation(new Map<String, Object>());
        Type t = Type.forName('DynamicHandler');
      }
    }`;
  assert.deepEqual(keys(scanApex(src, 'SiteController', inventory())), [
    'ApexClass:DynamicHandler',
    'ApexClass:MapsService',
    'ApexClass:MapsWrapper',
    'CustomLabel:Error_Message',
    'CustomObject:Access_Contact__c',
    'CustomObject:Api_Settings__c',
    'CustomObject:Site_Config__mdt',
    'Flow:Send_Confirmation',
    'NamedCredential:mapsApi',
  ]);
});

test('Visualforce, Flow and NamedCredential scanners', () => {
  const inv = inventory();
  assert.deepEqual(
    keys(scanVisualforce('<apex:page controller="SiteController" extensions="MapsService, Utils"><c:SiteFooter/>{!$Resource.SiteAssets}{!$Label.Site_Title}{!$Page.Receipt}</apex:page>', inv)),
    ['ApexClass:MapsService', 'ApexClass:SiteController', 'ApexClass:Utils', 'ApexComponent:SiteFooter', 'ApexPage:Receipt', 'CustomLabel:Site_Title', 'StaticResource:SiteAssets'],
  );
  assert.deepEqual(
    keys(scanFlow('<Flow><actionCalls><actionName>MapsService</actionName><actionType>apex</actionType></actionCalls><actionCalls><actionName>Utils</actionName><actionType>emailSimple</actionType></actionCalls><subflows><flowName>Send_Confirmation</flowName></subflows><recordCreates><object>Access_Contact__c</object></recordCreates></Flow>', inv)),
    ['ApexClass:MapsService', 'CustomObject:Access_Contact__c', 'Flow:Send_Confirmation'],
  );
  assert.deepEqual(keys(scanNamedCredential('<NamedCredential><namedCredentialParameters><externalCredential>mapsAuth</externalCredential></namedCredentialParameters></NamedCredential>', inv)), ['ExternalCredential:mapsAuth']);
});

test('Site bundle JSON: components, static resources, flows and trusted sites', () => {
  const inv = inventory();
  const view = JSON.stringify({
    type: 'sfdc_cms__view',
    contentBody: {
      component: {
        definition: 'community_layout:section',
        children: [
          { definition: 'c:siteHeader' },
          { definition: 'c:legacyFooter' },
          { definition: 'c:notInOrg' },
          { definition: 'community_builder:htmlEditor', attributes: { richTextValue: '<link href="/sfsites/c/resource/SiteLWRAssets/css/a.css">' } },
          { definition: 'lightning:flow', attributes: { flowName: 'Site_Signup' } },
        ],
      },
    },
  });
  assert.deepEqual(keys(scanBundleJson(view, inv)), ['AuraDefinitionBundle:legacyFooter', 'Flow:Site_Signup', 'LightningComponentBundle:siteHeader', 'StaticResource:SiteLWRAssets']);

  const trusted = '{ "type" : "sfdc_cms__trustedSites", "contentBody" : { "trustedSites" : [ { "sourceName" : "GoogleAnalytics" }, { "sourceName" : "Missing" } ] } }';
  assert.deepEqual(keys(scanBundleJson(trusted, inv)), ['CspTrustedSite:GoogleAnalytics']);
  assert.deepEqual(keys(scanBundleJson('{ "componentName" : "c:legacyFooter" }', inv)), ['AuraDefinitionBundle:legacyFooter']);
});

test('Network and CustomSite XML: profiles ignored, standard pages and templates unticked', () => {
  const inv = inventory();
  const network = `<Network>
    <changePasswordTemplate>unfiled$public/CommunityChangePasswordEmailTemplate</changePasswordTemplate>
    <welcomeTemplate>Site_Emails/Welcome</welcomeTemplate>
    <networkMemberGroups><profile>admin</profile><permissionSet>Site_Member</permissionSet></networkMemberGroups>
    <picassoSite>my_site1</picassoSite><site>my_site</site>
  </Network>`;
  const refs = scanNetwork(network, inv);
  assert.deepEqual(keys(refs), ['EmailTemplate:Site_Emails/Welcome', 'EmailTemplate:unfiled$public/CommunityChangePasswordEmailTemplate', 'PermissionSet:Site_Member']);
  assert.equal(refs.find((r) => r.name.startsWith('unfiled'))!.checked, false);
  assert.equal(refs.find((r) => r.name === 'Site_Emails/Welcome')!.checked, true);
  assert.equal(tagValue(network, 'picassoSite'), 'my_site1');
  assert.equal(tagValue(network, 'site'), 'my_site');

  const site = scanCustomSite('<CustomSite><indexPage>CommunitiesLanding</indexPage><genericErrorPage>CustomError</genericErrorPage><serverIsDown>SNA_page</serverIsDown></CustomSite>', inv);
  assert.deepEqual(keys(site), ['ApexPage:CommunitiesLanding', 'ApexPage:CustomError', 'StaticResource:SNA_page']);
  assert.equal(site.find((r) => r.name === 'CommunitiesLanding')!.checked, false);
  assert.equal(site.find((r) => r.name === 'CustomError')!.checked, true);
});

test('scanDirectory attributes references to the retrieved component', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('unpackaged/lwc/siteHeader/siteHeader.js', "import x from '@salesforce/apex/SiteController.x';");
  write('unpackaged/lwc/siteHeader/__tests__/siteHeader.test.js', "import y from '@salesforce/apex/Utils.y';");
  write('unpackaged/classes/SiteController.cls', 'public class SiteController { MapsService m; }');
  write('unpackaged/classes/SiteController.cls-meta.xml', '<ApexClass/>');
  write('unpackaged/digitalExperiences/site/my_site1/sfdc_cms__view/home/content.json', '{ "definition" : "c:siteHeader" }');
  try {
    const got = scanDirectory(root, inventory())
      .map((s) => `${s.from.type} ${s.from.name} -> ${keys(s.refs).join(',')}`)
      .sort();
    assert.deepEqual(got, [
      'ApexClass SiteController -> ApexClass:MapsService',
      'DigitalExperienceBundle site/my_site1 -> LightningComponentBundle:siteHeader',
      'LightningComponentBundle siteHeader -> ApexClass:SiteController',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default ticks: scanned items the bundle covers are unticked, everything else is left alone', () => {
  const item = (type: string, origin: Item['origin'], checked = true): Item => ({ type, name: type + '1', checked, reasons: ['r'], origin });
  const items = applyDefaultTicks([
    item('Network', 'scan'),
    item('Audience', 'scan'),
    item('CspTrustedSite', 'scan'),
    item('CspTrustedSite', 'org'),
    item('CustomSite', 'scan'),
    item('LightningComponentBundle', 'scan'),
    item('ApexPage', 'scan', false),
  ]);
  assert.deepEqual(COVERED_BY_BUNDLE, ['CspTrustedSite', 'Audience', 'Network']);
  assert.deepEqual(
    items.map((i) => `${i.type}/${i.origin}=${i.checked}`),
    ['Network/scan=false', 'Audience/scan=false', 'CspTrustedSite/scan=false', 'CspTrustedSite/org=true', 'CustomSite/scan=true', 'LightningComponentBundle/scan=true', 'ApexPage/scan=false'],
  );
  // --include-covered: an empty covered list changes nothing.
  assert.equal(applyDefaultTicks([item('Network', 'scan')], [])[0].checked, true);
});

test('package.xml: sorted, escaped, never emits profiles', () => {
  const xml = buildPackageXml(
    [
      { type: 'Network', name: 'R&D site' },
      { type: 'ApexClass', name: 'B' },
      { type: 'ApexClass', name: 'A' },
      { type: 'ApexClass', name: 'A' },
      { type: 'Profile', name: 'R&D site Profile' },
    ],
    '65.0',
  );
  assert.ok(xml.indexOf('<members>A</members>') < xml.indexOf('<members>B</members>'));
  assert.equal(xml.match(/<members>A<\/members>/g)!.length, 1);
  assert.ok(xml.includes('<members>R&amp;D site</members>'));
  assert.ok(!xml.includes('Profile'));
  assert.ok(xml.includes('<version>65.0</version>'));
  assert.equal(manifestFileName('otarmeni-hcp'), 'package-otarmeni-hcp.xml');
  assert.equal(manifestFileName('R&D site'), 'package-R_D_site.xml');
});

test('a namespaced org: its own prefix is not treated as a managed package', () => {
  const inv = new Inventory(undefined as any);
  inv.ownNamespace = 'myns';
  inv.set('ApexClass', [
    { fullName: 'OwnClass', namespacePrefix: 'myns', manageableState: 'unmanaged' },
    { fullName: 'InstalledClass', namespacePrefix: 'pkg', manageableState: 'installed' },
  ]);
  inv.set('CustomObject', [{ fullName: 'Thing__c', namespacePrefix: 'myns', manageableState: 'unmanaged' }]);

  assert.deepEqual(inv.names('ApexClass'), ['OwnClass']);
  assert.equal(inv.find('ApexClass', 'InstalledClass'), undefined);
  // The org's own components can be spelled with or without its prefix.
  assert.equal(inv.find('CustomObject', 'Thing__c'), 'Thing__c');
  assert.equal(inv.find('CustomObject', 'myns__Thing__c'), 'Thing__c');

  inv.set('LightningComponentBundle', [{ fullName: 'siteHeader', namespacePrefix: 'myns', manageableState: 'unmanaged' }]);
  inv.set('CustomLabel', [{ fullName: 'Site_Title', namespacePrefix: 'myns', manageableState: 'unmanaged' }]);
  const plain = (s: string) => withoutOwnNamespace(s, inv.ownNamespace);
  assert.deepEqual(keys(scanBundleJson(plain('{"definition": "myns:siteHeader"}'), inv)), ['LightningComponentBundle:siteHeader']);
  assert.deepEqual(
    keys(
      scanLwc(
        [{ path: 'a.js', text: plain("import run from '@salesforce/apex/myns.OwnClass.run'; import T from '@salesforce/label/myns.Site_Title';") }],
        'a',
        inv,
      ),
    ),
    ['ApexClass:OwnClass', 'CustomLabel:Site_Title'],
  );
  assert.deepEqual(keys(scanApex('myns.OwnClass.run(); pkg.InstalledClass.run();', 'Caller', inv)), []);
  assert.deepEqual(keys(scanApex(plain('myns.OwnClass.run(); pkg.InstalledClass.run();'), 'Caller', inv)), ['ApexClass:OwnClass']);
});

test('Limiter: never runs more than its limit, and cancel rejects what is waiting', async () => {
  const limiter = new Limiter(3);
  let running = 0;
  let peak = 0;
  const task = async (n: number) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n;
  };
  const results = await Promise.all(Array.from({ length: 20 }, (_, n) => limiter.run(() => task(n))));
  assert.equal(peak, 3);
  assert.deepEqual(results, Array.from({ length: 20 }, (_, n) => n));

  const one = new Limiter(1);
  const first = one.run(() => task(1));
  const queued = one.run(() => task(2));
  const rejected = assert.rejects(queued, /Cancelled/);
  one.cancel(new Error('Cancelled.'));
  // A task that was already running is left to finish.
  assert.equal(await first, 1);
  await rejected;
  await assert.rejects(one.run(() => task(3)), /Cancelled/);
});
