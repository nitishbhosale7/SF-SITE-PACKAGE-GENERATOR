import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildPackageXml } from './packageXml';

export interface FileProperties {
  fullName: string;
  id?: string;
  namespacePrefix?: string | null;
  manageableState?: string | null;
  type?: string;
}

export interface OrgInfo {
  apiVersion: string;
  username: string;
  alias?: string;
  instanceUrl: string;
}

const isWin = process.platform === 'win32';

/** Thin wrapper over the Salesforce CLI. Every call is read-only against the org. */
export class Sf {
  constructor(
    private readonly cwd: string,
    private readonly sfPath = 'sf',
    private readonly targetOrg?: string,
  ) {}

  private exec(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const full = this.targetOrg ? [...args, '--target-org', this.targetOrg] : args;
    // sf is a .cmd shim on Windows, which execFile can only run through a shell.
    const finalArgs = isWin ? full.map((a) => `"${a.replace(/"/g, '\\"')}"`) : full;
    return new Promise((resolve, reject) => {
      execFile(
        this.sfPath,
        finalArgs,
        {
          cwd: this.cwd,
          maxBuffer: 512 * 1024 * 1024,
          shell: isWin,
          env: { ...process.env, SF_AUTOUPDATE_DISABLE: 'true', FORCE_COLOR: '0' },
        },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`Salesforce CLI not found ("${this.sfPath}"). Install it or set sitePackageGen.sfPath.`));
            return;
          }
          const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
    });
  }

  private async json(args: string[]): Promise<any> {
    const { stdout, stderr } = await this.exec([...args, '--json']);
    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`sf ${args.slice(0, 3).join(' ')} failed: ${(stderr || stdout).trim().slice(0, 500)}`);
    }
    if (parsed.status && parsed.status !== 0) {
      const err = new Error(parsed.message || `sf ${args.slice(0, 3).join(' ')} failed`);
      (err as any).result = parsed.result;
      throw err;
    }
    return parsed.result;
  }

  async orgDisplay(): Promise<OrgInfo> {
    const r = await this.json(['org', 'display']);
    return { apiVersion: r.apiVersion, username: r.username, alias: r.alias, instanceUrl: r.instanceUrl };
  }

  async query<T = any>(soql: string, tooling = false): Promise<T[]> {
    const args = ['data', 'query', '--query', soql];
    if (tooling) args.push('--use-tooling-api');
    const r = await this.json(args);
    return r.records ?? [];
  }

  async listMetadata(type: string): Promise<FileProperties[]> {
    const r = await this.json(['org', 'list', 'metadata', '--metadata-type', type]);
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  }

  /** Top-level metadata types the org supports; `inFolder` types need a folder to list. */
  async listMetadataTypes(): Promise<{ xmlName: string; inFolder: boolean }[]> {
    const r = await this.json(['org', 'list', 'metadata-types']);
    return toArray<any>(r?.metadataObjects).map((m) => ({ xmlName: m.xmlName, inFolder: !!m.inFolder }));
  }

  /** GET a REST resource, e.g. `/connect/cms/spaces`. */
  async rest(resource: string, apiVersion: string): Promise<any> {
    const { stdout, stderr } = await this.exec(['api', 'request', 'rest', `/services/data/v${apiVersion}${resource}`]);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`REST ${resource} failed: ${(stderr || stdout).trim().slice(0, 300)}`);
    }
  }

  /**
   * Retrieve components in metadata format into `dir` (outside the project source).
   * Returns warnings for members the org could not return.
   */
  async retrieve(members: { type: string; name: string }[], dir: string, apiVersion: string): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.xml');
    fs.writeFileSync(manifest, buildPackageXml(members, apiVersion));
    const out = path.join(dir, 'src');
    const warnings: string[] = [];
    try {
      const r = await this.json([
        'project', 'retrieve', 'start',
        '--manifest', manifest,
        '--target-metadata-dir', out,
        '--unzip',
        '--wait', '60',
      ]);
      for (const m of toArray(r?.messages)) if (m?.problem) warnings.push(m.problem);
    } catch (e: any) {
      warnings.push(`Retrieve failed: ${e.message}`);
    }
    return warnings;
  }
}

export function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
