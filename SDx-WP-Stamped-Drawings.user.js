// ==UserScript==
// @name         SDX IWP Helper

// @namespace    https://burnsmcd.com

// @version      0.3.0
// @description  Flag superseded drawings, highlight affected work packages, and create stamped drawing ZIPs.

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

  const BUTTON_ID = 'sdx-wp-stamped-zip-button';
  const PANEL_ID = 'sdx-wp-stamped-zip-panel';
  const CHECKBOX_SELECTOR = 'input[type="checkbox"].mdc-checkbox__native-control';
  const PAGE_SIZE = 500;
  let busy = false;
  let capturedToken = null;

  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function normalizeKey(key) { return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }

  function positiveCount(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') { const n = Number(value.trim()); return Number.isFinite(n) && n > 0 ? n : 0; }
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) if (/^(count|total|value|length)$/i.test(key)) { const n = positiveCount(nested); if (n) return n; }
    }
    return 0;
  }

  function supersededCountFromObject(item) {
    if (!item || typeof item !== 'object') return null;
    let found = false, count = 0;
    for (const [key, value] of Object.entries(item)) {
      const normalized = normalizeKey(key);
      if (!normalized.includes('supersed')) continue;
      found = true;
      const isCount = /(count|total|number|qty|quantity|documents|drawings)$/.test(normalized) || /^(superseded|issuperseded|hassuperseded)$/.test(normalized);
      if (isCount) count = Math.max(count, positiveCount(value));
      else if (typeof value === 'string' && /supersed|obsolete/i.test(value)) count = Math.max(count, 1);
    }
    return found ? count : null;
  }

  function statusFromObject(item) {
    if (!item || typeof item !== 'object') return '';
    for (const [key, value] of Object.entries(item)) {
      if (!/(status|state|lifecycle)/i.test(key) || typeof value !== 'string') continue;
      const match = value.match(/\b(planned|active|executed)\b/i);
      if (match) return match[1].toUpperCase();
    }
    return '';
  }

  function ensureRowHighlightStyles() {
    if (document.getElementById(`${PANEL_ID}-row-styles`)) return;
    const style = document.createElement('style');
    style.id = `${PANEL_ID}-row-styles`;
    style.textContent = `.sdx-iwp-superseded-planned > td{background:#fff2b3!important}.sdx-iwp-superseded-active > td{background:#f4b6b6!important}`;
    document.head.appendChild(style);
  }

  function applyRowHighlights() {
    if (!currentEntityType()) return;
    ensureRowHighlightStyles();
    document.querySelectorAll('.k-grid tr[data-uid]').forEach(row => {
      const item = rowData(row), count = supersededCountFromObject(item), status = statusFromObject(item);
      row.classList.remove('sdx-iwp-superseded-planned', 'sdx-iwp-superseded-active');
      if (count > 0 && status === 'PLANNED') row.classList.add('sdx-iwp-superseded-planned');
      if (count > 0 && (status === 'ACTIVE' || status === 'EXECUTED')) row.classList.add('sdx-iwp-superseded-active');
      if (count > 0) row.title = `${clean(item && (item.Name || item.CI_Name))} — ${count} superseded drawing${count === 1 ? '' : 's'} (${status || 'status unavailable'})`;
      else if (row.title && /superseded drawing/i.test(row.title)) row.removeAttribute('title');
    });
  }


