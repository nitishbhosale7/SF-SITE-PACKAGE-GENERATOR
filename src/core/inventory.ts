import { FileProperties, Sf, pool } from './sf';
import { Lookup } from './types';

interface Entry {
  fullName: string;
  id?: string;
  managed: boolean;
}

/** Cached index of what exists in the org, per metadata type. */
export class Inventory implements Lookup {
  private readonly types = new Map<string, Map<string, Entry>>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly listed = new Map<string, number>();
  readonly failed: string[] = [];
  /**
   * The org's own namespace. Everything created in a namespaced Developer Edition org carries
   * this prefix without being part of an installed package, so it must not be treated as managed.
   */
  ownNamespace = '';
  private namespaceLoading?: Promise<void>;

  constructor(private readonly sf: Sf) {}

  private loadNamespace(): Promise<void> {
    this.namespaceLoading ??= this.sf
      .orgNamespace()
      .then((ns) => {
        this.ownNamespace = ns;
      })
      // Without it, prefixed components stay hidden, as in an org with no namespace.
      .catch(() => {});
    return this.namespaceLoading;
  }

  async preload(types: string[], progress?: (message: string) => void): Promise<void> {
    let done = 0;
    await pool(types, 6, async (t) => {
      await this.load(t);
      progress?.(`Indexing org metadata (${++done}/${types.length})`);
    });
  }

  load(type: string): Promise<void> {
    if (!this.loading.has(type)) {
      this.loading.set(
        type,
        this.loadNamespace()
          .then(() => this.sf.listMetadata(type))
          .then((list) => {
            this.set(type, list);
            this.listed.set(type, Date.now());
          })
          .catch(() => {
            this.failed.push(type);
            this.set(type, []);
          }),
      );
    }
    return this.loading.get(type)!;
  }

  /** Forget a type so the next `load` asks the org again. */
  forget(type: string): void {
    this.loading.delete(type);
    this.types.delete(type);
  }

  /** When the type was last listed from the org (epoch ms), if it has been. */
  listedAt(type: string): number | undefined {
    return this.listed.get(type);
  }

  /** Also used by tests to seed the index without an org. */
  set(type: string, list: FileProperties[]): void {
    const map = new Map<string, Entry>();
    for (const f of list) {
      if (!f?.fullName) continue;
      map.set(f.fullName.toLowerCase(), {
        fullName: f.fullName,
        id: f.id || undefined,
        managed: f.manageableState === 'installed' || (!!f.namespacePrefix && f.namespacePrefix !== this.ownNamespace),
      });
    }
    this.types.set(type, map);
  }

  find(type: string, name: string): string | undefined {
    const map = this.types.get(type);
    const key = name.toLowerCase();
    // Code in a namespaced org may spell its own components with or without the org's prefix.
    const own = this.ownNamespace.toLowerCase() + '__';
    const e = map?.get(key) ?? (own.length > 2 && key.startsWith(own) ? map?.get(key.slice(own.length)) : undefined);
    return e && !e.managed ? e.fullName : undefined;
  }

  exact(type: string, name: string): string | undefined {
    const found = this.find(type, name);
    return found === name ? found : undefined;
  }

  names(type: string): string[] {
    return [...(this.types.get(type)?.values() ?? [])].filter((e) => !e.managed).map((e) => e.fullName);
  }

  /** Match by record Id; 15- and 18-character Ids are treated as equal. */
  byId(type: string, id: string): string | undefined {
    const short = id.slice(0, 15);
    for (const e of this.types.get(type)?.values() ?? []) {
      if (e.id && e.id.slice(0, 15) === short && !e.managed) return e.fullName;
    }
    return undefined;
  }

  idOf(type: string, name: string): string | undefined {
    return this.types.get(type)?.get(name.toLowerCase())?.id;
  }
}
