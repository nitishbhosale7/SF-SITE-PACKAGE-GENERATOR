// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /**
   * @typedef {{type: string, name: string, checked: boolean, reasons: string[], origin: 'scan'|'org', initial: boolean, depsDone?: boolean}} Item
   * @typedef {{type: string, label: string, items: Item[], viewAll: boolean, listedAt: number, limit: number}} Group
   */

  const PAGE = 300;
  const PREVIEW_MEMBERS = 50;
  const LARGE_MANIFEST = 5000;

  const state = {
    /** @type {'loading'|'sites'|'working'|'result'} */ view: 'loading',
    /** @type {any[]} */ sites: [],
    /** @type {string[]} */ recent: [],
    org: '',
    filter: '',
    error: '',
    busy: '',
    siteName: '',
    startedAt: 0,
    stage: '',
    /** @type {Record<string, string>} */ stageDetail: {},
    indexDone: 0,
    indexTotal: 0,
    /** @type {any} */ result: null,
    /** @type {Group[]} */ groups: [],
    /** @type {string[]} */ covered: [],
    /** @type {string[]} */ followable: [],
    /** Every listable metadata type in the org; contents are fetched only when one is opened. */
    /** @type {string[]} */ orgTypes: [],
    loadingType: '',
    activeType: '',
    onlyTicked: false,
    /** Which pane is shown when the panel is too narrow for all three. */
    /** @type {'groups'|'items'|'xml'} */ pane: 'groups',
    itemFilter: '',
    revealXml: false,
  };

  const TYPE_LABELS = {
    LightningComponentBundle: 'Lightning components',
    AuraDefinitionBundle: 'Aura components',
    ApexClass: 'Apex classes',
    ApexTrigger: 'Apex triggers',
    ApexPage: 'Visualforce pages',
    ApexComponent: 'Visualforce components',
    StaticResource: 'Static resources',
    CustomObject: 'Custom objects',
    CustomLabel: 'Custom labels',
    CustomMetadata: 'Custom metadata records',
    CustomPermission: 'Custom permissions',
    NamedCredential: 'Named credentials',
    ExternalCredential: 'External credentials',
    CspTrustedSite: 'Trusted sites',
    CorsWhitelistOrigin: 'CORS origins',
    DigitalExperienceBundle: 'Site and CMS bundles',
    DigitalExperienceConfig: 'Site configuration',
    ExperienceBundle: 'Site bundle',
    SiteDotCom: 'Site (legacy)',
    Network: 'Site network',
    CustomSite: 'Site record',
    NetworkBranding: 'Site branding',
    NavigationMenu: 'Navigation menus',
    ManagedContentType: 'CMS content types',
    ManagedTopics: 'Topics',
    Audience: 'Audiences',
    Flow: 'Flows',
    EmailTemplate: 'Email templates',
    PermissionSet: 'Permission sets',
    ContentAsset: 'Content assets',
    LightningMessageChannel: 'Message channels',
  };

  const STAGES = [
    { id: 'index', label: 'Reading the org', hint: 'The longest step: listing what exists in the org.' },
    { id: 'core', label: "Finding the site's own metadata", hint: 'Site record, bundle, CMS workspace, navigation.' },
    { id: 'follow', label: 'Following what the site uses', hint: 'Pages → components → Apex. Repeats until nothing new turns up.' },
    { id: 'check', label: 'Double-checking with Salesforce', hint: "Compares against Salesforce's own dependency records." },
  ];

  /** Sources that mean "the site itself uses this", as opposed to a dependency of a dependency. */
  const DIRECT_SOURCES = ['DigitalExperienceBundle', 'ExperienceBundle', 'Network', 'CustomSite'];

  /** @param {string} type */
  const labelOf = (type) => TYPE_LABELS[/** @type {keyof typeof TYPE_LABELS} */ (type)] || type.replace(/([a-z])([A-Z])/g, '$1 $2');

  /**
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {any[]} children
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) if (c) el.append(c);
    return el;
  }

  // ------------------------------------------------------------------ messages from the extension

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.command) {
      case 'sites':
        state.sites = m.sites;
        state.recent = m.recent || [];
        state.org = m.org;
        state.view = 'sites';
        state.error = '';
        break;
      case 'progress': {
        state.stage = m.stage;
        const counter = /\((\d+)\/(\d+)\)/.exec(m.message);
        if (m.stage === 'index' && counter) {
          state.indexDone = Number(counter[1]);
          state.indexTotal = Number(counter[2]);
          state.stageDetail.index = `${counter[1]} of ${counter[2]} metadata types`;
        } else {
          state.stageDetail[m.stage] = m.message;
        }
        break;
      }
      case 'result':
        loadResult(m);
        break;
      case 'orgItems':
        mergeOrgItems(m);
        break;
      case 'dependencies':
        mergeDependencies(m);
        break;
      case 'busy':
        state.busy = m.message;
        if (state.view === 'result') return refreshChrome();
        break;
      case 'error':
        state.error = m.message;
        state.busy = '';
        state.loadingType = '';
        if (state.view === 'working' || state.view === 'loading') state.view = 'sites';
        break;
    }
    render();
  });

  /** @param {string} type @returns {Group} */
  function ensureGroup(type) {
    let g = state.groups.find((x) => x.type === type);
    if (!g) {
      g = { type, label: labelOf(type), items: [], viewAll: false, listedAt: 0, limit: PAGE };
      state.groups.push(g);
    }
    return g;
  }

  /** @param {any} m */
  function loadResult(m) {
    state.result = m.result;
    state.covered = m.covered || [];
    state.followable = m.followable || [];
    state.orgTypes = m.orgTypes || [];
    state.loadingType = '';
    state.groups = [];
    for (const raw of m.result.items) ensureGroup(raw.type).items.push({ ...raw, initial: raw.checked });
    // Components added by hand on an earlier visit.
    for (const add of m.additions || []) {
      const g = ensureGroup(add.type);
      const existing = g.items.find((i) => i.name === add.name);
      if (existing) existing.checked = true;
      else g.items.push({ type: add.type, name: add.name, checked: true, reasons: ['added by hand earlier'], origin: 'org', initial: false, depsDone: true });
    }
    const ticked = (/** @type {Group} */ g) => g.items.filter((i) => i.checked).length;
    state.groups.sort((a, b) => ticked(b) - ticked(a) || a.label.localeCompare(b.label));
    for (const g of state.groups) g.items.sort((a, b) => a.name.localeCompare(b.name));
    state.activeType = state.groups[0] ? state.groups[0].type : '';
    state.onlyTicked = false;
    state.pane = 'groups';
    state.itemFilter = '';
    state.busy = '';
    state.view = 'result';
  }

  /** @param {any} m */
  function mergeOrgItems(m) {
    const g = ensureGroup(m.type);
    const have = new Set(g.items.map((i) => i.name));
    for (const name of m.names) {
      if (!have.has(name)) g.items.push({ type: m.type, name, checked: false, reasons: ['not related to this site'], origin: 'org', initial: false });
    }
    g.items.sort((a, b) => a.name.localeCompare(b.name));
    g.viewAll = true;
    g.listedAt = m.listedAt;
    g.limit = PAGE;
    state.loadingType = '';
    if (m.open) {
      state.activeType = m.type;
      state.pane = 'items';
    }
  }

  /** @param {any} m */
  function mergeDependencies(m) {
    for (const seed of m.seeds) {
      const item = ensureGroup(seed.type).items.find((i) => i.name === seed.name);
      if (item) item.depsDone = true;
    }
    for (const dep of m.items) {
      const g = ensureGroup(dep.type);
      const existing = g.items.find((i) => i.name === dep.name);
      if (existing) {
        // Already known: tick it unless it is a scanned item the bundle covers.
        if (existing.origin === 'org' && dep.checked) {
          existing.checked = true;
          existing.reasons = dep.reasons;
          existing.depsDone = true;
        }
      } else {
        g.items.push({ ...dep, origin: 'org', initial: false, depsDone: true });
      }
    }
    for (const g of state.groups) g.items.sort((a, b) => a.name.localeCompare(b.name));
    if (m.warnings && m.warnings.length) state.result.warnings = [...state.result.warnings, ...m.warnings];
    scheduleSave();
  }

  // ------------------------------------------------------------------ selection helpers

  const allItems = () => state.groups.flatMap((g) => g.items);
  const selection = () => allItems().filter((i) => i.checked).map((i) => ({ type: i.type, name: i.name }));
  const manifestName = () => `package-${state.result.site.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.xml`;
  const activeGroup = () => state.groups.find((g) => g.type === state.activeType) || state.groups[0];

  /** @param {Item} item */
  function matches(item) {
    const q = state.itemFilter.trim().toLowerCase();
    return !q || item.name.toLowerCase().includes(q) || item.reasons.some((r) => r.toLowerCase().includes(q));
  }

  /** What a group currently offers: the site's own items, plus org items once listed (or ticked). */
  /** @param {Group} g */
  const universe = (g) => g.items.filter((i) => i.origin === 'scan' || g.viewAll || i.checked);

  /** Rows for the items pane: site items first, then org items with ticked ones on top. */
  /** @param {Group} g */
  function shown(g) {
    const rows = universe(g).filter((i) => matches(i) && (!state.onlyTicked || i.checked));
    const site = rows.filter((i) => i.origin === 'scan');
    const org = rows.filter((i) => i.origin === 'org');
    return [...site, ...org.filter((i) => i.checked), ...org.filter((i) => !i.checked)];
  }

  /** @param {Item} item */
  function reasonParts(item) {
    const [why, source = ''] = item.reasons[0].split(' — ');
    const space = source.indexOf(' ');
    const sourceType = space > 0 ? source.slice(0, space) : source;
    return {
      why,
      sourceName: space > 0 ? source.slice(space + 1) : '',
      direct: item.origin === 'scan' && (!source || DIRECT_SOURCES.includes(sourceType)),
    };
  }

  let saveTimer = 0;
  /** Remember hand-added components for this org and site. */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const items = allItems().filter((i) => i.origin === 'org' && i.checked).map((i) => ({ type: i.type, name: i.name }));
      vscode.postMessage({ command: 'saveAdditions', items });
    }, 400);
  }

  const pendingDependencies = () => allItems().filter((i) => i.origin === 'org' && i.checked && !i.depsDone && state.followable.includes(i.type));

  // ------------------------------------------------------------------ rendering

  /** @param {() => void} fn Run `fn`, keeping every scrollable pane where it was. */
  function keepingScroll(fn) {
    /** @type {Record<string, number>} */
    const scroll = {};
    for (const el of document.querySelectorAll('[data-scroll]')) scroll[el.id] = el.scrollTop;
    fn();
    for (const [id, top] of Object.entries(scroll)) {
      const el = document.getElementById(id);
      if (el) el.scrollTop = top;
    }
  }

  /** @param {string} id @param {Node|null|undefined|false} node */
  function replaceById(id, node) {
    const old = document.getElementById(id);
    if (old && node) old.replaceWith(node);
  }

  /** Full rebuild: used when the view or the structure changes. */
  function render() {
    const focused = /** @type {HTMLInputElement|null} */ (document.activeElement);
    const focusId = focused && focused.id;
    const caret = focused && focused.selectionStart;

    keepingScroll(() => {
      // replaceChildren stringifies non-nodes, so inactive views (false) must be dropped first.
      const sections = [
        renderHeader(),
        state.error && h('div', { class: 'banner banner-error', role: 'alert' }, state.error),
        state.view === 'loading' && renderSites(true),
        state.view === 'sites' && renderSites(false),
        state.view === 'working' && renderWorking(),
        ...(state.view === 'result' ? renderResult() : []),
        renderFooter(),
      ].filter((n) => n instanceof Node);
      app.replaceChildren(...sections);
    });

    if (state.revealXml) {
      state.revealXml = false;
      const pane = document.getElementById('pane-xml');
      const line = /** @type {HTMLElement|null} */ (pane && pane.querySelector('.line.active'));
      if (pane && line) pane.scrollTop = Math.max(0, line.offsetTop - 40);
      const items = document.getElementById('pane-items');
      if (items) items.scrollTop = 0;
    }
    if (focusId) {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(focusId));
      if (el) {
        el.focus();
        if (caret !== null && el.setSelectionRange) el.setSelectionRange(caret, caret);
      }
    }
    tickClock();
  }

  /**
   * After a tick: refresh counts, the group list and the preview, but leave the item rows alone.
   * Rebuilding thousands of rows on every click would make the list unusable.
   */
  function refreshChrome() {
    if (state.view !== 'result') return;
    const g = activeGroup();
    // The filter box lives in the bar being replaced, so typing must not lose focus or the caret.
    const focused = /** @type {HTMLInputElement|null} */ (document.activeElement);
    const focusId = focused && focused.id;
    const caret = focused && focused.type === 'search' ? focused.selectionStart : null;
    keepingScroll(() => {
      replaceById('triage', renderTriage());
      replaceById('groups-pane', renderGroups());
      replaceById('xml-pane', renderXml(g));
      if (g) {
        replaceById('items-head', renderItemsHead(g));
        replaceById('items-selectall', renderSelectAll(g));
      }
    });
    const el = /** @type {HTMLInputElement|null} */ (focusId ? document.getElementById(focusId) : null);
    if (el && el !== document.activeElement) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }

  /** Rebuild the item rows of the active group (filter, paging, bulk changes). */
  function refreshItems() {
    const g = activeGroup();
    if (state.view !== 'result' || !g) return;
    keepingScroll(() => replaceById('items-pane', renderItems(g)));
    refreshChrome();
  }

  function changed() {
    refreshChrome();
    scheduleSave();
  }

  function renderHeader() {
    const r = state.view === 'result' ? state.result : null;
    const working = state.view === 'working';
    return h(
      'header',
      { class: 'topbar' },
      r ? h('button', { class: 'link', onclick: () => { state.view = 'sites'; render(); } }, '← All sites') : h('h1', {}, 'Site Package.xml Generator'),
      r && h('h1', {}, r.site.name),
      r && h('span', { class: 'muted' }, `API ${r.apiVersion}`),
      working && h('span', { class: 'muted' }, state.siteName),
      h('span', { class: 'spacer' }),
      state.org && h('span', { class: 'pill' }, h('span', { class: 'dot dot-ok' }), `Org: ${state.org}`),
    );
  }

  function renderFooter() {
    return h(
      'footer',
      { class: 'footer' },
      'Developed by: ',
      h('button', { class: 'link', title: 'Open LinkedIn profile', onclick: () => vscode.postMessage({ command: 'openAuthor' }) }, 'Nitish Bhosale'),
    );
  }

  // ---- site picker

  /** @param {any} s */
  function siteRow(s) {
    const pick = () => {
      state.view = 'working';
      state.siteName = s.name;
      state.startedAt = Date.now();
      state.stage = 'index';
      state.stageDetail = {};
      state.indexDone = 0;
      state.indexTotal = 0;
      state.error = '';
      render();
      vscode.postMessage({ command: 'selectSite', id: s.id });
    };
    return h(
      'li',
      {},
      h(
        'button',
        { class: 'row', onclick: pick },
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, s.name), h('span', { class: 'mono muted small' }, s.urlPathPrefix ? `/${s.urlPathPrefix}` : 'no URL path')),
        h('span', { class: 'status' }, h('span', { class: `dot ${s.status === 'Live' ? 'dot-ok' : 'dot-idle'}` }), s.status),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
      ),
    );
  }

  /** @param {boolean} loading */
  function renderSites(loading) {
    const q = state.filter.toLowerCase();
    const sites = state.sites.filter((s) => !q || s.name.toLowerCase().includes(q) || s.urlPathPrefix.toLowerCase().includes(q));
    const recent = q ? [] : state.recent.map((id) => state.sites.find((s) => s.id === id)).filter(Boolean);
    return h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'triage' },
        h('span', { class: 'badge' }, h('span', { class: 'dot dot-ok' }), h('strong', {}, loading ? 'Loading sites…' : `${state.sites.length} sites`)),
        h('input', {
          id: 'site-filter', class: 'search', type: 'search', placeholder: 'Search by name or URL path…', value: state.filter, 'aria-label': 'Search sites', disabled: loading,
          oninput: (/** @type {any} */ e) => { state.filter = e.target.value; render(); },
        }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'secondary', disabled: loading, onclick: () => { state.view = 'loading'; state.error = ''; render(); vscode.postMessage({ command: 'loadSites' }); } }, 'Refresh'),
      ),
      h(
        'div',
        { class: 'pane-body list-page', id: 'page-sites', 'data-scroll': true },
        loading && h('ul', { class: 'rows' }, [0, 1, 2, 3, 4, 5].map(() => h('li', { class: 'row skeleton' }, h('span', { class: 'bar' }), h('span', { class: 'bar short' })))),
        recent.length > 0 && [
          h('div', { class: 'pane-head' }, h('span', { class: 'eyebrow' }, 'Recent')),
          h('ul', { class: 'rows' }, recent.map(siteRow)),
        ],
        !loading && [
          h('div', { class: 'pane-head' }, h('span', { class: 'eyebrow' }, q ? 'Matching sites' : 'All sites'), h('span', { class: 'count-chip' }, String(sites.length))),
          h('ul', { class: 'rows' }, sites.map(siteRow)),
          !sites.length && h('p', { class: 'muted pad' }, state.sites.length ? `No sites match "${state.filter}".` : 'This org has no Experience Cloud sites.'),
          h('p', { class: 'muted small pad' }, 'Pick a site to collect everything it uses. Nothing in your project changes until you write a manifest or retrieve.'),
        ],
      ),
    );
  }

  // ---- progress

  const elapsed = () => {
    const s = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  let clock = 0;
  /** Keeps the elapsed time moving without re-rendering the screen. */
  function tickClock() {
    clearInterval(clock);
    if (state.view !== 'working') return;
    clock = setInterval(() => {
      const el = document.getElementById('elapsed');
      if (el) el.textContent = elapsed();
    }, 1000);
  }

  function renderWorking() {
    const current = STAGES.findIndex((s) => s.id === state.stage);
    return h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'triage' },
        h('span', { class: 'badge' }, h('span', { class: 'dot dot-warn' }), h('strong', {}, 'Collecting'), h('span', { class: 'mono', id: 'elapsed' }, elapsed())),
        h('span', { class: 'muted' }, 'Usually about 4 minutes; faster for a second site in the same panel.'),
      ),
      h(
        'div',
        { class: 'pane-body list-page' },
        h('div', { class: 'pane-head' }, h('span', { class: 'eyebrow' }, 'Progress'), h('span', { class: 'count-chip' }, `Step ${Math.max(1, current + 1)} of ${STAGES.length}`)),
        h(
          'ol',
          { class: 'rows steps' },
          STAGES.map((s, i) => {
            const status = i < current ? 'done' : i === current ? 'current' : 'pending';
            return h(
              'li',
              { class: `row step ${status}`, 'aria-current': status === 'current' ? 'step' : null },
              h('span', { class: 'step-mark', 'aria-hidden': 'true' }, status === 'done' ? '✓' : status === 'current' ? '●' : '○'),
              h(
                'span',
                { class: 'row-text' },
                h('span', { class: 'row-title' }, s.label),
                h('span', { class: 'muted small' }, (status !== 'pending' && state.stageDetail[s.id]) || s.hint),
                s.id === 'index' && status === 'current' && state.indexTotal > 0 && h('progress', { class: 'meter', value: state.indexDone, max: state.indexTotal, 'aria-label': 'Org metadata listed' }),
              ),
              h('span', { class: 'muted small' }, status === 'done' ? 'Done' : status === 'current' ? 'In progress' : ''),
            );
          }),
        ),
        h('p', { class: 'muted small pad' }, 'You can keep working in other tabs. This panel updates when the list is ready.'),
      ),
    );
  }

  // ---- results

  function renderResult() {
    const r = state.result;
    const active = activeGroup();
    const notes = r.warnings.length
      ? h('div', { class: 'notes' }, h('details', { class: 'banner banner-warn' }, h('summary', {}, `${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`), h('ul', {}, r.warnings.map((/** @type {string} */ w) => h('li', {}, w)))))
      : null;

    const tab = (/** @type {'groups'|'items'|'xml'} */ pane, /** @type {string} */ label) =>
      h('button', { class: `tab tab-${pane}`, role: 'tab', 'aria-selected': String(state.pane === pane), onclick: () => { state.pane = pane; render(); } }, label);
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, tab('groups', 'Groups'), tab('items', active ? active.label : 'Items'), tab('xml', 'package.xml'));

    const workbench = h('main', { class: 'workbench', 'data-pane': state.pane }, renderGroups(), active && renderItems(active), renderXml(active));
    return [renderTriage(), notes, tabs, workbench];
  }

  function renderTriage() {
    const items = allItems();
    const count = items.filter((i) => i.checked).length;
    const leftOut = items.filter((i) => i.origin === 'scan' && !i.checked).length;
    const none = count === 0;
    const changedSelection = items.some((i) => i.checked !== i.initial);
    const deps = pendingDependencies();
    const busy = !!state.busy;
    return h(
      'div',
      { class: 'triage', id: 'triage' },
      h('span', { class: 'badge' }, h('span', { class: 'dot dot-ok' }), h('strong', {}, `${count} selected`)),
      leftOut > 0 && h('span', { class: 'badge', title: 'Found for this site but not ticked, mostly because the site bundle already covers them.' }, h('span', { class: 'dot dot-idle' }), `${leftOut} left out`),
      count > LARGE_MANIFEST && h('span', { class: 'badge warn-text', title: 'Salesforce retrieves at most 10,000 files in one go.' }, h('span', { class: 'dot dot-warn' }), 'Large manifest: retrieve may need splitting'),
      h('input', {
        id: 'item-filter', class: 'search', type: 'search', placeholder: 'Filter components or reasons…', value: state.itemFilter, 'aria-label': 'Filter components',
        oninput: (/** @type {any} */ e) => {
          state.itemFilter = e.target.value;
          const g = activeGroup();
          if (g) g.limit = PAGE;
          refreshItems();
        },
      }),
      h('span', { class: 'spacer' }),
      busy && h('span', { class: 'muted', role: 'status' }, state.busy),
      h('button', { class: 'secondary', disabled: busy, title: 'List components of any metadata type in the org', onclick: () => vscode.postMessage({ command: 'addFromOrg' }) }, 'Add from org…'),
      deps.length > 0 &&
        h(
          'button',
          { class: 'secondary', disabled: busy, title: 'Scan the components you added by hand and tick what they need (about 20–40 seconds)', onclick: () => vscode.postMessage({ command: 'addDependencies', items: deps.map((i) => ({ type: i.type, name: i.name })) }) },
          `Add dependencies (${deps.length})`,
        ),
      h('button', { class: 'secondary', disabled: none, onclick: () => vscode.postMessage({ command: 'retrieve', selection: selection() }) }, 'Retrieve from org'),
      h('button', { class: 'secondary', disabled: none, onclick: () => vscode.postMessage({ command: 'copy', selection: selection() }) }, 'Copy XML'),
      h('button', { class: 'ghost', disabled: !changedSelection, title: 'Restore the original selection', onclick: () => { items.forEach((i) => (i.checked = i.initial)); refreshItems(); scheduleSave(); } }, 'Reset'),
      h('button', { class: 'primary', disabled: none, onclick: () => vscode.postMessage({ command: 'write', selection: selection() }) }, `Write manifest (${count})`),
    );
  }

  function renderGroups() {
    const q = state.itemFilter.trim().toLowerCase();
    const nameHit = (/** @type {string} */ type) => !q || type.toLowerCase().includes(q) || labelOf(type).toLowerCase().includes(q);
    const groups = state.groups.filter((g) => universe(g).some(matches) || nameHit(g.type) || g.type === state.activeType);
    // Types with nothing loaded yet: listed by name only, fetched from the org when opened.
    const have = new Set(state.groups.map((g) => g.type));
    const others = state.orgTypes.filter((t) => !have.has(t) && nameHit(t)).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    return h(
      'aside',
      { class: 'pane pane-groups', id: 'groups-pane' },
      h('div', { class: 'pane-head' }, h('span', { class: 'eyebrow' }, 'Metadata groups'), h('span', { class: 'count-chip' }, `${state.groups.length} in use`)),
      h(
        'div',
        { class: 'pane-body', id: 'pane-groups', 'data-scroll': true },
        groups.map((g) => {
          const all = universe(g);
          const own = g.items.filter((i) => i.origin === 'scan');
          const checked = all.filter((i) => i.checked).length;
          const unticked = all.length - checked;
          const ownChecked = own.filter((i) => i.checked).length;
          const covered = state.covered.includes(g.type);
          // The group checkbox acts on the site's own items only, never on thousands of org items.
          const box = /** @type {HTMLInputElement} */ (
            h('input', {
              type: 'checkbox', 'aria-label': `Select the site's ${g.label}`, checked: own.length > 0 && ownChecked === own.length, disabled: own.length === 0,
              onchange: (/** @type {any} */ e) => { own.forEach((i) => (i.checked = e.target.checked)); if (g.type === state.activeType) refreshItems(); else refreshChrome(); },
            })
          );
          box.indeterminate = ownChecked > 0 && ownChecked < own.length;
          const isActive = g.type === state.activeType;
          return h(
            'div',
            { class: `group-row${isActive ? ' active' : ''}` },
            box,
            h(
              'button',
              { class: 'group-open', 'aria-current': isActive ? 'true' : null, onclick: () => { state.activeType = g.type; state.pane = 'items'; state.revealXml = true; render(); } },
              h('span', { class: 'group-text' }, h('span', { class: 'group-label' }, g.label), h('span', { class: 'mono muted small' }, g.type)),
              h(
                'span',
                { class: 'group-count' },
                h('span', { class: `mono${checked === 0 ? ' muted' : unticked ? ' partial' : ''}` }, `${checked}/${all.length}`),
                covered && checked === 0 ? h('span', { class: 'muted small' }, 'covered by bundle') : unticked ? h('span', { class: 'muted small' }, `${unticked} unticked`) : null,
              ),
            ),
          );
        }),
        others.length > 0 && h('div', { class: 'divider' }, `Other metadata types in the org (${others.length})`),
        others.map((type) => {
          const loading = state.loadingType === type;
          return h(
            'button',
            {
              class: 'group-lazy', disabled: !!state.busy || loading, title: `List the ${type} components in the org`,
              // The filter that found the type would otherwise hide its components once they load.
              onclick: () => { state.loadingType = type; state.itemFilter = ''; refreshChrome(); vscode.postMessage({ command: 'viewAll', type, open: true }); },
            },
            h('span', { class: 'group-text' }, h('span', { class: 'group-label' }, labelOf(type)), h('span', { class: 'mono muted small' }, type)),
            h('span', { class: 'muted small' }, loading ? 'Listing…' : 'Open'),
          );
        }),
        !groups.length && !others.length && h('p', { class: 'muted pad' }, 'Nothing matches the filter.'),
      ),
    );
  }

  /** @param {Group} g */
  function renderItemsHead(g) {
    const rows = universe(g).filter(matches);
    const ticked = rows.filter((i) => i.checked).length;
    const seg = (/** @type {boolean} */ only, /** @type {string} */ label) =>
      h('button', { class: 'seg', 'aria-pressed': String(state.onlyTicked === only), onclick: () => { state.onlyTicked = only; g.limit = PAGE; refreshItems(); } }, label);
    const time = g.listedAt ? new Date(g.listedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return h(
      'div',
      { class: 'pane-head', id: 'items-head' },
      h('span', { class: 'pane-title' }, g.label),
      h('span', { class: 'spacer' }),
      g.viewAll && h('span', { class: 'muted small' }, `Org list from ${time}`),
      g.viewAll && h('button', { class: 'link small', disabled: !!state.busy, onclick: () => vscode.postMessage({ command: 'viewAll', type: g.type, refresh: true }) }, 'Refresh'),
      g.viewAll
        ? h('button', { class: 'secondary small', title: "Hide org components you have not ticked", onclick: () => { g.viewAll = false; g.limit = PAGE; refreshItems(); } }, 'Site only')
        : h('button', { class: 'secondary small', disabled: !!state.busy, title: `List every ${g.type} in the org so you can add ones the site does not use`, onclick: () => vscode.postMessage({ command: 'viewAll', type: g.type }) }, 'View all in org'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, seg(false, `All (${rows.length})`), seg(true, `Ticked (${ticked})`)),
    );
  }

  /** @param {Group} g */
  function renderSelectAll(g) {
    const rows = shown(g).slice(0, g.limit);
    const checked = rows.filter((i) => i.checked).length;
    const all = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'checkbox', id: 'toggle-visible', checked: rows.length > 0 && checked === rows.length, disabled: !rows.length,
        onchange: (/** @type {any} */ e) => { rows.forEach((i) => (i.checked = e.target.checked)); refreshItems(); scheduleSave(); },
      })
    );
    all.indeterminate = checked > 0 && checked < rows.length;
    return h('label', { class: 'select-all', id: 'items-selectall' }, all, `Select all ${rows.length} shown`);
  }

  /** @param {Group} g */
  function renderItems(g) {
    const rows = shown(g);
    const page = rows.slice(0, g.limit);
    const hasSite = page.some((i) => i.origin === 'scan');
    let dividerDone = false;
    return h(
      'section',
      { class: 'pane pane-items', id: 'items-pane' },
      renderItemsHead(g),
      state.covered.includes(g.type) && h('p', { class: 'caption' }, 'Covered by the site bundle — left out by default. Tick to include.'),
      renderSelectAll(g),
      h(
        'ul',
        { class: 'pane-body items', id: 'pane-items', 'data-scroll': true },
        page.map((i) => {
          const p = reasonParts(i);
          const divider = i.origin === 'org' && !dividerDone;
          if (divider) dividerDone = true;
          return [
            divider && h('li', { class: 'divider' }, hasSite ? 'Other components in the org' : 'Components in the org'),
            h(
              'li',
              {},
              h(
                'label',
                { class: 'item', title: i.reasons.join('\n') },
                h('input', { type: 'checkbox', checked: i.checked, onchange: (/** @type {any} */ e) => { i.checked = e.target.checked; changed(); } }),
                h(
                  'span',
                  { class: 'item-text' },
                  h('span', { class: 'item-name mono' }, i.name),
                  h(
                    'span',
                    { class: 'item-reason' },
                    h('span', { class: `dot ${i.origin === 'org' ? 'dot-idle' : p.direct ? 'dot-direct' : 'dot-indirect'}` }),
                    h('span', { class: 'why' }, p.why + (i.reasons.length > 1 ? ` (+${i.reasons.length - 1} more)` : '')),
                    p.sourceName && h('span', { class: 'source mono' }, p.sourceName),
                  ),
                ),
              ),
            ),
          ];
        }),
        rows.length > page.length &&
          h('li', { class: 'more' }, h('button', { class: 'secondary', onclick: () => { g.limit += PAGE; refreshItems(); } }, `Show ${Math.min(PAGE, rows.length - page.length)} more`), h('span', { class: 'muted small' }, `${rows.length - page.length} not shown. Use the filter to narrow the list.`)),
        !rows.length && h('li', { class: 'muted pad' }, g.items.length ? 'Nothing to show here.' : 'This type has no components in the org.'),
      ),
    );
  }

  /** @param {Group|undefined} active */
  function renderXml(active) {
    /** @type {Map<string, string[]>} */
    const byType = new Map();
    let count = 0;
    for (const i of allItems()) {
      if (!i.checked) continue;
      count++;
      if (!byType.has(i.type)) byType.set(i.type, []);
      /** @type {string[]} */ (byType.get(i.type)).push(i.name);
    }
    /** @type {HTMLElement[]} */
    const lines = [];
    // Indent is a class, not an inline style: the webview's content security policy blocks style attributes.
    const line = (/** @type {number} */ indent, /** @type {boolean} */ isActive, /** @type {any[]} */ ...parts) =>
      lines.push(h('div', { class: `line${isActive ? ' active' : ''}` }, h('span', { class: 'ln' }, String(lines.length + 1)), h('span', { class: `code i${indent}` }, ...parts)));
    const tag = (/** @type {string} */ t) => h('span', { class: 'syn-tag' }, t);

    line(0, false, h('span', { class: 'syn-dim' }, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
    line(0, false, tag('<Package'), ' xmlns=', h('span', { class: 'syn-str' }, '"http://soap.sforce.com/2006/04/metadata"'), tag('>'));
    let truncated = false;
    for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
      const on = !!active && type === active.type;
      const names = /** @type {string[]} */ (byType.get(type)).sort((a, b) => a.localeCompare(b));
      line(1, on, tag('<types>'));
      for (const name of names.slice(0, PREVIEW_MEMBERS)) line(2, on, tag('<members>'), name, tag('</members>'));
      if (names.length > PREVIEW_MEMBERS) {
        truncated = true;
        line(2, on, h('span', { class: 'syn-dim' }, `… ${names.length - PREVIEW_MEMBERS} more members (all are written to the file)`));
      }
      line(2, on, tag('<name>'), h('span', { class: 'syn-type' }, type), tag('</name>'));
      line(1, on, tag('</types>'));
    }
    line(1, false, tag('<version>'), state.result.apiVersion, tag('</version>'));
    line(0, false, tag('</Package>'));

    return h(
      'aside',
      { class: 'pane pane-xml', id: 'xml-pane' },
      h('div', { class: 'pane-head' }, h('span', { class: 'eyebrow' }, 'Manifest preview'), h('span', { class: 'spacer' }), h('span', { class: 'mono muted small' }, truncated ? 'shortened' : `${lines.length} lines`)),
      h('div', { class: 'pane-body xml', id: 'pane-xml', 'data-scroll': true, tabindex: '0', 'aria-label': 'package.xml preview' }, lines),
      h(
        'div',
        { class: 'pane-foot' },
        h(
          'div',
          { class: 'foot-text' },
          h('div', { class: 'mono muted small' }, `manifest/${manifestName()}`),
          h('div', { class: `small ${count ? 'ok' : 'muted'}` }, count ? `Ready to write ${count} components` : 'Tick at least one component.'),
        ),
        h(
          'button',
          { class: 'secondary', disabled: count === 0, title: 'Replace manifest/package.xml instead of writing a site-specific file', onclick: () => vscode.postMessage({ command: 'write', selection: selection(), overwriteDefault: true }) },
          'Overwrite package.xml',
        ),
      ),
    );
  }

  render();
  vscode.postMessage({ command: 'loadSites' });
})();
