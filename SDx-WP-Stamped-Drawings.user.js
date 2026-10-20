// ==UserScript==
// @name         SDX IWP Helper
// @namespace    https://burnsmcd.com
// @version      0.8.1
// @description  Bulk create and update work packages, associate drawing lists, stamp drawing ZIPs, and flag superseded revisions.
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

  const VERSION = '0.8.1';
  const BUTTON_ID = 'sdx-iwp-tools-button';
  const TOOLBAR_ID = 'sdx-iwp-helper-toolbar';
  const MENU_ID = 'sdx-iwp-helper-menu';
  const DOWNLOAD_DIALOG_ID = 'sdx-iwp-download-dialog';
  const BULK_DIALOG_ID = 'sdx-iwp-bulk-dialog';
  const BULK_CREATE_DIALOG_ID = 'sdx-iwp-bulk-create-dialog';
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

  function sidePanelWorkPackage() {
    if (!onWorkPackageResultsPage()) return null;
    const panel = document.querySelector('sda-split-screen-menu');
    if (!panel || panel.querySelector('.resize-panel-collapsed-bar')) return null;
    const title = panel.querySelector('.split-panel-header__title');
    if (!title?.getClientRects().length) return null;
    const name = clean(title.textContent);
    if (!name) return null;
    const row = [...document.querySelectorAll('.k-grid-content-locked tr[data-uid]')]
      .find(candidate => workPackageNameFromRow(candidate) === name);
    if (!row) return null;
    const item = rowData(row);
    const query = currentEntityType();
    return {
      id: clean(item && (item.OBID || item.Id || item.id)),
      name,
      config: item && (item.Config || item.SPFConfigUID) || query && query.config && query.config.key || null,
      status: statusFromGridRow(row, item)
    };
  }

  function updateTargetWorkPackages() {
    if (!onWorkPackageResultsPage()) return [detailWorkPackage()].filter(Boolean);
    const selected = selectedWorkPackages();
    return selected.length ? selected : [sidePanelWorkPackage()].filter(Boolean);
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
    return [...wizard.querySelectorAll('.related-items-panel .k-grid-content tbody tr')]
      .filter(row => row.querySelectorAll('td').length > 2);
  }

  function requiredDocumentsCount(wizard) {
    const tabs = [...wizard.querySelectorAll('[role="tab"], .mat-mdc-tab')];
    const requiredTab = tabs.find(tab => /required documents/i.test(clean(tab.textContent)));
    const count = clean(requiredTab?.textContent).match(/required documents\s*(\d+)/i);
    return count ? Number(count[1]) : null;
  }

  async function waitForRequiredDocumentsLoaded(wizard, description, timeout = 20000) {
    await waitForUi(() => {
      const count = requiredDocumentsCount(wizard);
      if (count === null) return null;
      if (count === 0) return true;
      return wizardRows(wizard).length ? true : null;
    }, description, timeout);
  }

  function wizardCell(row, index) {
    return clean(row.querySelector(`td[data-kendo-grid-column-index="${index}"]`)?.textContent);
  }

  function rowHasExactCellValue(row, value) {
    return [...row.querySelectorAll('td')].some(cell => clean(cell.textContent) === value);
  }

  function rowHasRevisionStatus(row, status) {
    return [...row.querySelectorAll('td')].some(cell => clean(cell.textContent).toLowerCase() === status.toLowerCase());
  }

  function wizardDrawingRows(wizard, name, status) {
    return wizardRows(wizard).filter(row => rowHasExactCellValue(row, name) && rowHasRevisionStatus(row, status));
  }

  function wizardButton(wizard, label) {
    return [...wizard.querySelectorAll('button')].find(button => clean(button.textContent).toLowerCase() === label.toLowerCase());
  }

  function requiredDocumentsUnlinkButton(wizard) {
    // This icon only removes selected Required Documents from the Update draft.
    // The work package Terminate action is outside this dialog and must never be used.
    return [...wizard.querySelectorAll('.related-items-panel button[title="Terminate"]')]
      .find(button => button.querySelector('mat-icon[data-mat-icon-name="unlink"]'));
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
      const findRow = () => [...document.querySelectorAll('.k-grid-content-locked tr[data-uid]')]
        .find(row => workPackageNameFromRow(row) === wp.name);
      const row = findRow();
      const nameCell = row?.querySelector('td[id^="locked_datacell_"][id$="_1"]');
      if (!row || clean(nameCell?.textContent) !== wp.name) {
        throw new Error(`Could not find the SDx results row for ${wp.name}. No update was saved.`);
      }
      if (sidePanelWorkPackage()?.name !== wp.name) {
        const resultRow = [...document.querySelectorAll('.k-grid-content tr[data-uid]')]
          .find(candidate => candidate.dataset.uid === row.dataset.uid);
        const selectionCell = resultRow?.querySelector('td[id^="datacell_"][id$="_0"]');
        clickUi(selectionCell, `${wp.name} results row`);
      }
      await waitForUi(() => document.querySelector('sda-split-screen-menu'), 'results side panel');
      const collapsedPanel = document.querySelector('sda-split-screen-menu .resize-panel-collapsed-bar');
      if (collapsedPanel) {
        clickUi(collapsedPanel.querySelector('.resize-panel-collapsed-bar__icon'), 'side panel expand button');
      }
      await waitForUi(() => {
        if (!onWorkPackageResultsPage()) {
          throw new Error(`SDx left the results page while opening ${wp.name}. No update was saved.`);
        }
        return sidePanelWorkPackage()?.name === wp.name;
      }, `${wp.name} side panel`);
      const findActionsMenu = () => [...document.querySelectorAll('sda-content-menu .content-menu--open')]
        .find(menu => clean(menu.querySelector('header.content-header')?.getAttribute('title')) === wp.name);
      if (!findActionsMenu()) {
        const action = findRow()?.querySelector('td[id^="locked_datacell_"][id$="_0"] .action-cell-button');
        clickUi(action, `${wp.name} results row Actions icon`);
      }
      const actionsMenu = await waitForUi(findActionsMenu, `${wp.name} Actions menu`);
      const updateAction = await waitForUi(() => [...actionsMenu.querySelectorAll('mat-tree-node')]
        .find(node => /^Update(?:…|\.\.\.)$/.test(clean(node.getAttribute('title') || node.textContent))),
      `${wp.name} Update action`);
      clickUi(updateAction, 'Update action');
    } else {
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
    }
    const wizard = await waitForUi(() => {
      const wizard = document.querySelector('sda-edit-obj-modal-view');
      return wizard?.querySelector('input[placeholder="Search Document Revisions"]') ? wizard : null;
    }, 'Update form');
    if (clean(wizard.querySelector('h1')?.textContent) !== `Update ${wp.name}`) {
      throw new Error(`SDx opened the wrong work package Update form. No update was saved.`);
    }
    return wizard;
  }

  function revisionChooserRows(chooser) {
    return [...chooser.querySelectorAll('tr[role="row"][data-kendo-grid-item-index]')];
  }

  async function chooserSearchRows(chooser, name, searchInsideChooser) {
    const previousRows = revisionChooserRows(chooser);
    const previousText = previousRows.map(row => clean(row.textContent)).join('\u0000');
    const started = Date.now();
    if (searchInsideChooser) {
      const input = chooser.querySelector('input[title="Search Document Revisions"]');
      setUiInput(input, name);
      clickUi(input.closest('.search-query')?.querySelector('.search-query__submit button'),
        `revision results search for ${name}`);
    }
    let emptySince = 0;
    const result = await waitForUi(() => {
      if (chooser.querySelector('.k-loading-mask, .k-loading-panel')) {
        emptySince = 0;
        return null;
      }
      const rows = revisionChooserRows(chooser);
      if (rows.some(row => rowHasExactCellValue(row, name))) return { rows };
      const text = rows.map(row => clean(row.textContent)).join('\u0000');
      if (rows.length && (!searchInsideChooser || text !== previousText)) return { rows };
      const empty = chooser.querySelector('.k-grid-norecords');
      if (empty) {
        if (!emptySince) emptySince = Date.now();
        if (Date.now() - emptySince >= 3000 && Date.now() - started >= 5000) {
          return { rows: [] };
        }
      }
      return null;
    }, `revision results for ${name}`, 30000);
    return result.rows;
  }

  async function addCurrentRevisionBatch(wizard, names) {
    const beforeCount = requiredDocumentsCount(wizard);
    if (beforeCount === null) throw new Error('SDx did not show the Required Documents count. The update was canceled.');
    const input = wizard.querySelector('input[placeholder="Search Document Revisions"]');
    setUiInput(input, names[0]);
    const search = input.closest('.search-query')?.querySelector('.search-query__submit button');
    clickUi(search, `revision search for ${names[0]}`);
    const chooser = await waitForUi(revisionChooser, `revision results for ${names[0]}`);
    const selected = [];
    const skipped = [];
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const visibleRows = revisionChooserRows(chooser);
      const alreadyVisible = visibleRows.some(row =>
        rowHasExactCellValue(row, name) && rowHasRevisionStatus(row, 'CURRENT'));
      const rows = alreadyVisible ? visibleRows : await chooserSearchRows(chooser, name, index > 0);
      const exactMatches = rows.filter(row => rowHasExactCellValue(row, name));
      const matches = exactMatches.filter(row => rowHasRevisionStatus(row, 'CURRENT'));
      if (matches.length !== 1) {
        const reason = !rows.length ? 'no revisions found in SDx'
          : !exactMatches.length ? 'no exact Alt Doc Name match in the search results'
          : `${matches.length} CURRENT revisions among ${exactMatches.length} exact matches`;
        skipped.push({ name, reason });
        continue;
      }
      const checkbox = matches[0].querySelector('input[type="checkbox"]');
      if (!checkbox || checkbox.disabled) {
        skipped.push({ name, reason: 'current revision cannot be selected' });
        continue;
      }
      if (!checkbox.checked) clickUi(checkbox, `${name} current revision checkbox`);
      await waitForUi(() => checkbox.checked, `${name} current revision selection`, 10000);
      selected.push(name);
    }
    if (!selected.length) {
      const cancel = [...chooser.querySelectorAll('button')]
        .find(button => clean(button.textContent).toLowerCase() === 'cancel');
      clickUi(cancel, 'revision results Cancel button');
      await waitForUi(() => !revisionChooser(), 'revision chooser to close', 5000);
      return { added: [], skipped };
    }
    const selectedItems = [...chooser.querySelectorAll('button')]
      .find(button => /^selected items(?:\s*\d+)?$/i.test(clean(button.textContent)));
    clickUi(selectedItems, 'Selected Items button');
    await waitForUi(() => {
      const rows = revisionChooserRows(chooser);
      return rows.length === selected.length && selected.every(name =>
        rows.filter(row => rowHasExactCellValue(row, name) && rowHasRevisionStatus(row, 'CURRENT') &&
          row.querySelector('input[type="checkbox"]')?.checked).length === 1);
    }, 'selected current revisions', 20000);
    const add = [...chooser.querySelectorAll('button')].find(button => clean(button.textContent).toUpperCase() === 'ADD');
    await waitForUi(() => add && !add.disabled, 'ADD button for selected drawings', 20000);
    clickUi(add, 'ADD button for selected drawings');
    await waitForUi(() => !revisionChooser(), 'revision chooser to close after adding drawings', 60000);
    await waitForUi(() => {
      const count = requiredDocumentsCount(wizard);
      if (count !== beforeCount + selected.length) return null;
      return count > 100 || selected.every(name => wizardDrawingRows(wizard, name, 'CURRENT').length === 1);
    }, 'selected drawings to appear in the IWP Required Documents draft', 60000);
    return { added: selected, skipped };
  }

  async function addCurrentRevisions(wizard, names) {
    const added = [];
    const skipped = [];
    for (let offset = 0; offset < names.length; offset += 50) {
      const batch = await addCurrentRevisionBatch(wizard, names.slice(offset, offset + 50));
      added.push(...batch.added);
      skipped.push(...batch.skipped);
    }
    return { added, skipped };
  }

  async function addCurrentRevision(wizard, name) {
    const result = await addCurrentRevisions(wizard, [name]);
    if (result.skipped.length) {
      throw new Error(`${name}: ${result.skipped[0].reason}. The update was canceled.`);
    }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === '') quoted = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += char;
    }
    if (quoted) throw new Error('The CSV has an unclosed quoted field.');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseAssociationCsv(text) {
    const rows = parseCsv(text).filter(row => row.some(cell => clean(cell)));
    if (rows.length < 2) throw new Error('The CSV must include the header row and at least one drawing.');
    const header = rows[0].map(cell => clean(cell).toLowerCase());
    const wpColumn = header.indexOf('iwp name');
    const docColumn = header.indexOf('alt doc name');
    if (wpColumn < 0 || docColumn < 0) throw new Error('Required headers are “IWP Name” and “Alt Doc Name”. Download a fresh template if needed.');
    const entries = [];
    const seen = new Set();
    rows.slice(1).forEach((row, index) => {
      const wpName = clean(row[wpColumn]);
      const altDocName = clean(row[docColumn]);
      if (!wpName || !altDocName) throw new Error(`CSV row ${index + 2} needs both an IWP Name and an Alt Doc Name.`);
      const key = `${wpName}\u0000${altDocName}`;
      if (seen.has(key)) throw new Error(`CSV row ${index + 2} duplicates ${wpName} / ${altDocName}.`);
      seen.add(key);
      entries.push({ wpName, altDocName });
    });
    return entries;
  }

  function parseWorkPackageCsv(text) {
    const rows = parseCsv(text).filter(row => row.some(cell => clean(cell)));
    if (rows.length < 2) throw new Error('The CSV must include the header row and at least one work package.');
    const header = rows[0].map(cell => clean(cell).toLowerCase());
    const nameColumn = header.indexOf('package number');
    const descriptionColumn = header.indexOf('package title');
    if (nameColumn < 0 || descriptionColumn < 0) {
      throw new Error('Required headers are “Package Number” and “Package Title”.');
    }
    const entries = [];
    const seen = new Set();
    rows.slice(1).forEach((row, index) => {
      const name = clean(row[nameColumn]);
      const description = clean(row[descriptionColumn]);
      if (!name) throw new Error(`CSV row ${index + 2} needs a Package Number.`);
      if (name.length > 128) throw new Error(`CSV row ${index + 2} has a Package Number longer than 128 characters.`);
      const key = name.toUpperCase();
      if (seen.has(key)) throw new Error(`CSV row ${index + 2} duplicates Package Number “${name}”.`);
      seen.add(key);
      entries.push({ name, description, rowNumber: index + 2 });
    });
    return entries;
  }

  async function findExistingWorkPackageNames(entries, token, config) {
    const existing = new Set();
    const names = entries.map(entry => entry.name);
    for (let offset = 0; offset < names.length; offset += 20) {
      const batch = names.slice(offset, offset + 20);
      const filter = batch.map(name => `Name eq '${name.replace(/'/g, "''")}'`).join(' or ');
      const params = new URLSearchParams({ '$format': 'json', '$top': '500', '$filter': `(${filter})` });
      const data = await apiJson(`${apiBase()}/WorkPackages?${params}`, token, config, { method: 'GET' });
      (Array.isArray(data.value) ? data.value : []).forEach(row => {
        const name = clean(row.Name || row.CI_Name);
        if (name && batch.some(candidate => candidate.toUpperCase() === name.toUpperCase())) existing.add(name.toUpperCase());
      });
    }
    return existing;
  }

  async function createGeneralWorkPackage(entry, token, config) {
    const headers = {
      Accept: 'application/json, application/vnd.intergraph.data+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    if (config) headers.SPFCreateConfigUID = config;
    const response = await fetch(`${apiBase()}/WorkPackages`, {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ Class: 'WorkPackage', Name: entry.name, Description: entry.description })
    });
    if (response.status === 401) throw new Error('SDx rejected the session token. Reload SDx and try again.');
    if (!response.ok) {
      let detail = '';
      try { detail = clean(await response.text()).slice(0, 240); } catch (_) { /* use status only */ }
      throw new Error(`SDx could not create “${entry.name}” (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`);
    }

    const params = new URLSearchParams({ '$format': 'json', '$top': '10', '$filter': `Name eq '${entry.name.replace(/'/g, "''")}'` });
    const data = await apiJson(`${apiBase()}/WorkPackages?${params}`, token, config, { method: 'GET' });
    const matches = (Array.isArray(data.value) ? data.value : []).filter(row =>
      clean(row.Name || row.CI_Name).toUpperCase() === entry.name.toUpperCase());
    if (matches.length !== 1) {
      throw new Error(`SDx accepted the create request for “${entry.name}”, but returned ${matches.length} exact records during verification. Stop and check SDx before retrying this name.`);
    }
    const created = matches[0];
    if (clean(created.Description) !== entry.description) {
      throw new Error(`SDx created “${entry.name}”, but its saved description did not match the CSV. Check the record before retrying.`);
    }
    return created;
  }

  function closeBulkCreateDialog() {
    document.getElementById(BULK_CREATE_DIALOG_ID)?.remove();
  }

  function downloadWorkPackageTemplate() {
    const blob = new Blob(['Package Number,Package Title\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'IWP_Creation_Template.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function openBulkCreateDialog() {
    if (busy || document.getElementById(BULK_CREATE_DIALOG_ID)) return;
    closeMenu();
    if (!onWorkPackageResultsPage()) {
      openPanel();
      setStatus('Open Results: General Work Packages to create IWPs from a CSV.', true);
      return;
    }
    const token = tokenFromSession();
    if (!token) {
      openPanel();
      setStatus('Could not read the SDx session token. Reload SDx and try again.', true);
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = BULK_CREATE_DIALOG_ID;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0008;padding:16px;font:13px/1.4 Arial,sans-serif;';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Create IWPs from CSV');
    dialog.style.cssText = 'width:560px;max-width:100%;max-height:90vh;overflow:auto;background:white;color:#242424;border-radius:5px;box-shadow:0 8px 28px #0005;padding:20px;';
    const heading = document.createElement('h2');
    heading.textContent = 'Create IWPs from CSV';
    heading.style.cssText = 'font:700 18px Arial,sans-serif;margin:0 0 10px;';
    const help = document.createElement('p');
    help.textContent = 'Upload the IWP list. Package Number becomes the SDx Name and Package Title becomes the Description. Existing names are checked in the current project configuration before any records are created.';
    help.style.cssText = 'margin:0 0 12px;';
    const template = document.createElement('button');
    template.type = 'button';
    template.textContent = 'Download CSV template';
    template.style.cssText = 'border:1px solid #2b79d7;border-radius:3px;background:#fff;color:#12579f;padding:7px 10px;font-weight:700;cursor:pointer;margin-bottom:12px;';
    template.addEventListener('click', downloadWorkPackageTemplate);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.csv,text/csv';
    file.setAttribute('aria-label', 'Choose IWP list CSV');
    file.style.cssText = 'display:block;margin:0 0 12px;max-width:100%;';
    const preview = document.createElement('div');
    preview.style.cssText = 'max-height:260px;overflow:auto;border:1px solid #ddd;padding:9px;margin:0 0 12px;white-space:pre-wrap;';
    preview.textContent = 'Choose a CSV to preview its Package Number and Package Title rows.';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'border:1px solid #aaa;border-radius:3px;background:#fff;padding:8px 12px;cursor:pointer;';
    cancel.addEventListener('click', closeBulkCreateDialog);
    const create = document.createElement('button');
    create.type = 'button'; create.textContent = 'Check names'; create.disabled = true;
    create.style.cssText = 'border:1px solid #1d64b7;border-radius:3px;background:#2b79d7;color:white;padding:8px 12px;font-weight:700;cursor:pointer;';
    let entries = null;
    let checked = false;
    file.addEventListener('change', async () => {
      entries = null; checked = false; create.disabled = true; create.textContent = 'Check names';
      const selectedFile = file.files && file.files[0];
      if (!selectedFile) { preview.textContent = 'Choose a CSV to preview its Package Number and Package Title rows.'; return; }
      try {
        entries = parseWorkPackageCsv(await selectedFile.text());
        preview.textContent = `${entries.length} work package${entries.length === 1 ? '' : 's'} will be created:\n\n${entries.map(entry => `${entry.name}${entry.description ? ` — ${entry.description}` : ' — (no description)'}`).join('\n')}`;
        create.disabled = false;
      } catch (error) { preview.textContent = error?.message || String(error); }
    });
    create.addEventListener('click', async () => {
      if (!entries) return;
      if (checked) {
        const names = entries.map(entry => entry.name).join('\n');
        if (!window.confirm(`Create ${entries.length} General Work Package${entries.length === 1 ? '' : 's'} in the current SDx configuration?\n\n${names}\n\nThis will create records in SDx.`)) return;
        const batch = [...entries];
        closeBulkCreateDialog();
        runBulkWorkPackageCreation(batch, token, currentEntityType()?.config?.key || null);
        return;
      }
      create.disabled = true;
      create.textContent = 'Checking…';
      preview.textContent = 'Checking Package Number values against existing work packages in SDx…';
      try {
        const existing = await findExistingWorkPackageNames(entries, token, currentEntityType()?.config?.key || null);
        const duplicates = entries.filter(entry => existing.has(entry.name.toUpperCase()));
        if (duplicates.length) {
          preview.textContent = `No IWPs were created. These Package Number values already exist in SDx:\n\n${duplicates.map(entry => `${entry.name} (CSV row ${entry.rowNumber})`).join('\n')}\n\nRemove or rename those rows, then upload the corrected CSV.`;
          create.textContent = 'Check names again';
          checked = false;
        } else {
          preview.textContent = `All ${entries.length} Package Number values are available in the current SDx configuration. Select Create IWPs to continue.`;
          create.textContent = 'Create IWPs';
          checked = true;
        }
        create.disabled = false;
      } catch (error) {
        preview.textContent = error?.message || String(error);
        create.textContent = 'Check names again';
        create.disabled = false;
      }
    });
    actions.append(cancel, create);
    dialog.append(heading, help, template, file, preview, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closeBulkCreateDialog(); });
    document.body.appendChild(overlay);
    cancel.focus();
  }

  async function runBulkWorkPackageCreation(entries, token, config) {
    if (busy) return;
    busy = true;
    closeMenu();
    updateButton();
    openPanel();
    let created = 0;
    try {
      setStatus('Rechecking Package Number values before creating records…');
      const existing = await findExistingWorkPackageNames(entries, token, config);
      const duplicates = entries.filter(entry => existing.has(entry.name.toUpperCase()));
      if (duplicates.length) {
        throw new Error(`No records were created in this run. These names appeared in SDx after the first check: ${duplicates.map(entry => entry.name).join(', ')}.`);
      }
      for (const entry of entries) {
        setStatus(`Creating ${entry.name} (${created + 1} of ${entries.length})…`);
        await createGeneralWorkPackage(entry, token, config);
        created++;
        setStatus(`Created and verified ${created} of ${entries.length} IWPs.`, false);
      }
      setStatus(`Finished: created and verified all ${created} IWPs. Refresh the SDx results to see them.`, false);
    } catch (error) {
      setStatus(`Stopped after ${created} verified IWP${created === 1 ? '' : 's'}: ${error?.message || String(error)} Do not retry a name until you check it in SDx.`, true);
    } finally {
      busy = false;
      updateButton();
    }
  }

  function downloadAssociationTemplate() {
    const blob = new Blob(['IWP Name,Alt Doc Name\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'IWP_Drawing_Associations_Template.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function associationGroups(entries) {
    const groups = new Map();
    entries.forEach(entry => {
      if (!groups.has(entry.wpName)) groups.set(entry.wpName, []);
      groups.get(entry.wpName).push(entry.altDocName);
    });
    return [...groups].map(([name, altDocNames]) => ({ name, altDocNames }));
  }

  async function findExactBulkWorkPackages(groups, token, config) {
    const names = groups.map(group => group.name);
    const found = new Map();
    for (let offset = 0; offset < names.length; offset += 20) {
      const batch = names.slice(offset, offset + 20);
      const filter = batch.map(name => `Name eq '${name.replace(/'/g, "''")}'`).join(' or ');
      const params = new URLSearchParams({ '$format': 'json', '$top': '500', '$filter': `(${filter})` });
      const data = await apiJson(`${apiBase()}/WorkPackages?${params}`, token, config, { method: 'GET' });
      (Array.isArray(data.value) ? data.value : []).forEach(row => {
        const name = String(row.Name || row.CI_Name || '');
        if (!batch.includes(name)) return;
        const id = clean(row.OBID || row.Id || row.id);
        if (!id) return;
        if (!found.has(name)) found.set(name, []);
        found.get(name).push({ id, name, config: row.Config || row.SPFConfigUID || config });
      });
    }
    const visibleRows = [...document.querySelectorAll('.k-grid-content-locked tr[data-uid]')];
    return groups.map(group => {
      const matches = found.get(group.name) || [];
      const visible = visibleRows.find(row => workPackageNameFromRow(row) === group.name);
      const item = visible && rowData(visible);
      if (matches.length !== 1) return { ...group, error: matches.length ? `More than one exact SDx work package named “${group.name}” was found.` : `No exact IWP name match for “${group.name}”.` };
      if (!visible || !item) return { ...group, error: `“${group.name}” exists in SDx but is not in the current results grid. Show it in Results: General Work Packages, then retry.` };
      const rowId = clean(item.OBID || item.Id || item.id);
      if (rowId && rowId !== matches[0].id) return { ...group, error: `The visible “${group.name}” row does not match the SDx object returned by the exact-name search.` };
      return { ...group, id: matches[0].id, config: item.Config || item.SPFConfigUID || config };
    });
  }

  function closeBulkDialog() {
    document.getElementById(BULK_DIALOG_ID)?.remove();
  }

  function openBulkAssociationDialog() {
    if (busy || document.getElementById(BULK_DIALOG_ID)) return;
    closeMenu();
    if (!onWorkPackageResultsPage()) {
      openPanel();
      setStatus('Open Results: General Work Packages to build drawing associations from a CSV.', true);
      return;
    }
    const token = tokenFromSession();
    if (!token) {
      openPanel();
      setStatus('Could not read the SDx session token. Reload SDx and try again.', true);
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = BULK_DIALOG_ID;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0008;padding:16px;font:13px/1.4 Arial,sans-serif;';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Build drawing associations from CSV');
    dialog.style.cssText = 'width:540px;max-width:100%;max-height:90vh;overflow:auto;background:white;color:#242424;border-radius:5px;box-shadow:0 8px 28px #0005;padding:20px;';
    const heading = document.createElement('h2');
    heading.textContent = 'Build drawing associations';
    heading.style.cssText = 'font:700 18px Arial,sans-serif;margin:0 0 10px;';
    const help = document.createElement('p');
    help.textContent = 'Upload a CSV with one IWP Name and Alt Doc Name pair per row. Repeat an IWP name to associate multiple drawings. Names must match SDx exactly. Missing drawings are skipped and reported before the IWP is saved.';
    help.style.cssText = 'margin:0 0 12px;';
    const template = document.createElement('button');
    template.type = 'button';
    template.textContent = 'Download CSV template';
    template.style.cssText = 'border:1px solid #2b79d7;border-radius:3px;background:#fff;color:#12579f;padding:7px 10px;font-weight:700;cursor:pointer;margin-bottom:12px;';
    template.addEventListener('click', downloadAssociationTemplate);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.csv,text/csv';
    file.setAttribute('aria-label', 'Choose drawing association CSV');
    file.style.cssText = 'display:block;margin:0 0 12px;max-width:100%;';
    const preview = document.createElement('div');
    preview.style.cssText = 'max-height:220px;overflow:auto;border:1px solid #ddd;padding:9px;margin:0 0 12px;white-space:pre-wrap;';
    preview.textContent = 'Choose a CSV to preview its IWP and drawing rows.';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'border:1px solid #aaa;border-radius:3px;background:#fff;padding:8px 12px;cursor:pointer;';
    cancel.addEventListener('click', closeBulkDialog);
    const proceed = document.createElement('button');
    proceed.type = 'button'; proceed.textContent = 'Check IWP names'; proceed.disabled = true;
    proceed.style.cssText = 'border:1px solid #1d64b7;border-radius:3px;background:#2b79d7;color:white;padding:8px 12px;font-weight:700;cursor:pointer;';
    let entries = null;
    let validatedGroups = null;
    file.addEventListener('change', async () => {
      entries = null; validatedGroups = null; proceed.disabled = true; proceed.textContent = 'Check IWP names';
      const selectedFile = file.files && file.files[0];
      if (!selectedFile) { preview.textContent = 'Choose a CSV to preview its IWP and drawing rows.'; return; }
      try {
        entries = parseAssociationCsv(await selectedFile.text());
        const groups = associationGroups(entries);
        const lines = groups.map(group => `${group.name} (${group.altDocNames.length} drawing${group.altDocNames.length === 1 ? '' : 's'})`).join('\n');
        preview.textContent = `${entries.length} drawing row${entries.length === 1 ? '' : 's'} across ${groups.length} IWP${groups.length === 1 ? '' : 's'}:\n\n${lines}`;
        proceed.disabled = false;
      } catch (error) { preview.textContent = error?.message || String(error); }
    });
    proceed.addEventListener('click', async () => {
      if (!entries) return;
      if (validatedGroups) {
        const ready = validatedGroups.filter(group => !group.error);
        if (!ready.length) return;
        closeBulkDialog();
        runBulkAssociations(ready, token);
        return;
      }
      proceed.disabled = true;
      proceed.textContent = 'Checking…';
      preview.textContent = 'Checking exact IWP names in SDx and the current results grid…';
      try {
        validatedGroups = await findExactBulkWorkPackages(associationGroups(entries), token, currentEntityType()?.config?.key || null);
        const missing = validatedGroups.filter(group => group.error);
        if (missing.length) {
          preview.textContent = `No associations were changed. Fix these IWP names or show the matching IWPs in the current results grid, then retry:\n\n${missing.map(group => `• ${group.error}`).join('\n')}`;
          proceed.textContent = 'Check again';
          validatedGroups = null;
        } else {
          preview.textContent = `Found all ${validatedGroups.length} exact IWP name${validatedGroups.length === 1 ? '' : 's'} in SDx and in the current results grid. Select Associate drawings to open each IWP and review its draft before saving.`;
          proceed.textContent = 'Associate drawings';
        }
        proceed.disabled = false;
      } catch (error) {
        preview.textContent = error?.message || String(error);
        proceed.textContent = 'Check again';
        proceed.disabled = false;
      }
    });
    actions.append(cancel, proceed);
    dialog.append(heading, help, template, file, preview, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closeBulkDialog(); });
    document.body.appendChild(overlay);
    cancel.focus();
  }

  async function runBulkAssociations(groups, token) {
    if (busy) return;
    busy = true;
    closeMenu();
    updateButton();
    openPanel();
    document.getElementById(`${PANEL_ID}-log`).replaceChildren();
    let completed = 0;
    let failed = 0;
    let skippedDrawings = 0;
    let canceled = false;
    try {
      for (const group of groups) {
        if (canceled) break;
        let wizard = null;
        let saveAttempted = false;
        try {
          setStatus(`Opening ${group.name}…`);
          wizard = await openUpdateWizard(group);
          await waitForRequiredDocumentsLoaded(wizard, `${group.name} Required Documents list`, 60000);
          const originalCount = requiredDocumentsCount(wizard);
          const toAdd = [];
          const alreadyLinked = [];
          for (const altDocName of group.altDocNames) {
            const linked = wizardDrawingRows(wizard, altDocName, 'CURRENT');
            if (linked.length > 1) throw new Error(`${altDocName}: multiple current revisions are already associated with ${group.name}. This IWP was not saved.`);
            if (linked.length === 1) { alreadyLinked.push(altDocName); continue; }
            toAdd.push(altDocName);
          }
          if (!toAdd.length) {
            await discardWizard(); wizard = null;
            setProgress(`${group.name}: all ${alreadyLinked.length} drawing${alreadyLinked.length === 1 ? '' : 's'} were already associated. No change saved.`);
            completed++;
            continue;
          }
          setStatus(`Selecting ${toAdd.length} current drawing${toAdd.length === 1 ? '' : 's'} for ${group.name}…`);
          const { added, skipped } = await addCurrentRevisions(wizard, toAdd);
          skippedDrawings += skipped.length;
          for (const item of skipped) {
            setProgress(`WARNING: ${group.name}: skipped ${item.name} — ${item.reason}.`);
          }
          if (!added.length) {
            await discardWizard(); wizard = null;
            setProgress(`${group.name}: no new drawings were found to associate. No change saved.`);
            completed++;
            continue;
          }
          setStatus(`Added ${added.length} drawing${added.length === 1 ? '' : 's'} to ${group.name}'s update draft.`);
          setProgress(`${group.name}: added ${added.join(', ')} to the update draft.`);
          const skippedList = skipped.map(item => `${item.name}: ${item.reason}`).join('\n');
          const accepted = window.confirm(`Associate drawings with ${group.name}?\n\n${added.length} current drawing${added.length === 1 ? '' : 's'} will be added to this IWP:\n\n${added.join('\n')}\n\n${skipped.length ? `${skipped.length} drawing${skipped.length === 1 ? '' : 's'} could not be found or selected and will be skipped:\n${skippedList}\n\n` : ''}${alreadyLinked.length ? `${alreadyLinked.length} drawing${alreadyLinked.length === 1 ? '' : 's'} already associated will be skipped.\n\n` : ''}Save this work package update in SDx?`);
          if (!accepted) {
            await discardWizard(); wizard = null;
            canceled = true;
            setProgress(`Canceled at ${group.name}. No changes were saved for this IWP; earlier confirmed IWPs remain saved.`);
            break;
          }
          saveAttempted = true;
          setStatus(`Saving drawing associations for ${group.name}…`);
          clickUi(wizardButton(wizard, 'Update'), 'Update button');
          await waitForUi(() => !document.querySelector('sda-edit-obj-modal-view'), 'Update form to close after save', 60000);
          wizard = null;

          setStatus(`Verifying drawings saved to ${group.name}…`);
          wizard = await openUpdateWizard(group);
          await waitForRequiredDocumentsLoaded(wizard, `${group.name} saved Required Documents list`, 60000);
          const saved = await waitForUi(() => {
            const count = requiredDocumentsCount(wizard);
            if (count !== originalCount + added.length) return null;
            return count > 100 || added.every(name => wizardDrawingRows(wizard, name, 'CURRENT').length === 1);
          }, `${group.name} saved drawing associations`, 60000).catch(() => false);
          await discardWizard();
          wizard = null;
          if (!saved) {
            throw new Error(`SDx closed the Update form, but ${added.join(', ')} was not confirmed in ${group.name}'s saved Required Documents.`);
          }
          completed++;
          setProgress(`${group.name}: saved ${added.length} drawing association${added.length === 1 ? '' : 's'}${alreadyLinked.length ? `; skipped ${alreadyLinked.length} already linked` : ''}${skipped.length ? `; skipped ${skipped.length} not found or selectable` : ''}.`);
        } catch (error) {
          if (wizard?.isConnected) await discardWizard().catch(() => {});
          failed++;
          const outcome = saveAttempted
            ? 'The save was submitted, but SDx did not confirm the saved association; check this IWP before retrying.'
            : 'No changes were saved for this IWP.';
          setProgress(`WARNING: ${group.name}: ${error?.message || String(error)} ${outcome}`);
        }
      }
      const attempted = completed + failed;
      setStatus(canceled
        ? `Canceled after ${attempted} of ${groups.length} IWP${groups.length === 1 ? '' : 's'}.`
        : `Finished: ${completed} IWP${completed === 1 ? '' : 's'} processed; ${failed} failed; ${skippedDrawings} drawing${skippedDrawings === 1 ? '' : 's'} skipped.`,
      failed > 0 || skippedDrawings > 0);
    } finally {
      busy = false;
      updateButton();
    }
  }

  async function updateSupersededDocuments() {
    if (busy) return;
    const selected = updateTargetWorkPackages();
    openPanel();
    document.getElementById(`${PANEL_ID}-log`).replaceChildren();
    if (selected.length !== 1) {
      setStatus('Select exactly one work package, or open its side panel, to update superseded documents.', true);
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
      const obsolete = rows.filter(row => rowHasRevisionStatus(row, 'SUPERSEDED'));
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
      const checkedRows = wizardRows(wizard).filter(row => row.querySelector('input[type="checkbox"]')?.checked);
      if (checkedRows.length !== obsolete.length || checkedRows.some(row => !obsolete.includes(row))) {
        throw new Error('The Update form has other documents selected. The update was canceled.');
      }
      const unlink = requiredDocumentsUnlinkButton(wizard);
      await waitForUi(() => unlink && !unlink.disabled, 'Required Documents unlink control');
      clickUi(unlink, 'Required Documents unlink control');
      await waitForUi(() => wizardRows(wizard).length === rows.length - obsolete.length,
        'superseded revisions to leave the update draft');
      if (wizardRows(wizard).some(row => rowHasRevisionStatus(row, 'SUPERSEDED'))) {
        throw new Error('A superseded revision remains in the draft. The update was canceled.');
      }
      let added = 0;
      for (const name of names) {
        const linkedCurrent = wizardDrawingRows(wizard, name, 'CURRENT');
        if (linkedCurrent.length > 1) throw new Error(`${name}: multiple current revisions are already linked. The update was canceled.`);
        if (!linkedCurrent.length) {
          setStatus(`Finding current revision of ${name}…`);
          await addCurrentRevision(wizard, name);
          added++;
        }
        setProgress(`${name}: current revision found.`);
      }
      if (wizardRows(wizard).length !== rows.length - obsolete.length + added ||
          names.some(name => wizardDrawingRows(wizard, name, 'CURRENT').length !== 1)) {
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

  function documentField(row, names) {
    const wanted = new Set(names.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    const key = Object.keys(row || {}).find(name => wanted.has(name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    return key ? clean(row[key]) : '';
  }

  function wrapPdfText(text, font, size, maxWidth, maxLines = 2) {
    const words = clean(text).split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      let last = lines[maxLines - 1];
      while (last && font.widthOfTextAtSize(`${last}…`, size) > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
    }
    return lines;
  }

  async function createControlledDrawingList(workPackage, pdfs) {
    const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 1224; // 17 in at 72 points per inch
    const pageHeight = 792; // 11 in at 72 points per inch
    const bandWidth = 46;
    const rightNoteWidth = 24;
    const tableLeft = 56;
    const tableRight = pageWidth - rightNoteWidth - 12;
    const tableTop = pageHeight - 28;
    const headerHeight = 34;
    const rowHeight = 23;
    const tableBottom = 34;
    const rowsPerPage = Math.floor((tableTop - headerHeight - tableBottom) / rowHeight);
    const altWidth = (tableRight - tableLeft) * 0.39;
    const titleWidth = (tableRight - tableLeft) * 0.49;
    const columns = [tableLeft, tableLeft + altWidth, tableLeft + altWidth + titleWidth, tableRight];
    const blue = rgb(0.169, 0.475, 0.843); // #2b79d7, matching the helper's SDx blue controls
    const blueLight = rgb(0.86, 0.92, 0.98);
    const black = rgb(0.08, 0.08, 0.08);
    const white = rgb(1, 1, 1);
    const items = pdfs.map(item => {
      const row = item.row || {};
      const fallback = clean(item.fileName).replace(/\.pdf$/i, '');
      return {
        alt: documentField(row, ['Alt Doc Name', 'Alt_Doc_Name', 'AltDocName', 'Alternate Document Name']) || fallback,
        title: documentField(row, ['Drawing Title', 'Drawing_Title', 'Title', 'Description']),
        rev: documentField(row, ['Rev', 'Doc_Rev', 'Revision'])
      };
    });
    const pageCount = Math.max(1, Math.ceil(items.length / rowsPerPage));

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = pdf.addPage([pageWidth, pageHeight]);
      page.drawRectangle({ x: 0, y: 0, width: bandWidth, height: pageHeight, color: blue });
      page.drawText(`CONTROLLED DRAWING LIST: ${clean(workPackage)}`, {
        x: 17, y: pageHeight / 2 - bold.widthOfTextAtSize(`CONTROLLED DRAWING LIST: ${clean(workPackage)}`, 13) / 2,
        size: 13, font: bold, color: white, rotate: degrees(90)
      });
      page.drawRectangle({ x: pageWidth - rightNoteWidth, y: 0, width: rightNoteWidth, height: pageHeight, color: blueLight });
      page.drawText('PRIOR TO APPROVAL SIGNATURE, THIS LIST MUST BE VERIFIED AGAINST THE LATEST DRAWING REV.', {
        x: pageWidth - rightNoteWidth + 7, y: 60, size: 8.5, font: bold, color: blue, rotate: degrees(90)
      });

      const headerBottom = tableTop - headerHeight;
      const start = pageIndex * rowsPerPage;
      const pageItems = items.slice(start, start + rowsPerPage);
      const pageTableBottom = headerBottom - pageItems.length * rowHeight;
      page.drawRectangle({ x: tableLeft, y: headerBottom, width: tableRight - tableLeft, height: headerHeight, color: blueLight });
      for (const x of columns) page.drawLine({ start: { x, y: pageTableBottom }, end: { x, y: tableTop }, thickness: 0.9, color: black });
      page.drawLine({ start: { x: tableLeft, y: tableTop }, end: { x: tableRight, y: tableTop }, thickness: 1.1, color: black });
      page.drawLine({ start: { x: tableLeft, y: headerBottom }, end: { x: tableRight, y: headerBottom }, thickness: 1.1, color: black });
      const headings = ['ALT DOC NAME', 'DRAWING TITLE', 'REV'];
      headings.forEach((heading, i) => page.drawText(heading, {
        x: columns[i] + 7, y: headerBottom + (headerHeight - 10) / 2,
        size: 10, font: bold, color: blue
      }));

      pageItems.forEach((item, rowIndex) => {
        const yTop = headerBottom - rowIndex * rowHeight;
        const yBottom = yTop - rowHeight;
        page.drawLine({ start: { x: tableLeft, y: yBottom }, end: { x: tableRight, y: yBottom }, thickness: 0.65, color: black });
        const textY = yBottom + 7;
        const altSize = Math.min(9.5, Math.max(6.5, 9.5 * (altWidth - 14) / Math.max(altWidth - 14, bold.widthOfTextAtSize(item.alt, 9.5))));
        const revSize = Math.min(9.5, Math.max(6.5, 9.5 * (columns[3] - columns[2] - 14) / Math.max(columns[3] - columns[2] - 14, regular.widthOfTextAtSize(item.rev, 9.5))));
        page.drawText(item.alt, { x: columns[0] + 7, y: textY, size: altSize, font: regular, color: black });
        const titleLines = wrapPdfText(item.title, regular, 8.5, titleWidth - 14, 2);
        const titleStartY = yBottom + (rowHeight - titleLines.length * 9.5) / 2 + 2;
        titleLines.forEach((line, lineIndex) => page.drawText(line, {
          x: columns[1] + 7, y: titleStartY + (titleLines.length - lineIndex - 1) * 9.5,
          size: 8.5, font: regular, color: black
        }));
        page.drawText(item.rev, { x: columns[2] + 7, y: textY, size: revSize, font: regular, color: black });
      });
      page.drawLine({ start: { x: tableLeft, y: pageTableBottom }, end: { x: tableRight, y: pageTableBottom }, thickness: 1.1, color: black });
      page.drawText(`PAGE ${pageIndex + 1} OF ${pageCount}`, {
        x: tableRight - 92, y: 17, size: 8, font: regular, color: black
      });
    }
    return pdf.save();
  }

  async function downloadPackageZip(workPackage, token, config, mode) {
    const wp = workPackage.name;
    if (workPackage.id) workPackageIds.set(packageKey(wp, config), workPackage.id);
    setStatus(`Checking SDx Superseded Documents for ${wp}…`);
    let superseded;
    try {
      superseded = await readSupersededWidget(wp, token, config, true);
    } catch (error) {
      throw new Error(`Could not verify SDx's Superseded Documents count for ${wp}: ${error && error.message || error}. No drawings were stamped or downloaded.`);
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
    setStatus(`Creating controlled drawing list for ${wp}…`);
    const drawingList = await createControlledDrawingList(wp, pdfs);
    zip.file(`${safeFilename(wp)}_Controlled_Drawing_List.pdf`, drawingList);
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

  async function run(mode = 'block', requestedWorkPackages = null) {
    if (busy) return;
    const query = currentEntityType();
    if (!query) {
      openPanel();
      setStatus('Open the Work Packages results list, select one or more WP rows, then run this helper.', true);
      return;
    }
    const workPackages = requestedWorkPackages || targetWorkPackages();
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

  async function openDownloadDialog() {
    if (busy || document.getElementById(DOWNLOAD_DIALOG_ID)) return;
    closeMenu();
    const query = currentEntityType();
    const workPackages = targetWorkPackages();
    const token = tokenFromSession();
    if (!query || !workPackages.length || !token) {
      run('block', workPackages);
      return;
    }
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
    const count = workPackages.length;
    const description = document.createElement('p');
    description.textContent = `Checking SDx Superseded Documents for ${count} selected work package${count === 1 ? '' : 's'}…`;
    description.style.cssText = 'margin:0 0 14px;';
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
    confirm.disabled = true;
    confirm.style.cssText = 'border:1px solid #1d64b7;border-radius:3px;background:#2b79d7;color:white;padding:8px 12px;font-weight:700;cursor:pointer;';
    let override = null;
    confirm.addEventListener('click', () => {
      const mode = override?.checked ? 'all' : 'block';
      closeDownloadDialog();
      run(mode, workPackages);
    });
    actions.append(cancel, confirm);
    dialog.append(heading, description, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closeDownloadDialog(); });
    document.body.appendChild(overlay);
    cancel.focus();

    const superseded = [];
    try {
      for (const wp of workPackages) {
        if (!overlay.isConnected) return;
        description.textContent = `Checking SDx Superseded Documents for ${wp.name}…`;
        if (wp.id) workPackageIds.set(packageKey(wp.name, wp.config), wp.id);
        let report;
        try {
          report = await readSupersededWidget(wp.name, token, wp.config || query.config?.key || null, true);
        } catch (error) {
          throw new Error(`Could not verify the Superseded Documents count for ${wp.name}: ${error?.message || error}. No drawings were downloaded.`);
        }
        if (report.count > 0) superseded.push({ name: wp.name, count: report.count });
      }
      if (!overlay.isConnected) return;
      description.textContent = `${count} work package${count === 1 ? '' : 's'} selected. A separate ZIP will be downloaded for each package.`;
      if (superseded.length) {
        const warning = document.createElement('p');
        warning.textContent = `Superseded documents found: ${superseded.map(item => `${item.name} (${item.count})`).join('; ')}. These packages are blocked unless you choose the override below.`;
        warning.style.cssText = 'padding:10px;margin:0 0 10px;background:#fff2df;border:1px solid #d69b56;border-radius:3px;color:#7c2d12;';
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;gap:9px;align-items:flex-start;padding:11px;background:#fff2df;border:1px solid #d69b56;border-radius:3px;cursor:pointer;';
        override = document.createElement('input');
        override.type = 'checkbox';
        override.style.cssText = 'margin-top:2px;';
        const text = document.createElement('span');
        text.textContent = 'Include superseded PDF revisions for these packages. They will be marked SUPERSEDED across the page. I understand these are out-of-date drawings.';
        label.append(override, text);
        const note = document.createElement('p');
        note.textContent = 'This selection starts unchecked every time you open this dialog.';
        note.style.cssText = 'color:#555;font-size:11px;margin:8px 0 16px;';
        override.addEventListener('change', () => {
          confirm.textContent = override.checked ? 'Include superseded and download' : 'Download stamped drawings';
        });
        dialog.insertBefore(warning, actions);
        dialog.insertBefore(label, actions);
        dialog.insertBefore(note, actions);
        override.focus();
      }
      confirm.disabled = false;
    } catch (error) {
      if (!overlay.isConnected) return;
      description.textContent = error?.message || String(error);
      description.style.color = '#a61b1b';
    }
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
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.textContent = 'Bulk IWP Drawing Association';
    bulk.style.cssText = 'display:flex!important;box-sizing:border-box!important;width:100%!important;height:auto!important;min-height:44px!important;align-items:center;justify-content:center;border:1px solid #2b79d7;border-radius:3px;background:#fff;color:#12579f;padding:9px;cursor:pointer;font:700 13px/1.25 Arial,sans-serif!important;text-align:center;white-space:normal!important;margin-top:8px;';
    bulk.addEventListener('click', openBulkAssociationDialog);
    const bulkHelp = document.createElement('div');
    bulkHelp.textContent = 'Adds matching drawings to each IWP’s Required Documents. Review each IWP’s drawing updates before saving.';
    bulkHelp.style.cssText = 'color:#555;font-size:11px;margin:7px 0 11px;';
    const createIwps = document.createElement('button');
    createIwps.type = 'button';
    createIwps.textContent = 'Bulk Create IWPs from CSV';
    createIwps.style.cssText = 'display:flex!important;box-sizing:border-box!important;width:100%!important;height:auto!important;min-height:44px!important;align-items:center;justify-content:center;border:1px solid #2b79d7;border-radius:3px;background:#fff;color:#12579f;padding:9px;cursor:pointer;font:700 13px/1.25 Arial,sans-serif!important;text-align:center;white-space:normal!important;margin-top:8px;';
    createIwps.addEventListener('click', openBulkCreateDialog);
    const createIwpsHelp = document.createElement('div');
    createIwpsHelp.textContent = 'Creates one General Work Package per CSV row using Package Number and Package Title. Existing names are blocked before creation.';
    createIwpsHelp.style.cssText = 'color:#555;font-size:11px;margin:7px 0 11px;';
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
    menu.appendChild(createIwps);
    menu.appendChild(createIwpsHelp);
    menu.appendChild(bulk);
    menu.appendChild(bulkHelp);

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
