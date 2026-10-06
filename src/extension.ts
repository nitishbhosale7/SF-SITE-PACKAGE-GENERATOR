import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Inventory } from './core/inventory';
import { buildPackageXml, manifestFileName } from './core/packageXml';
import { COVERED_BY_BUNDLE, FOLLOWABLE, Resolver, listSites } from './core/resolver';
import { Sf } from './core/sf';
import { ResolveResult, SiteSummary } from './core/types';

const AUTHOR_URL = 'https://www.linkedin.com/in/nitishbhosale07';
const RECENT_LIMIT = 5;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('sitePackageGen.chooseSite', () => SitePanel.show(context)));
}

export function deactivate(): void {}

type Selection = { type: string; name: string }[];

/** Keep only well-formed `{type, name}` pairs from an untrusted webview message. */
function cleanSelection(value: unknown): Selection {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v.type === 'string' && typeof v.name === 'string' && /^[A-Za-z0-9_]+$/.test(v.type) && v.name.length > 0 && v.name.length < 512)
    .map((v) => ({ type: v.type, name: v.name }));
}

class SitePanel {
  private static current: SitePanel | undefined;

  static show(context: vscode.ExtensionContext): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('Open a Salesforce DX project folder first.');
      return;
    }
    if (SitePanel.current) {
      SitePanel.current.panel.reveal();
      return;
    }
    SitePanel.current = new SitePanel(context, folder.uri.fsPath);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly sf: Sf;
  private readonly inventory: Inventory;
  private sites: SiteSummary[] = [];
  private result: ResolveResult | undefined;
  private org = '';
  private metadataTypes: { xmlName: string; inFolder: boolean }[] | undefined;
  private busy = false;

  private constructor(private readonly context: vscode.ExtensionContext, private readonly root: string) {
    const config = vscode.workspace.getConfiguration('sitePackageGen');
    this.sf = new Sf(root, config.get<string>('sfPath') || 'sf');
    // Kept for the lifetime of the panel so a second site, and "View all in org", skip re-indexing.
    this.inventory = new Inventory(this.sf);

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('sitePackageGen', 'Site Package.xml Generator', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => (SitePanel.current = undefined), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, context.subscriptions);
  }

  private post(message: unknown): void {
    this.panel.webview.postMessage(message);
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.command) {
        case 'loadSites':
          return await this.loadSites();
        case 'selectSite':
          return await this.selectSite(String(m.id));
        case 'viewAll':
          return await this.viewAll(String(m.type), !!m.refresh, !!m.open);
        case 'addFromOrg':
          return await this.addFromOrg();
        case 'addDependencies':
          return await this.addDependencies(cleanSelection(m.items));
        case 'saveAdditions':
          if (this.result) await this.context.globalState.update(this.additionsKey(this.result.site), cleanSelection(m.items));
          return;
        case 'write':
          await this.write(cleanSelection(m.selection), !!m.overwriteDefault);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(this.xml(cleanSelection(m.selection)));
          vscode.window.showInformationMessage('package.xml copied to clipboard.');
          return;
        case 'retrieve':
          return await this.retrieve(cleanSelection(m.selection));
        case 'openAuthor':
          // The target is fixed here; the webview cannot choose what gets opened.
          await vscode.env.openExternal(vscode.Uri.parse(AUTHOR_URL));
          return;
      }
    } catch (e: any) {
      this.busy = false;
      this.post({ command: 'error', message: e.message ?? String(e) });
    }
  }

  private additionsKey(site: SiteSummary): string {
    return `additions:${this.org}:${site.id}`;
  }

  private async loadSites(): Promise<void> {
    const org = await this.sf.orgDisplay();
    this.org = org.username;
    this.sites = await listSites(this.sf);
    const recent = this.context.globalState.get<string[]>(`recent:${this.org}`, []);
    this.post({ command: 'sites', sites: this.sites, org: org.alias || org.username, recent });
  }

  private async selectSite(id: string): Promise<void> {
    if (this.busy) return;
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    this.busy = true;
    const recentKey = `recent:${this.org}`;
    const recent = [id, ...this.context.globalState.get<string[]>(recentKey, []).filter((r) => r !== id)].slice(0, RECENT_LIMIT);
    await this.context.globalState.update(recentKey, recent);

    const includeTestClasses = vscode.workspace.getConfiguration('sitePackageGen').get<boolean>('includeTestClasses', true);
    const resolver = new Resolver(this.sf, this.inventory, (message, stage) => this.post({ command: 'progress', message, stage }), { includeTestClasses });
    // Fetched alongside the scan so the full list of metadata types is ready with the result.
    const types = this.knownTypes().catch(() => []);
    try {
      this.result = await resolver.resolve(site);
      // Components the user added by hand last time are put back.
      const additions = this.context.globalState.get<Selection>(this.additionsKey(site), []);
      const orgTypes = (await types).filter((t) => !t.inFolder).map((t) => t.xmlName);
      this.post({ command: 'result', result: this.result, additions, followable: FOLLOWABLE, covered: COVERED_BY_BUNDLE, orgTypes });
    } finally {
      this.busy = false;
    }
  }

  private async knownTypes(): Promise<{ xmlName: string; inFolder: boolean }[]> {
    if (!this.metadataTypes) this.metadataTypes = await this.sf.listMetadataTypes();
    return this.metadataTypes;
  }

  /** List every component of one type in the org. The type name comes from the webview, so it is checked first. */
  private async viewAll(type: string, refresh: boolean, open: boolean): Promise<void> {
    const known = (await this.knownTypes()).find((t) => t.xmlName === type && !t.inFolder);
    if (!known) throw new Error(`"${type}" cannot be listed from this org.`);
    this.post({ command: 'busy', message: `Listing ${type} from the org…` });
    try {
      if (refresh) this.inventory.forget(type);
      await this.inventory.load(type);
      this.post({ command: 'orgItems', type, names: this.inventory.names(type), listedAt: this.inventory.listedAt(type) ?? Date.now(), open });
    } finally {
      this.post({ command: 'busy', message: '' });
    }
  }

  private async addFromOrg(): Promise<void> {
    const types = (await this.knownTypes()).filter((t) => !t.inFolder).map((t) => t.xmlName).sort((a, b) => a.localeCompare(b));
    const picked = await vscode.window.showQuickPick(types, { title: 'Add from org', placeHolder: 'Pick a metadata type to list its components' });
    if (picked) await this.viewAll(picked, false, true);
  }

  private async addDependencies(seeds: Selection): Promise<void> {
    const followable = seeds.filter((s) => FOLLOWABLE.includes(s.type));
    if (this.busy || !followable.length) return;
    this.busy = true;
    const resolver = new Resolver(this.sf, this.inventory, (message, stage) => {
      if (stage !== 'index') this.post({ command: 'busy', message: `Finding dependencies… ${message}` });
    });
    this.post({ command: 'busy', message: 'Finding dependencies…' });
    try {
      const { items, warnings } = await resolver.dependenciesOf(followable);
      this.post({ command: 'dependencies', seeds: followable, items, warnings });
    } finally {
      this.busy = false;
      this.post({ command: 'busy', message: '' });
    }
  }

  private xml(selection: Selection): string {
    if (!this.result) throw new Error('Select a site first.');
    if (!selection.length) throw new Error('Tick at least one component.');
    return buildPackageXml(selection, this.result.apiVersion);
  }

  private async write(selection: Selection, overwriteDefault: boolean): Promise<string> {
    const xml = this.xml(selection);
    const file = path.join(this.root, 'manifest', overwriteDefault ? 'package.xml' : manifestFileName(this.result!.site.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.Beside);
    return file;
  }

  private async retrieve(selection: Selection): Promise<void> {
    const file = await this.write(selection, false);
    const answer = await vscode.window.showWarningMessage(
      `Retrieve ${selection.length} components into this project? Local files for these components will be overwritten.`,
      { modal: true },
      'Retrieve',
    );
    if (answer !== 'Retrieve') return;
    const terminal = vscode.window.createTerminal('Site retrieve');
    terminal.show();
    terminal.sendText(`sf project retrieve start --manifest "${path.relative(this.root, file)}"`);
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Site Package.xml Generator</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