function selectedWorkPackages() {
    const selected = new Map();
    document.querySelectorAll(CHECKBOX_SELECTOR).forEach(checkbox => {
      if (!checkbox.checked || checkbox.disabled) return;
      const grid = checkbox.closest('.k-grid');
      const widget = grid && getJQueryData(grid, 'kendoGrid');
      if (!widget || typeof widget.dataItem !== 'function') return;
      const row = checkbox.closest('tr[data-uid]') || checkbox.closest('tr, [role="row"]');
      if (!row) return;
      let item = null;
      try { item = widget.dataItem(row); } catch (_) { /* try the paired locked-column row */ }
      if (!item && row.dataset.uid) {
        const twin = grid.querySelector(`tr[data-uid="${CSS.escape(row.dataset.uid)}"]`);
        if (twin) {
          try { item = widget.dataItem(twin); } catch (_) { /* ignored */ }
        }
      }
      if (!item) return;
      const name = clean(item.Name || item.CI_Name);
      const id = item.OBID || item.Id;
      if (!name || !id) return;
      selected.set(`${item.Config || item.SPFConfigUID || ''}:${id}`, {
        id: String(id), name,
        config: item.Config || item.SPFConfigUID || null,
        status: statusFromObject(item),
        supersededCount: supersededCountFromObject(item)

      });
    });
    return [...selected.values()];
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
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:16px"><span>Stamped drawing ZIPs</span><button type="button" aria-label="Close" style="border:0;background:transparent;font-size:20px;cursor:pointer">×</button></div><div id="${PANEL_ID}-status" style="margin:8px 0">Ready.</div><div id="${PANEL_ID}-log"></div>`;
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

  function inspectSupersededDocuments(rows) {
    if (!rows.length) return { verified: true, count: 0, names: [] };
    let statusFieldFound = false;
    const names = [];
    rows.forEach(row => {
      const id = row.Id || row.OBID || row.id || row.Name || 'Unnamed document';
      Object.entries(row).forEach(([key, value]) => {
        if (typeof value === 'string' && /supersed|obsolete/i.test(value)) {
          statusFieldFound = true;
          if (typeof value === 'string' && /supersed|obsolete/i.test(value)) names.push(clean(row.Name || id));
        }
        if (/supersed/i.test(key)) {
          statusFieldFound = true;
          const positive = value === true || (typeof value === 'number' && value > 0) ||
            (typeof value === 'string' && value.trim() !== '' && !/^(false|0|no|null|undefined)$/i.test(value.trim()));
          if (positive) names.push(clean(row.Name || id));
        }
      });
    });
    return { verified: statusFieldFound, count: new Set(names).size, names: [...new Set(names)] };
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

  function stampPdfBytes(bytes, wpNumber) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    return PDFDocument.load(bytes, { ignoreEncryption: false }).then(async pdf => {
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      const label = `WP # ${wpNumber} CONTROLLED`;
      const pages = pdf.getPages();
      for (const page of pages) {
        const { width, height } = page.getSize();
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

  async function downloadPackageZip(workPackage, token, config) {
    const wp = workPackage.name;

    const zip = new JSZip();
    const rows = await listPackageDocuments(wp, token, config);
    if (!rows.length) throw new Error('No documents were returned for this work package.');
    const superseded = inspectSupersededDocuments(rows);
    if (workPackage.supersededCount !== null && workPackage.supersededCount !== undefined) {
      superseded.count = Math.max(superseded.count, Number(workPackage.supersededCount) || 0);
      superseded.verified = true;
    }

    if (!superseded.verified) {
      throw new Error('WARNING: Could not verify superseded-document status from the SDx document list; no drawings were stamped. Please share a work package known to contain a superseded drawing so the check can be matched to its SDx field.');
    }
    if (superseded.count) {
      throw new Error(`WARNING: Found ${superseded.count} superseded drawing${superseded.count === 1 ? '' : 's'} (${superseded.names.slice(0, 5).join(', ')}${superseded.count > 5 ? ', …' : ''}). No ZIP was created.`);
    }
    setStatus(`Finding attached PDFs for ${wp}…`);
    const fileMap = await resolveAttachedFiles(rows, token, config);
    const pdfs = [];
    for (const row of rows) {
      const id = row.Id || row.OBID || row.id;
      const file = fileMap.get(id);
      const guessName = clean(row.Attached_File || row.Name || 'drawing.pdf');
      const fileName = clean((file && file.name) || guessName);
      if (!/\.pdf$/i.test(fileName)) continue;
      if (file) pdfs.push({ row, file, fileName });
    }
    if (!pdfs.length) throw new Error('No attached PDF drawings were found.');
    const used = new Set();
    for (let index = 0; index < pdfs.length; index++) {
      const item = pdfs[index];
      setStatus(`Stamping ${wp}: ${index + 1} of ${pdfs.length} — ${item.fileName}`);
      const uri = await retrieveFileUri(item.file.obid, token, item.row.Config || item.row.SPFConfigUID || config);
      let response = await fetch(uri, { method: 'GET', credentials: 'include' });
      if (!response.ok) response = await fetch(uri, { method: 'GET', credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Could not download ${item.fileName} (HTTP ${response.status}).`);
      const stamped = await stampPdfBytes(await response.arrayBuffer(), wp);
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
    anchor.download = `${safeFilename(wp)}_Stamped_Drawings.zip`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return pdfs.length;
  }

  async function run() {
    if (busy) return;
    const query = currentEntityType();
    if (!query) {
      openPanel();
      setStatus('Open the Work Packages results list, select one or more WP rows, then run this helper.', true);
      return;
    }
    const workPackages = selectedWorkPackages();
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
    const button = document.getElementById(BUTTON_ID);
    if (button) button.disabled = true;
    let completed = 0;
    try {
      for (const wp of workPackages) {
        try {
          const count = await downloadPackageZip(wp, token, wp.config || query.config?.key || null);
          completed++;
          setProgress(`Downloaded ${wp.name}_Stamped_Drawings.zip (${count} PDF${count === 1 ? '' : 's'}).`);
          await sleep(900);
        } catch (error) {
          setProgress(`${error && error.message && error.message.startsWith('WARNING:') ? '⚠ ' : `${wp.name}: `}${error && error.message ? error.message : String(error)}`);
        }
      }
      setStatus(`Finished: ${completed} of ${workPackages.length} work package ZIP${workPackages.length === 1 ? '' : 's'} downloaded.`, completed !== workPackages.length);
    } finally {
      busy = false;
      if (button) button.disabled = false;
      updateButton();
    }
  }

  function updateButton() {
    applyRowHighlights();
    const onWpResults = Boolean(currentEntityType());
    let button = document.getElementById(BUTTON_ID);
    if (!onWpResults) {
      if (button) button.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); run(); }, true);
      button.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;border:0;border-radius:6px;padding:12px 16px;background:#b51f24;color:#fff;font:600 14px Arial,sans-serif;box-shadow:0 2px 8px #0004;cursor:pointer;';
      document.body.appendChild(button);
    }
    const count = selectedWorkPackages().length;
    button.textContent = count ? `Stamp & Download ${count} WP${count === 1 ? '' : 's'}` : 'Stamp & Download WPs';
    button.title = 'Create a separate ZIP of stamped PDF drawings for each selected work package.';
  }

  let refreshTimer = null;
  const observer = new MutationObserver(() => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; updateButton(); }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', updateButton);
  updateButton();
})();
