import { Lookup, Ref } from '../types';

/** Collects references, keeping only names that resolve to a real unmanaged component in the org. */
export class Refs {
  readonly list: Ref[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly lk: Lookup) {}

  add(type: string, rawName: string, why: string, checked?: boolean): boolean {
    return this.push(type, this.lk.find(type, rawName), why, checked);
  }

  addExact(type: string, rawName: string, why: string): boolean {
    return this.push(type, this.lk.exact(type, rawName), why);
  }

  /** For names the org index cannot validate (e.g. foldered types). */
  addUnchecked(type: string, name: string, why: string, checked?: boolean): void {
    this.push(type, name, why, checked);
  }

  private push(type: string, name: string | undefined, why: string, checked?: boolean): boolean {
    if (!name) return false;
    const key = `${type}:${name}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.list.push({ type, name, why, checked });
    }
    return true;
  }
}

const OBJECT_TOKEN = /\b[A-Za-z]\w*__(?:c|mdt|e|x|b)\b/g;

/** Custom objects, custom settings, custom metadata types and platform events named in `text`. */
export function addCustomObjects(refs: Refs, text: string, why: string): void {
  for (const m of text.matchAll(OBJECT_TOKEN)) refs.add('CustomObject', m[0], why);
}
