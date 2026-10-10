// ==UserScript==
// @name         SDX IWP Helper
// @namespace    https://burnsmcd.com
// @version      0.6.3
// @description  Stamp drawing ZIPs, flag superseded revisions, and update work package document associations.
// @match        https://*.intergraphsmartcloud.com/*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @updateURL    https://raw.githubusercontent.com/atroedel-BMcD/SDx-IWP-Helper/main/SDx-WP-Stamped-Drawings.user.js
// @downloadURL  https://raw.githubusercontent.com/atroedel-BMcD/SDx-IWP-Helper/main/SDx-WP-Stamped-Drawings.user.js
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  if (window.__sdxWpStampedDrawingsLoaded) return;
  window.__sdxWpStampedDrawingsLoaded = true;
  try { if (window.self !== window.top) return; } catch (_) { return; }

  const VERSION = '0.6.3';
  const BUTTON_ID = 'sdx-iwp-tools-button';
  const TOOLBAR_ID = 'sdx-iwp-helper-toolbar';
  const MENU_ID = 'sdx-iwp-helper-menu';
  const DOWNLOAD_DIALOG_ID = 'sdx-iwp-download-dialog';
  const PANEL_ID = 'sdx-wp-stamped-zip-panel';
  const SETTINGS_KEY = 'sdx-iwp-helper-settings-v1';
  const CHECKBOX_SELECTOR = 'input[type="checkbox"].mdc-checkbox__native-control';
  const PAGE_SIZE = 500;
  const SUPERSEDED_WIDGET_OBID = '7OXE00EA';
  const WORK_PACKAGE_PAGE_OBID = '7OXE00BA';
  const GRID_COUNT_CACHE_MS = 5 * 60 * 1000;
  let busy = false;
  let capturedToken = null;
  let gridSupersededLookupKey = '';
  let gridScanInProgress = false;
  let gridScanCompletedAt = 0;
  const gridSupersededCounts = new Map();
  const workPackageIds = new Map();
  const defaultSettings = {
    planned: { enabled: true, color: '#fff2b3' },
    active: { enabled: true, color: '#f4b6b6' },
    executed: { enabled: true, color: '#f4b6b6' }
  };
  const statuses = ['planned', 'active', 'executed'];
  const settings = loadSettings();

  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function loadSettings() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (_) { /* use defaults */ }
    return Object.fromEntries(statuses.map(status => {
      const stored = saved && saved[status] || {};
      const color = typeof stored.color === 'string' && /^#[0-9a-f]{6}$/i.test(stored.color)
        ? stored.color : defaultSettings[status].color;
      return [status, { enabled: typeof stored.enabled === 'boolean' ? stored.enabled : true, color }];
    }));
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* current page still uses settings */ }
    ensureRowHighlightStyles();
    applyRowHighlights();
  }

  function apiBase() {
    return `${location.origin}/ENR01Server/api/v2/SDA`;
  }

  function tokenFromSession() {
    const found = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key || !/auth/i.test(key)) continue;
        const raw = sessionStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const candidate = parsed && (parsed.authorization || parsed.Authorization || parsed.accessToken || parsed.access_token || parsed.token);
          if (typeof candidate === 'string') found.push(candidate.replace(/^Bearer\s+/i, '').trim());
        } catch (_) {
          found.push(raw.replace(/^Bearer\s+/i, '').trim());
        }
      }
    } catch (_) { /* storage can be unavailable in restricted contexts */ }
    if (capturedToken) found.push(capturedToken);
    const jwt = found.filter(value => value.split('.').length === 3);
    const expiry = value => {
      try {
        const part = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return Number(JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).exp) || 0;
      } catch (_) { return 0; }
    };
    return jwt.sort((a, b) => expiry(b) - expiry(a))[0] || null;
  }

  function captureAuthorization(value) {
    const candidate = String(value || '').replace(/^Bearer\s+/i, '').trim();
    if (candidate.split('.').length === 3) capturedToken = candidate;
  }

  // SDx may keep its access token only in its request headers for some tenant
  // configurations. Observe future same-page requests without changing them.
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const headers = (init && init.headers) || (input && typeof input === 'object' && input.headers);
          if (headers && typeof headers.forEach === 'function') headers.forEach((value, key) => { if (String(key).toLowerCase() === 'authorization') captureAuthorization(value); });
          else if (headers && typeof headers === 'object') Object.keys(headers).forEach(key => { if (key.toLowerCase() === 'authorization') captureAuthorization(headers[key]); });
        } catch (_) { /* preserve SDx request behavior */ }
        return originalFetch.apply(this, arguments);
      };
    }
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'authorization') captureAuthorization(value);
      return originalSetRequestHeader.apply(this, arguments);
    };
  } catch (_) { /* token can still be read from sessionStorage */ }

  async function apiJson(url, token, config, options) {
    const headers = Object.assign({
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${token}`
    }, (options && options.headers) || {});
    if (config) headers.SPFConfigUID = config;
    const response = await fetch(url, Object.assign({}, options || {}, { headers, credentials: 'include' }));
    if (response.status === 401) throw new Error('SDx rejected the session token. Reload SDx and try again.');
    if (!response.ok) throw new Error(`SDx API returned HTTP ${response.status}`);
    return response.json();
  }

  function currentEntityType() {
    try {
      const match = /queryFilter=([^;]+)/.exec(location.hash || '');
      if (!match) return null;
      const query = JSON.parse(decodeURIComponent(match[1]));
      return query.entityType === 'WorkPackages' ? query : null;
    } catch (_) { return null; }
  }

  function onWorkPackageResultsPage() {
    return Boolean(currentEntityType() && /^#\/results(?:;|\/|$)/.test(location.hash || ''));
  }

  function currentConfigKey() {
    const fromQuery = currentEntityType()?.config?.key;
    if (fromQuery) return fromQuery;
    try {
      const match = /;config=([^;/?]+)/.exec(location.hash || '');
      const values = match && JSON.parse(decodeURIComponent(match[1]));
      return Array.isArray(values) && values.length === 1 ? String(values[0]) : null;
    } catch (_) { return null; }
  }

  function getJQueryData(element, key) {
    try {
      const jq = window.jQuery ? window.jQuery(element) : window.$ ? window.$(element) : null;
      return jq && typeof jq.data === 'function' ? jq.data(key) : null;
    } catch (_) { return null; }
  }

  function getKendoGrid(element) {
    const jq = window.jQuery ? window.jQuery(element) : window.$ ? window.$(element) : null;
    return jq && typeof jq.data === 'function' ? jq.data('kendoGrid') : null;
  }

  function rowData(row) {
    const grid = row && row.closest('.k-grid');
    const widget = grid && getKendoGrid(grid);
    if (!widget || typeof widget.dataItem !== 'function') return null;
    try { return widget.dataItem(row) || null; } catch (_) { return null; }
  }

  function statusFromObject(item) {
    if (!item || typeof item !== 'object') return '';
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return '';
      for (const [key, nested] of Object.entries(value)) {
        if (/(status|state|lifecycle)/i.test(key) && typeof nested === 'string') {
          const match = nested.match(/\b(planned|active|executed)\b/i);
          if (match) return match[1].toUpperCase();
        }
        if (nested && typeof nested === 'object') {
          const match = visit(nested, depth + 1);
          if (match) return match;
        }
      }
      return '';
    };
    return visit(item, 0);
  }

  function statusFromRow(row) {
    const text = clean(row && row.innerText);
    const match = text.match(/\b(planned|active|executed)\b/i);
    return match ? match[1].toUpperCase() : '';
  }

  function workPackageNameFromRow(row) {
    const item = rowData(row);
    const fromItem = clean(item && (item.Name || item.CI_Name));
    if (fromItem) return fromItem;
    let nameCell = row && row.querySelector('td[id^="locked_datacell_"][id$="_1"]');
    if (!nameCell && row && row.dataset.uid) {
      const grid = row.closest('.k-grid');
      const lockedTwin = grid && [...grid.querySelectorAll('.k-grid-content-locked tr[data-uid]')].find(twin => twin.dataset.uid === row.dataset.uid);
      nameCell = lockedTwin && lockedTwin.querySelector('td[id^="locked_datacell_"][id$="_1"]');
    }
    return clean(nameCell && nameCell.innerText);
  }

  function statusFromGridRow(row, item) {
    const fromItem = statusFromObject(item);
    if (fromItem) return fromItem;
    if (row) {
      const grid = row.closest('.k-grid');
      const uid = row.dataset.uid;
      const centerTwin = grid && [...grid.querySelectorAll('.k-grid-content tr[data-uid]')].find(twin => twin.dataset.uid === uid);
      const statusCell = centerTwin && centerTwin.querySelector('td[id^="datacell_"][id$="_3"]');
      const status = statusFromRow(statusCell || row);
      if (status) return status;
    }
    return statusFromRow(row);
  }

  function ensureRowHighlightStyles() {
    let style = document.getElementById(`${PANEL_ID}-row-styles`);
    if (!style) {
      style = document.createElement('style');
      style.id = `${PANEL_ID}-row-styles`;
      document.head.appendChild(style);
    }
    const rules = statuses.map(status =>
      `.sdx-iwp-superseded-${status} > td{background:${settings[status].color}!important}`
    ).join('');
    if (style.textContent !== rules) style.textContent = rules;
  }

  function applyRowHighlights() {
    if (!onWorkPackageResultsPage()) return;
    ensureRowHighlightStyles();
    const query = currentEntityType();
    const config = query && query.config && query.config.key || '';
    document.querySelectorAll('.k-grid tr[data-uid]').forEach(row => {
      const name = workPackageNameFromRow(row);
      const record = gridSupersededCounts.get(`${config}:${name}`.toUpperCase());
      const count = record && Date.now() - record.checkedAt < GRID_COUNT_CACHE_MS ? record.count : null;
      const status = statusFromGridRow(row, rowData(row));
      row.classList.remove(...statuses.map(value => `sdx-iwp-superseded-${value}`));
      const option = settings[status.toLowerCase()];
      if (count > 0 && option && option.enabled) row.classList.add(`sdx-iwp-superseded-${status.toLowerCase()}`);
      if (count > 0) row.title = `${name} — ${count} superseded document${count === 1 ? '' : 's'} (${status || 'status unavailable'})`;
      else if (row.title && /superseded document/i.test(row.title)) row.removeAttribute('title');
    });
  }

  function visibleWorkPackageNames() {
    const names = new Set();
    const query = currentEntityType();
    const config = query && query.config && query.config.key || null;
    document.querySelectorAll('.k-grid-content-locked tr[data-uid]').forEach(row => {
      const name = workPackageNameFromRow(row);
      if (!name) return;
      names.add(name);
      const item = rowData(row);
      const id = clean(item && (item.OBID || item.Id || item.id));
      if (id) workPackageIds.set(packageKey(name, config), id);
    });
    return [...names];
  }

  function packageKey(name, config) {
    return `${config || ''}:${clean(name)}`.toUpperCase();
  }

  async function findWorkPackageIds(names, token, config) {
    const unresolved = names.filter(name => !workPackageIds.has(packageKey(name, config)));
    for (let offset = 0; offset < unresolved.length; offset += 25) {
      const batch = unresolved.slice(offset, offset + 25);
      const filter = batch.map(name => `Name eq '${name.replace(/'/g, "''")}'`).join(' or ');
      const params = new URLSearchParams({ '$format': 'json', '$top': '100', '$filter': `(${filter})` });
      const data = await apiJson(`${apiBase()}/WorkPackages?${params}`, token, config, { method: 'GET' });
      const rows = Array.isArray(data.value) ? data.value : [];
      rows.forEach(row => {
        const name = clean(row.Name || row.CI_Name);
        const id = clean(row.OBID || row.Id || row.id);
        if (name && id && batch.some(candidate => candidate.toUpperCase() === name.toUpperCase())) {
          workPackageIds.set(packageKey(name, config), id);
        }
      });
    }
  }

  async function readSupersededWidget(name, token, config, fresh) {
    const key = packageKey(name, config);
    const cached = gridSupersededCounts.get(key);
    if (!fresh && cached && Date.now() - cached.checkedAt < GRID_COUNT_CACHE_MS) return cached;
    await findWorkPackageIds([name], token, config);
    const id = workPackageIds.get(key);
    if (!id) throw new Error(`Could not find SDx object ID for ${name}.`);
    const quotedId = `'${id.replace(/'/g, "''")}'`;
    const body = {
      WidgetOBID: SUPERSEDED_WIDGET_OBID,
      ReturnMetadata: true,
      EnvironmentVariables: {
        "'{{CURRENT_OBJECT_ID}}'": quotedId,
        '{{CURRENT_OBJECT_ID}}': quotedId
      },
      PageOBID: WORK_PACKAGE_PAGE_OBID
    };
    const data = await apiJson(`${apiBase()}/ExecuteDynamicRequest`, token, config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const count = data && data.TotalCount;
    if (!data || data.RequestSuccessful !== true || data.Status !== 'OK' ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`SDx did not return a valid Superseded Documents count for ${name}.`);
    }
    const result = {
      count,
      names: Array.isArray(data.Values) ? data.Values.map(value => clean(value.Name)).filter(Boolean) : [],
      documents: Array.isArray(data.Values) ? data.Values : [],
      checkedAt: Date.now()
    };
    gridSupersededCounts.set(key, result);
    applyRowHighlights();
    return result;
  }

  async function refreshGridSupersededCounts() {
    const query = currentEntityType();
    if (!query || !onWorkPackageResultsPage() || gridScanInProgress) return;
    const config = query.config && query.config.key || null;
    const names = visibleWorkPackageNames();
    const key = `${config || ''}:${names.join('|')}`;
    if (!names.length || (key === gridSupersededLookupKey && Date.now() - gridScanCompletedAt < GRID_COUNT_CACHE_MS)) return;
    const token = tokenFromSession();
    if (!token) return;
    gridScanInProgress = true;
    try {
      await findWorkPackageIds(names, token, config);
      let next = 0;
      const workers = Array.from({ length: Math.min(4, names.length) }, async () => {
        while (next < names.length && onWorkPackageResultsPage()) {
          const name = names[next++];
          try { await readSupersededWidget(name, token, config, false); }
          catch (_) { /* An unknown count never clears a WP for download. */ }
        }
      });
      await Promise.all(workers);
      gridSupersededLookupKey = key;
      gridScanCompletedAt = Date.now();
    } catch (_) {
      // The per-package preflight still runs before any drawing is stamped.
    } finally {
      gridScanInProgress = false;
      applyRowHighlights();
    }
  }

  function selectedWorkPackages() {
    const selected = new Map();
    if (!onWorkPackageResultsPage()) return [];
    document.querySelectorAll(CHECKBOX_SELECTOR).forEach(checkbox => {
      if (!checkbox.checked || checkbox.disabled) return;
      const row = checkbox.closest('tr[data-uid]') || checkbox.closest('tr, [role="row"]');
      if (!row) return;
      const item = rowData(row);
      const name = workPackageNameFromRow(row);
      if (!name) return;
      const query = currentEntityType();
      const config = item && (item.Config || item.SPFConfigUID) || query && query.config && query.config.key || null;
      selected.set(`${config || ''}:${name}`.toUpperCase(), {
        id: String(item && (item.OBID || item.Id) || ''), name,
        config,
        status: statusFromGridRow(row, item)
      });
    });
    return [...selected.values()];
  }

  function detailWorkPackage() {
    const match = /(?:\/detail\/|\/infomap-viewer;obid=)([^;?]+)/.exec(location.hash || '');
    const panelName = clean(document.querySelector('.split-panel-header__title')?.textContent);
    const heading = clean(document.querySelector('h1.shell-topbar__title')?.textContent);
    const name = heading.endsWith(' Details') ? heading.slice(0, -' Details'.length) : panelName;
    if (!match || !name) return null;
    return { id: decodeURIComponent(match[1]), name, config: currentConfigKey() };
  }

  function targetWorkPackages() {
    return onWorkPackageResultsPage() ? selectedWorkPackages() : [detailWorkPackage()].filter(Boolean);
  }

  async function waitForUi(check, description, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const result = check();
      if (result) return result;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for SDx ${description}. No update was saved.`);
  }

  function clickUi(element, description) {
    if (!element) throw new Error(`Could not find SDx ${description}. No update was saved.`);
    if (typeof element.click === 'function') element.click();
    else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function setUiInput(input, value) {
    if (!input) throw new Error('Could not find the SDx document revision search field. No update was saved.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function wizardRows(wizard) {
    return [...wizard.querySelectorAll('.related-items-panel tr[role="row"][data-kendo-grid-item-index]')];
  }

  function wizardCell(row, index) {
    return clean(row.querySelector(`td[data-kendo-grid-column-index="${index}"]`)?.textContent);
  }

  function wizardButton(wizard, label) {
    return [...wizard.querySelectorAll('button')].find(button => clean(button.textContent).toLowerCase() === label.toLowerCase());
  }

  function revisionChooser() {
    return [...document.querySelectorAll('[role="dialog"]')].find(dialog =>
      /Results\s*:\s*Document Revisions/i.test(dialog.querySelector('h1')?.textContent || ''));
  }

  async function discardWizard() {
    const chooser = revisionChooser();
    if (chooser) {
      const cancel = [...chooser.querySelectorAll('button')].find(button => clean(button.textContent) === 'Cancel');
      if (cancel) clickUi(cancel, 'revision results Cancel button');
      await waitForUi(() => !revisionChooser(), 'revision chooser to close', 5000).catch(() => {});
    }
    const wizard = document.querySelector('sda-edit-obj-modal-view');
    if (!wizard) return;
    clickUi(wizardButton(wizard, 'Cancel'), 'Update form Cancel button');
    const yes = await waitForUi(() => [...document.querySelectorAll('button')]
      .find(button => clean(button.textContent) === 'Yes' && button.getBoundingClientRect().width > 0),
    'discard confirmation', 5000).catch(() => null);
    if (yes) clickUi(yes, 'discard confirmation');
  }

  async function openUpdateWizard(wp) {
    if (onWorkPackageResultsPage()) {
      const selected = [...document.querySelectorAll(CHECKBOX_SELECTOR)].find(checkbox => {
        const row = checkbox.closest('tr[data-uid]');
        return checkbox.checked && row && workPackageNameFromRow(row) === wp.name;
      });
      const row = selected?.closest('tr[data-uid]');
      const grid = row?.closest('.k-grid');
      const twin = grid && row?.dataset.uid && [...grid.querySelectorAll('.k-grid-content-locked tr[data-uid]')]
        .find(candidate => candidate.dataset.uid === row.dataset.uid);
      const nameCell = row?.querySelector('td[id^="locked_datacell_"][id$="_1"]') ||
        twin?.querySelector('td[id^="locked_datacell_"][id$="_1"]');
      const nameControl = nameCell?.querySelector('.grid-object__name') || nameCell;
      if (clean(nameControl?.textContent) !== wp.name) {
        throw new Error(`Could not find the selected SDx row for ${wp.name}. No update was saved.`);
      }
      clickUi(nameControl, `${wp.name} results row name`);
      await waitForUi(() => detailWorkPackage()?.name === wp.name, `${wp.name} side panel`);
    }
    const visibleActionIcon = () => [...document.querySelectorAll('image.main-menu-icon')]
      .find(icon => icon.querySelector('title')?.textContent === 'Actions' &&
        icon.closest('g.infomap-container')?.querySelector(':scope > title')?.textContent?.includes(wp.name) &&
        icon.getBoundingClientRect().width > 0);
    if (!visibleActionIcon()) {
      clickUi(document.querySelector('[title="Show Info Map"]'), 'Info Map tab');
    }
    const findUpdateAction = () => [...document.querySelectorAll('mat-tree-node')]
      .find(node => clean(node.textContent) === 'Update…' || clean(node.textContent) === 'Update...');
    if (!findUpdateAction()) {
      const actionIcon = await waitForUi(visibleActionIcon, 'work package Actions icon');
      clickUi(actionIcon, 'work package Actions icon');
    }
    const updateAction = await waitForUi(findUpdateAction, 'Update action');
    clickUi(updateAction, 'Update action');
    return waitForUi(() => {
      const wizard = document.querySelector('sda-edit-obj-modal-view');
      return wizard?.querySelector('input[placeholder="Search Document Revisions"]') ? wizard : null;
    }, 'Update form');
  }

  async function addCurrentRevision(wizard, name) {
    const input = wizard.querySelector('input[placeholder="Search Document Revisions"]');
    setUiInput(input, name);
    const search = input.closest('.search-query')?.querySelector('.search-query__submit button');
    clickUi(search, `revision search for ${name}`);
    const chooser = await waitForUi(revisionChooser, `revision results for ${name}`);
    await waitForUi(() => chooser.querySelectorAll('tr[role="row"][data-kendo-grid-item-index]').length > 0,
      `revision results for ${name}`);
    const matches = [...chooser.querySelectorAll('tr[role="row"][data-kendo-grid-item-index]')]
      .filter(row => wizardCell(row, 1) === name && /^current$/i.test(wizardCell(row, 6)));
    if (matches.length !== 1) {
      throw new Error(`${name}: SDx returned ${matches.length} current revision matches. The update was canceled.`);
    }
    const checkbox = matches[0].querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.disabled) throw new Error(`${name}: current revision cannot be selected. The update was canceled.`);
    if (!checkbox.checked) clickUi(checkbox, `${name} current revision checkbox`);
    const add = [...chooser.querySelectorAll('button')].find(button => clean(button.textContent).toUpperCase() === 'ADD');
    await waitForUi(() => add && !add.disabled, `ADD button for ${name}`);
    clickUi(add, `ADD button for ${name}`);
    await waitForUi(() => !revisionChooser(), 'revision chooser to close');
    await waitForUi(() => wizardRows(wizard).some(row => wizardCell(row, 2) === name && /^current$/i.test(wizardCell(row, 7))),
      `${name} current revision in the update form`);
  }

  async function updateSupersededDocuments() {
    if (busy) return;
    const selected = targetWorkPackages();
    openPanel();
    document.getElementById(`${PANEL_ID}-log`).replaceChildren();
    if (selected.length !== 1) {
      setStatus('Select exactly one work package, or open its detail page, to update superseded documents.', true);
      return;
    }
    const wp = selected[0];
    if (wp.id) workPackageIds.set(packageKey(wp.name, wp.config), wp.id);
    const token = tokenFromSession();
    if (!token) {
      setStatus('Could not read the SDx session token. Reload SDx and try again.', true);
      return;
    }
    busy = true;
    closeMenu();
    updateButton();
    let wizard = null;
    try {
      setStatus(`Checking superseded documents for ${wp.name}…`);
      const report = await readSupersededWidget(wp.name, token, wp.config, true);
      if (!report.count) {
        setStatus(`${wp.name} has no superseded documents to update.`);
        return;
      }
      wizard = await openUpdateWizard(wp);
      const rows = await waitForUi(() => wizardRows(wizard).length ? wizardRows(wizard) : null,
        'required documents');
      const obsolete = rows.filter(row => /^superseded$/i.test(wizardCell(row, 7)));
      if (obsolete.length !== report.count) {
        throw new Error(`${wp.name}: the Update form shows ${obsolete.length} superseded revisions but the SDx indicator shows ${report.count}. The update was canceled.`);
      }
      const names = [...new Set(obsolete.map(row => wizardCell(row, 2)))];
      if (names.some(name => !name)) throw new Error('A superseded revision has no document name. The update was canceled.');
      setProgress(`${wp.name}: found ${obsolete.length} superseded revision${obsolete.length === 1 ? '' : 's'} in the Update form.`);
      for (const row of obsolete) {
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (!checkbox || checkbox.disabled) throw new Error('A superseded revision cannot be unlinked. The update was canceled.');
        if (!checkbox.checked) clickUi(checkbox, 'superseded revision checkbox');
      }
      const terminate = wizardButton(wizard, 'Terminate');
      await waitForUi(() => terminate && !terminate.disabled, 'unlink control');
      clickUi(terminate, 'unlink control');
      await waitForUi(() => wizardRows(wizard).length === rows.length - obsolete.length,
        'superseded revisions to leave the update draft');
      if (wizardRows(wizard).some(row => /^superseded$/i.test(wizardCell(row, 7)))) {
        throw new Error('A superseded revision remains in the draft. The update was canceled.');
      }
      let added = 0;
      for (const name of names) {
        const linkedCurrent = wizardRows(wizard).filter(row => wizardCell(row, 2) === name && /^current$/i.test(wizardCell(row, 7)));
        if (linkedCurrent.length > 1) throw new Error(`${name}: multiple current revisions are already linked. The update was canceled.`);
        if (!linkedCurrent.length) {
          setStatus(`Finding current revision of ${name}…`);
          await addCurrentRevision(wizard, name);
          added++;
        }
        setProgress(`${name}: current revision found.`);
      }
      if (wizardRows(wizard).length !== rows.length - obsolete.length + added ||
          names.some(name => wizardRows(wizard).filter(row => wizardCell(row, 2) === name && /^current$/i.test(wizardCell(row, 7))).length !== 1)) {
        throw new Error('The required documents draft changed unexpectedly. The update was canceled.');
      }
      const accepted = window.confirm(`Update ${wp.name}?\n\n${obsolete.length} superseded revision${obsolete.length === 1 ? '' : 's'} will be unlinked and the current revision of each document will be associated.\n\n${names.join('\n')}\n\nSave this work package update in SDx?`);
      if (!accepted) throw new Error('Canceled. No work package update was saved.');
      clickUi(wizardButton(wizard, 'Update'), 'Update button');
      await waitForUi(() => !document.querySelector('sda-edit-obj-modal-view'), 'Update form to close');
      wizard = null;
      const verified = await readSupersededWidget(wp.name, token, wp.config, true);
      if (verified.count !== 0) throw new Error(`${wp.name} was saved, but SDx still reports ${verified.count} superseded documents. Review it in SDx.`);
      setStatus(`${wp.name} updated. SDx now reports 0 superseded documents.`);
      setProgress(`Replaced ${obsolete.length} superseded revision${obsolete.length === 1 ? '' : 's'} with current revisions.`);
    } catch (error) {
      if (wizard?.isConnected) await discardWizard().catch(() => {});
      setStatus(error?.message || String(error), true);
    } finally {
      busy = false;
      updateButton();
    }
  }

  function safeFilename(name) {
    return clean(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || 'work-package';
  }

  function setStatus(message, isError) {
    const status = document.getElementById(`${PANEL_ID}-status`);
    if (status) {
      status.textContent = message;
      status.style.color = isError ? '#a61b1b' : '#333';
    }
  }

  function setProgress(message) {
    const list = document.getElementById(`${PANEL_ID}-log`);
    if (!list) return;
    const line = document.createElement('div');
    line.textContent = message;
    line.style.cssText = message.includes('WARNING:')
      ? 'padding:6px;margin-top:4px;border-left:4px solid #d97706;background:#fff7df;color:#7c2d12;'
      : 'padding:3px 0;border-top:1px solid #e6e6e6;';
    list.appendChild(line);
  }

  function openPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:20px;bottom:76px;z-index:2147483647;width:390px;max-height:65vh;overflow:auto;background:#fff;color:#222;border:1px solid #bbb;border-radius:8px;box-shadow:0 4px 18px #0003;padding:14px;font:14px/1.4 Arial,sans-serif;';
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:16px"><span>IWP tools · ${VERSION}</span><button type="button" aria-label="Close" style="border:0;background:transparent;font-size:20px;cursor:pointer">×</button></div><div id="${PANEL_ID}-status" style="margin:8px 0">Ready.</div><div id="${PANEL_ID}-log"></div>`;
    panel.querySelector('button').addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
    return panel;
  }

  async function listPackageDocuments(wp, token, config) {
    const rows = [];
    const filter = `WP eq '${wp.replace(/'/g, "''")}'`;
    let skip = 0;
    let total = null;
    for (;;) {
      setStatus(`Reading documents for ${wp}… (${rows.length}${total ? ` / ${total}` : ''})`);
      const url = `${apiBase()}/BMcD_SubContractor_Docs?$format=json&$top=${PAGE_SIZE}&$skip=${skip}&$filter=${encodeURIComponent(filter)}&$count=true`;
      const data = await apiJson(url, token, config, { method: 'GET' });
      const batch = Array.isArray(data.value) ? data.value : [];
      if (total === null) total = Number(data['@odata.count']) || null;
      rows.push(...batch);
      if (!batch.length || (total !== null && rows.length >= total) || batch.length < PAGE_SIZE || skip > 10000) break;
      skip += batch.length;
    }
    return rows;
  }

  async function resolveAttachedFiles(rows, token, config) {
    const map = new Map();
    const documents = rows.map(row => ({ id: row.Id || row.OBID || row.id, config: row.Config || row.SPFConfigUID || config }))
      .filter(row => row.id);
    for (let offset = 0; offset < documents.length; offset += 100) {
      const batch = documents.slice(offset, offset + 100);
      const filter = `(${batch.map(row => `OBID eq '${String(row.id).replace(/'/g, "''")}'`).join(' or ')})`;
      const expand = "SPFFileComposition_21($filter=Interfaces eq 'ISPFBusinessFile' and SPFViewInd eq 'true' or SPFEditInd eq 'true';$skip=0;$top=1;$count=true)";
      const params = new URLSearchParams({ '$filter': filter, '$select': 'Name,OBID', '$expand': expand, '$skip': '0', '$top': '100', '$count': 'true' });
      const data = await apiJson(`${apiBase()}/Objects?${params}`, token, config, { method: 'GET' });
      (data.value || []).forEach(item => {
        const file = Array.isArray(item.SPFFileComposition_21) ? item.SPFFileComposition_21[0] : null;
        if (item.OBID && file && file.OBID) map.set(item.OBID, { obid: file.OBID, name: clean(file.Name || file.CI_Name || item.Name) });
      });
    }
    return map;
  }

  async function retrieveFileUri(fileObid, token, config) {
    const url = `${apiBase()}/Files('${encodeURIComponent(fileObid)}')/Intergraph.SPF.Server.API.Model.RetrieveFileUris`;
    const data = await apiJson(url, token, config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purposes: ['Primary'], downloadFile: true })
    });
    const info = data && Array.isArray(data.value) ? data.value[0] : null;
    if (!info || !(info.Uri || info.URL)) throw new Error('SDx did not return a download URI for a drawing.');
    return info.Uri || info.URL;
  }

  function stampPdfBytes(bytes, wpNumber, isSuperseded) {
    const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;
    return PDFDocument.load(bytes, { ignoreEncryption: false }).then(async pdf => {
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      const label = `WP # ${wpNumber} CONTROLLED`;
      const pages = pdf.getPages();
      for (const page of pages) {
        const { width, height } = page.getSize();
        if (isSuperseded) {
          const watermark = 'SUPERSEDED';
          const angle = Math.atan2(height, width);
          const watermarkSize = Math.hypot(width, height) * 0.72 / font.widthOfTextAtSize(watermark, 1);
          const watermarkWidth = font.widthOfTextAtSize(watermark, watermarkSize);
          const watermarkHeight = font.heightAtSize(watermarkSize);
          const cosine = Math.cos(angle);
          const sine = Math.sin(angle);
          page.drawText(watermark, {
            x: (width - watermarkWidth * cosine + watermarkHeight * sine) / 2,
            y: (height - watermarkWidth * sine - watermarkHeight * cosine) / 2,
            size: watermarkSize,
            font,
            rotate: degrees(angle * 180 / Math.PI),
            color: rgb(0.84, 0.04, 0.08),
            opacity: 0.28
          });
        }
        const margin = Math.max(10, Math.min(24, width * 0.012));
        const fontSize = Math.max(11.55, Math.min(24.15, width * 0.0147));
        const textWidth = font.widthOfTextAtSize(label, fontSize);
        const x = Math.max(margin, width - margin - textWidth);
        const y = Math.max(margin, height - margin - fontSize);
        page.drawText(label, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.84, 0.04, 0.08),
          wordBreaks: []
        });
      }
      return pdf.save();
    });
  }

  async function downloadPackageZip(workPackage, token, config, mode) {
    const wp = workPackage.name;
    if (workPackage.id) workPackageIds.set(packageKey(wp, config), workPackage.id);
    setStatus(`Checking SDx Superseded Documents for ${wp}…`);
    let superseded;
    try {
      superseded = await readSupersededWidget(wp, token, config, true);
    } catch (error) {
      throw new Error(`WARNING: Could not verify SDx's Superseded Documents count for ${wp}: ${error && error.message || error}. No drawings were stamped or downloaded.`);
    }
    if (superseded.count && mode === 'block') {
      throw new Error(`WARNING: ${wp} has ${superseded.count} superseded document${superseded.count === 1 ? '' : 's'}${superseded.names.length ? ` (${superseded.names.slice(0, 5).join(', ')}${superseded.names.length > 5 ? ', …' : ''})` : ''}. No ZIP was created.`);
    }
    if (superseded.count) setProgress(`WARNING: ${wp} has ${superseded.count} superseded document${superseded.count === 1 ? '' : 's'}. Override selected: include superseded versions.`);
    let rows = await listPackageDocuments(wp, token, config);
    if (superseded.count && mode === 'all') {
      const supersededRows = superseded.documents;
      if (supersededRows.length !== superseded.count || supersededRows.some(row => !clean(row.Id || row.OBID || row.id))) {
        throw new Error(`WARNING: SDx reported ${superseded.count} superseded documents for ${wp} but returned only ${supersededRows.length} usable document records. No ZIP was created.`);
      }
      const unique = new Map();
      [...rows, ...supersededRows].forEach(row => unique.set(clean(row.Id || row.OBID || row.id), row));
      rows = [...unique.values()];
    }
    if (!rows.length) {
      throw new Error(`No current drawings were returned for ${wp}. Check the work package's Documents list in SDx.`);
    }
    const zip = new JSZip();
    setStatus(`Finding attached PDFs for ${wp}…`);
    const fileMap = await resolveAttachedFiles(rows, token, config);
    const supersededIds = new Set(superseded.documents.map(row => clean(row.Id || row.OBID || row.id)));
    const pdfs = [];
    for (const row of rows) {
      const id = row.Id || row.OBID || row.id;
      const file = fileMap.get(id);
      const guessName = clean(row.Attached_File || row.Name || 'drawing.pdf');
      const fileName = clean((file && file.name) || guessName);
      if (!/\.pdf$/i.test(fileName)) continue;
      if (file) pdfs.push({ row, file, fileName, isSuperseded: mode === 'all' && supersededIds.has(clean(id)) });
    }
    if (!pdfs.length) throw new Error(`No attached PDF drawings were found for ${wp}. The listed documents may have no downloadable PDF file attached.`);
    if (superseded.count && mode === 'all') {
      const found = new Set(pdfs.map(item => clean(item.row.Id || item.row.OBID || item.row.id)));
      const missing = superseded.documents.filter(row => !found.has(clean(row.Id || row.OBID || row.id)));
      if (missing.length) throw new Error(`WARNING: ${missing.length} superseded document${missing.length === 1 ? '' : 's'} in ${wp} have no downloadable PDF. No ZIP was created.`);
    }
    const used = new Set();
    for (let index = 0; index < pdfs.length; index++) {
      const item = pdfs[index];
      setStatus(`Stamping ${wp}: ${index + 1} of ${pdfs.length} — ${item.fileName}${item.isSuperseded ? ' [SUPERSEDED]' : ''}`);
      const uri = await retrieveFileUri(item.file.obid, token, item.row.Config || item.row.SPFConfigUID || config);
      let response = await fetch(uri, { method: 'GET', credentials: 'include' });
      if (!response.ok) response = await fetch(uri, { method: 'GET', credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Could not download ${item.fileName} (HTTP ${response.status}).`);
      const stamped = await stampPdfBytes(await response.arrayBuffer(), wp, item.isSuperseded);
      let name = item.fileName;
      if (used.has(name.toLowerCase())) {
        const dot = name.toLowerCase().lastIndexOf('.pdf');
        name = `${name.slice(0, dot)}_${index + 1}.pdf`;
      }
      used.add(name.toLowerCase());
      zip.file(name, stamped);
    }
    setStatus(`Building ZIP for ${wp}…`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const filename = `${safeFilename(wp)}_Stamped_Drawings${superseded.count ? '_Including_Superseded' : ''}.zip`;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { count: pdfs.length, supersededCount: pdfs.filter(item => item.isSuperseded).length, filename };
  }

  async function run(mode = 'block') {
    if (busy) return;
    const query = currentEntityType();
    if (!query) {
      openPanel();
      setStatus('Open the Work Packages results list, select one or more WP rows, then run this helper.', true);
      return;
    }
    const workPackages = targetWorkPackages();
    openPanel();
    document.getElementById(`${PANEL_ID}-log`).replaceChildren();
    if (!workPackages.length) {
      setStatus('No selected work packages were detected. Select WP rows in the results list first.', true);
      return;
    }
    const token = tokenFromSession();
    if (!token) {
      setStatus('Could not read the SDx session token. Reload the SDx page and try again.', true);
      return;
    }
    busy = true;
    closeMenu();
    const button = document.getElementById(BUTTON_ID);
    if (button) button.disabled = true;
    let completed = 0;
    try {
      for (const wp of workPackages) {
        try {
          const result = await downloadPackageZip(wp, token, wp.config || query.config?.key || null, mode);
          completed++;
          setProgress(`Downloaded ${result.filename} (${result.count} PDF${result.count === 1 ? '' : 's'}${result.supersededCount ? `; ${result.supersededCount} marked SUPERSEDED` : ''}).`);
          await sleep(900);
        } catch (error) {
          const detail = error && error.message ? error.message : String(error);
          setProgress(`${detail.startsWith('WARNING:') ? '⚠ ' : `${wp.name}: `}${detail}`);
        }
      }
      setStatus(`Finished: ${completed} of ${workPackages.length} work package ZIP${workPackages.length === 1 ? '' : 's'} downloaded.`, completed !== workPackages.length);
    } finally {
      busy = false;
      if (button) button.disabled = false;
      updateButton();
    }
  }

  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(`${MENU_ID}-toggle`)?.setAttribute('aria-expanded', 'false');
  }

  function closeDownloadDialog() {
    document.getElementById(DOWNLOAD_DIALOG_ID)?.remove();
  }

  function openDownloadDialog() {
    if (busy) return;
    closeMenu();
    closeDownloadDialog();
    const overlay = document.createElement('div');
    overlay.id = DOWNLOAD_DIALOG_ID;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0008;padding:16px;font:13px/1.4 Arial,sans-serif;';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Download stamped drawings');
    dialog.style.cssText = 'width:440px;max-width:100%;background:white;color:#242424;border-radius:5px;box-shadow:0 8px 28px #0005;padding:20px;';
    const heading = document.createElement('h2');
    heading.textContent = 'Download stamped drawings';
    heading.style.cssText = 'font:700 18px Arial,sans-serif;margin:0 0 12px;';
    const count = targetWorkPackages().length;
    const description = document.createElement('p');
    description.textContent = `${count} work package${count === 1 ? '' : 's'} selected. A separate ZIP will be downloaded for each package. By default, a package with any superseded documents is blocked.`;
    description.style.cssText = 'margin:0 0 14px;';
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;gap:9px;align-items:flex-start;padding:11px;background:#fff2df;border:1px solid #d69b56;border-radius:3px;cursor:pointer;';
    const override = document.createElement('input');
    override.type = 'checkbox';
    override.style.cssText = 'margin-top:2px;';
    const warning = document.createElement('span');
    warning.textContent = 'Include superseded PDF revisions in this download. They will be marked SUPERSEDED across the page. I understand these are out-of-date drawings.';
    label.append(override, warning);
    const note = document.createElement('p');
    note.textContent = 'This selection starts unchecked every time you open this dialog.';
    note.style.cssText = 'color:#555;font-size:11px;margin:8px 0 16px;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'border:1px solid #aaa;border-radius:3px;background:#fff;padding:8px 12px;cursor:pointer;';
    cancel.addEventListener('click', closeDownloadDialog);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Download stamped drawings';
    confirm.style.cssText = 'border:1px solid #1d64b7;border-radius:3px;background:#2b79d7;color:white;padding:8px 12px;font-weight:700;cursor:pointer;';
    override.addEventListener('change', () => {
      confirm.textContent = override.checked ? 'Include superseded and download' : 'Download stamped drawings';
    });
    confirm.addEventListener('click', () => {
      const mode = override.checked ? 'all' : 'block';
      closeDownloadDialog();
      run(mode);
    });
    actions.append(cancel, confirm);
    dialog.append(heading, description, label, note, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closeDownloadDialog(); });
    document.body.appendChild(overlay);
    override.focus();
  }

  function positionMenu() {
    const menu = document.getElementById(MENU_ID);
    const toggle = document.getElementById(`${MENU_ID}-toggle`);
    if (!menu || !toggle) return;
    const rect = toggle.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.left - menu.offsetWidth + rect.width))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 5)}px`;
  }

  function openMenu() {
    closeMenu();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'SDX IWP Helper options');
    menu.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;width:330px;max-width:calc(100vw - 16px);max-height:calc(100vh - 160px);overflow:auto;background:#fff;color:#242424;border:1px solid #aeb8c2;border-radius:5px;box-shadow:0 5px 20px #0004;padding:14px;font:13px/1.4 Arial,sans-serif;';
    const header = document.createElement('div');
    header.textContent = `SDX IWP Helper · ${VERSION}`;
    header.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:9px;';
    menu.appendChild(header);
    const download = document.createElement('button');
    download.type = 'button';
    download.style.cssText = 'display:flex!important;box-sizing:border-box!important;width:100%!important;height:auto!important;min-height:44px!important;align-items:center;justify-content:center;border:0;border-radius:3px;background:#2b79d7;color:white;padding:9px;cursor:pointer;font:700 13px/1.25 Arial,sans-serif!important;text-align:center;white-space:normal!important;';
    const downloadLabel = document.createElement('span');
    downloadLabel.textContent = 'Stamp & download selected WPs';
    downloadLabel.style.cssText = 'display:block;font:700 13px/1.25 Arial,sans-serif!important;white-space:normal!important;overflow-wrap:anywhere;';
    download.appendChild(downloadLabel);
    download.addEventListener('click', openDownloadDialog);
    menu.appendChild(download);
    const update = document.createElement('button');
    update.type = 'button';
    update.style.cssText = 'display:flex!important;box-sizing:border-box!important;width:100%!important;height:auto!important;min-height:44px!important;align-items:center;justify-content:center;border:1px solid #2b79d7;border-radius:3px;background:#fff;color:#12579f;padding:9px;cursor:pointer;font:700 13px/1.25 Arial,sans-serif!important;text-align:center;white-space:normal!important;margin-top:8px;';
    const updateLabel = document.createElement('span');
    updateLabel.textContent = 'Update superseded documents';
    updateLabel.style.cssText = 'display:block;font:700 13px/1.25 Arial,sans-serif!important;white-space:normal!important;overflow-wrap:anywhere;';
    update.appendChild(updateLabel);
    update.addEventListener('click', updateSupersededDocuments);
    menu.appendChild(update);
    const updateHelp = document.createElement('div');
    updateHelp.textContent = 'Updates one work package at a time. The current revisions are reviewed before SDx saves the change.';
    updateHelp.style.cssText = 'color:#555;font-size:11px;margin:7px 0 11px;';
    menu.appendChild(updateHelp);

    const colorTitle = document.createElement('div');
    colorTitle.textContent = 'Highlight WPs with superseded documents';
    colorTitle.style.cssText = 'font-weight:700;border-top:1px solid #ddd;padding-top:11px;margin-bottom:7px;';
    menu.appendChild(colorTitle);
    statuses.forEach(status => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;';
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;cursor:pointer;text-transform:capitalize;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = settings[status].enabled;
      checkbox.addEventListener('change', () => { settings[status].enabled = checkbox.checked; saveSettings(); });
      label.append(checkbox, document.createTextNode(status));
      const color = document.createElement('input');
      color.type = 'color';
      color.value = settings[status].color;
      color.setAttribute('aria-label', `${status} row color`);
      color.style.cssText = 'width:42px;height:27px;border:1px solid #aaa;padding:0;cursor:pointer;';
      color.addEventListener('input', () => { settings[status].color = color.value; saveSettings(); });
      row.append(label, color);
      menu.appendChild(row);
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset colors';
    reset.style.cssText = 'border:1px solid #aaa;background:#f8f8f8;padding:5px 8px;cursor:pointer;margin-top:5px;';
    reset.addEventListener('click', () => {
      statuses.forEach(status => { settings[status].color = defaultSettings[status].color; });
      saveSettings();
      statuses.forEach((status, index) => { menu.querySelectorAll('input[type="color"]')[index].value = settings[status].color; });
    });
    menu.appendChild(reset);
    document.body.appendChild(menu);
    document.getElementById(`${MENU_ID}-toggle`)?.setAttribute('aria-expanded', 'true');
    positionMenu();
  }

  function updateButton() {
    applyRowHighlights();
    refreshGridSupersededCounts();
    const toolbar = onWorkPackageResultsPage()
      ? document.querySelector('sda-grid-header sda-power-bar-section.power-bar-controls--right')
      : detailWorkPackage()
        ? document.querySelector('header.split-panel-header') || document.querySelector('header.shell-topbar')
        : null;
    let group = document.getElementById(TOOLBAR_ID);
    if (!toolbar) {
      group?.remove();
      closeMenu();
      return;
    }
    if (!group) {
      group = document.createElement('div');
      group.id = TOOLBAR_ID;
      group.style.cssText = 'display:inline-flex;align-items:center;flex:none;margin-right:7px;';
      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.style.cssText = 'height:34px;border:1px solid #1d64b7;border-radius:3px 0 0 3px;padding:0 9px;background:#2b79d7;color:#fff;font:600 12px Arial,sans-serif;white-space:nowrap;cursor:pointer;';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); document.getElementById(MENU_ID) ? closeMenu() : openMenu(); });
      const toggle = document.createElement('button');
      toggle.id = `${MENU_ID}-toggle`;
      toggle.type = 'button';
      toggle.textContent = '▾';
      toggle.setAttribute('aria-label', 'SDX IWP Helper options');
      toggle.setAttribute('aria-haspopup', 'dialog');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.style.cssText = 'height:34px;width:27px;border:1px solid #1d64b7;border-left:1px solid #ffffff55;border-radius:0 3px 3px 0;background:#2b79d7;color:#fff;font:700 15px Arial,sans-serif;cursor:pointer;';
      toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        document.getElementById(MENU_ID) ? closeMenu() : openMenu();
      });
      group.append(button, toggle);
    }
    if (group.parentElement !== toolbar) {
      closeMenu();
      if (onWorkPackageResultsPage()) toolbar.prepend(group);
      else toolbar.appendChild(group);
    }
    group.style.marginLeft = onWorkPackageResultsPage() ? '0' : 'auto';
    const button = document.getElementById(BUTTON_ID);
    if (button.textContent !== 'IWP TOOLS') button.textContent = 'IWP TOOLS';
    button.title = 'Open IWP tools';
    button.disabled = busy;
    positionMenu();
  }

  let refreshTimer = null;
  const observer = new MutationObserver(() => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; updateButton(); }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('change', event => {
    if (event.target && event.target.matches && event.target.matches(CHECKBOX_SELECTOR)) setTimeout(updateButton, 0);
  });
  document.addEventListener('pointerdown', event => {
    const menu = document.getElementById(MENU_ID);
    const group = document.getElementById(TOOLBAR_ID);
    if (menu && !menu.contains(event.target) && !(group && group.contains(event.target))) closeMenu();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); closeDownloadDialog(); } });
  window.addEventListener('resize', positionMenu);
  window.addEventListener('hashchange', updateButton);
  updateButton();
})();
