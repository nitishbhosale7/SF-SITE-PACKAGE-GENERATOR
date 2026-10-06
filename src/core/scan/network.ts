import { Lookup, Ref } from '../types';
import { Refs } from './refs';

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function leafTags(xml: string): { tag: string; value: string }[] {
  return [...xml.matchAll(/<(\w+)>([^<]+)<\/\1>/g)].map((m) => ({ tag: m[1], value: unescapeXml(m[2].trim()) }));
}

export function tagValue(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1].trim()) : undefined;
}

/**
 * Pages Salesforce generates for every org with sites enabled. They are listed but left
 * unticked and not followed, so their shared controllers do not flood the package.
 */
const STANDARD_SITE_PAGES = new Set(
  [
    'AnswersHome', 'BandwidthExceeded', 'ChangePassword', 'CommunitiesLanding', 'CommunitiesLogin',
    'CommunitiesSelfReg', 'CommunitiesSelfRegConfirm', 'CommunitiesTemplate', 'Exception', 'FileNotFound',
    'ForgotPassword', 'ForgotPasswordConfirm', 'IdeasHome', 'InMaintenance', 'MyProfilePage', 'SiteLogin',
    'SiteRegister', 'SiteRegisterConfirm', 'SiteTemplate', 'StdExceptionTemplate', 'Unauthorized', 'UnderConstruction',
  ].map((n) => n.toLowerCase()),
);

/** Network (community) XML. Profiles are deliberately ignored. */
export function scanNetwork(xml: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const { tag, value } of leafTags(xml)) {
    if (/Template$/.test(tag) && value.includes('/')) {
      const standard = /^unfiled\$public\/Community/.test(value);
      refs.addUnchecked('EmailTemplate', value, `email template set on the site (${tag})`, !standard);
    } else if (tag === 'permissionSet') {
      refs.add('PermissionSet', value, 'permission set granted site membership');
    } else if (/Page$/.test(tag)) {
      refs.add('ApexPage', value, `page set on the site (${tag})`, !STANDARD_SITE_PAGES.has(value.toLowerCase()));
    } else if (/(Class|Handler)$/.test(tag)) {
      refs.add('ApexClass', value, `Apex class set on the site (${tag})`);
    } else if (/Flow$/.test(tag)) {
      refs.add('Flow', value, `flow set on the site (${tag})`);
    }
  }
  return refs.list;
}

/** CustomSite (the Visualforce/guest side of the site) XML. */
export function scanCustomSite(xml: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);
  for (const { tag, value } of leafTags(xml)) {
    if (/Page$/.test(tag)) {
      refs.add('ApexPage', value, `page set on the site (${tag})`, !STANDARD_SITE_PAGES.has(value.toLowerCase()));
    } else if (tag === 'serverIsDown' || tag === 'favoriteIcon') {
      refs.add('StaticResource', value, `static resource set on the site (${tag})`);
    }
  }
  return refs.list;
}
