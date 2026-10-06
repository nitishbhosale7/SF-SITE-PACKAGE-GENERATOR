import { Lookup, Ref } from '../types';
import { Refs, addCustomObjects } from './refs';
import { addComponent } from './lwc';

/**
 * One JSON file of an Experience Builder site bundle (DigitalExperienceBundle `content.json`
 * or an ExperienceBundle view/theme/route file).
 */
export function scanBundleJson(text: string, lk: Lookup): Ref[] {
  const refs = new Refs(lk);

  // Components placed on pages and theme layouts: LWR uses "definition", Aura uses "componentName".
  for (const m of text.matchAll(/"(?:definition|componentName)"\s*:\s*"c:(\w+)"/g)) {
    addComponent(refs, m[1], 'placed on a site page or theme layout');
  }

  for (const m of text.matchAll(/"\w*[fF]low\w*"\s*:\s*"(\w+)"/g)) refs.add('Flow', m[1], 'flow embedded in a site page');

  // Head markup and HTML editors link static resources by URL.
  for (const m of text.matchAll(/\/resource\/(?:\d+\/)?(\w+)/g)) refs.add('StaticResource', m[1], 'static resource URL in site markup');

  if (/"type"\s*:\s*"sfdc_cms__trustedSites"/.test(text)) {
    for (const m of text.matchAll(/"sourceName"\s*:\s*"([^"]+)"/g)) refs.add('CspTrustedSite', m[1], 'trusted site in the site security settings');
  }

  addCustomObjects(refs, text, 'object referenced by a site page');
  return refs.list;
}
