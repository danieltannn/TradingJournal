'use strict';

// ── GitHub Config (edit these to match your repo) ──────────────────────────
const GH_OWNER    = 'danieltannn';
const GH_REPO     = 'TradingJournal';
const GH_BRANCH   = 'main';
const GH_FILEPATH     = 'data.json';
const GH_SGD_FILEPATH = 'sgd.json';
const GH_IB_FILEPATH  = 'ib.json';

// ── State ──────────────────────────────────────────────────────────────────
let allData    = [];
let processed  = null;
let activeTab  = 0;
let activeMode = 'trading'; // 'trading' | 'investing'
let pages      = {};
let ghToken    = localStorage.getItem('gh_token') || '';
let ghFileSha  = null; // needed by GitHub API to update an existing file
let sgdData    = [];   // SGD deposit records
let sgdFileSha = null; // SHA for sgd.json
let ibData     = { trades: [], openPositions: {}, dividends: [], optionTrades: [], assignmentStocks: [], sgdDeposits: [], forexTrades: [], corporateActions: [] };
let ibFileSha  = null; // SHA for ib.json

const TABS = [
  { label: 'Summary',    icon: 'ti-layout-dashboard' },
  { label: 'Deposits',   icon: 'ti-wallet' },
  { label: 'Trades',     icon: 'ti-arrows-exchange' },
  { label: 'All Ledger', icon: 'ti-list' },
];

// ── Utility ────────────────────────────────────────────────────────────────
function parseVal(s) {
  if (!s || s === '--') return 0;
  return parseFloat(String(s).replace(/[,$]/g, '')) || 0;
}
function fmt(n, dec = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n).toFixed(dec);
  const [int, frac] = abs.split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '$' + (frac !== undefined ? intFmt + '.' + frac : intFmt);
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}
function el(id) { return document.getElementById(id); }
function rowHash(r) {
  const key = [r['Date'], r['Type'], r['Sub Type'], r['Action'],
    r['Symbol'], r['Value'], r['Quantity'], r['Total']].join('|');
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h) + key.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ── Status bar ─────────────────────────────────────────────────────────────
function setStatus(type, msg) {
  const bar = el('statusBar');
  if (!bar) return;
  const icons = { loading: 'ti-loader-2', ok: 'ti-circle-check', warn: 'ti-alert-circle', error: 'ti-circle-x' };
  bar.innerHTML = `<i class="ti ${icons[type] || 'ti-info-circle'} ${type === 'loading' ? 'spin' : ''}" aria-hidden="true"></i> ${msg}`;
  bar.className = `status-bar status-${type}`;
  bar.style.display = 'flex';
}
function hideStatus() {
  const b = el('statusBar');
  if (!b) return;
  b.style.display = 'none';
}

// ── Token panel ────────────────────────────────────────────────────────────
let _tokenOnSave = null;

function showTokenModal(onSave) {
  _tokenOnSave = onSave;
  el('tokenInput').value = ghToken;
  el('tokenPanel').hidden = false;
  el('tokenInput').focus();
  window.scrollTo(0, 0);
}

function hideTokenPanel() {
  el('tokenPanel').hidden = true;
}

function doTokenSave() {
  const t = el('tokenInput').value.trim();
  if (!t) {
    el('tokenInput').style.outline = '2px solid var(--red)';
    return;
  }
  el('tokenInput').style.outline = '';
  ghToken = t;
  localStorage.setItem('gh_token', t);
  hideTokenPanel();
  if (_tokenOnSave) _tokenOnSave();
}

// ── GitHub API ─────────────────────────────────────────────────────────────
function ghHeaders() {
  return {
    'Authorization': `Bearer ${ghToken}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function ghGetFile() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILEPATH}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  ghFileSha = data.sha;
  const json = JSON.parse(atob(data.content.replace(/\n/g, '')));
  return json;
}

async function ghPutFile(content) {
  const url  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILEPATH}`;
  const body = {
    message: `Update data.json — ${new Date().toISOString().slice(0, 10)}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
    branch:  GH_BRANCH,
  };
  if (ghFileSha) body.sha = ghFileSha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub write error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  ghFileSha = data.content.sha;
}

// ── SGD GitHub file ───────────────────────────────────────────────────────
async function ghGetSgd() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_SGD_FILEPATH}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  const data = await res.json();
  sgdFileSha = data.sha;
  return JSON.parse(atob(data.content.replace(/\n/g, '')));
}

async function ghPutSgd(sgdRows) {
  const url  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_SGD_FILEPATH}`;
  const body = {
    message: `Update sgd.json — ${new Date().toISOString().slice(0, 10)}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(sgdRows, null, 2)))),
    branch:  GH_BRANCH,
  };
  if (sgdFileSha) body.sha = sgdFileSha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub SGD write error ${res.status}`);
  const data = await res.json();
  sgdFileSha = data.content.sha;
  sgdData = sgdRows;
}

// ── IB GitHub file ────────────────────────────────────────────────────────
async function ghGetIb() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_IB_FILEPATH}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { trades: [], openPositions: {}, dividends: [] };
  if (!res.ok) return { trades: [], openPositions: {}, dividends: [] };
  const data = await res.json();
  ibFileSha = data.sha;
  return JSON.parse(atob(data.content.replace(/\n/g, '')));
}

async function ghPutIb(ibPayload) {
  const url  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_IB_FILEPATH}`;
  const body = {
    message: `Update ib.json — ${new Date().toISOString().slice(0, 10)}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(ibPayload, null, 2)))),
    branch:  GH_BRANCH,
  };
  if (ibFileSha) body.sha = ibFileSha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub IB write error ${res.status}`);
  const data = await res.json();
  ibFileSha = data.content.sha;
  ibData = ibPayload;
}

// ── CSV parser ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const cols = [];
    let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cols.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').replace(/"/g, '').trim(); });
    return obj;
  }).filter(r => r['Date']);
}

// ── Load from GitHub ───────────────────────────────────────────────────────
async function loadFromGitHub() {
  if (!GH_OWNER || !GH_REPO) {
    setStatus('error', 'Set GH_OWNER and GH_REPO at the top of app.js before using the app.');
    el('uploadZone').hidden = false;
    return;
  }

  if (!ghToken) {
    // No token — try public raw fetch (works if repo is public and data.json exists)
    setStatus('loading', 'Loading data…');
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_FILEPATH}?t=${Date.now()}`);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          allData = json; processed = processData(allData);
          try {
            const sr = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_SGD_FILEPATH}?t=${Date.now()}`);
            if (sr.ok) sgdData = await sr.json();
          } catch(_) {}
          try {
            const ir = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_IB_FILEPATH}?t=${Date.now()}`);
            if (ir.ok) ibData = await ir.json();
          } catch(_) {}
          showDashboard(); setTimeout(hideStatus, 0); return;
        }
      }
    } catch (_) {}
    hideStatus();
    // Prompt for token so we can try authenticated
    setStatus('warn', 'No data found yet. Add your GitHub token to get started.');
    el('uploadZone').hidden = false;
    return;
  }

  setStatus('loading', 'Loading your trade data from GitHub…');
  try {
    const json = await ghGetFile();
    if (json && Array.isArray(json) && json.length > 0) {
      allData = json; processed = processData(allData);
      sgdData = await ghGetSgd();
      ibData  = await ghGetIb();
      showDashboard();
      setTimeout(hideStatus, 0);
    } else {
      setStatus('ok', '✓ Token saved! No data file yet — upload your CSV below to get started.');
      el('uploadZone').hidden = false;
      el('dashboard').hidden = true;
      window.scrollTo(0, 0);
    }
  } catch (e) {
    setStatus('error', `Could not load from GitHub: ${e.message}`);
    el('uploadZone').hidden = false;
    window.scrollTo(0, 0);
  }
}

// ── Merge CSV + commit ─────────────────────────────────────────────────────
async function mergeAndCommit(csvText) {
  const doMerge = async () => {
    const newRows = parseCSV(csvText);
    const existingHashes = new Set(allData.map(r => r._hash || rowHash(r)));
    const toAdd   = newRows.filter(r => !existingHashes.has(rowHash(r)));
    const skipped = newRows.length - toAdd.length;

    if (toAdd.length === 0) {
      setStatus('warn', `No new rows — all ${newRows.length} transactions already saved.`);
      if (allData.length > 0) showDashboard();
      return;
    }

    const merged = [...allData, ...toAdd.map(r => ({ ...r, _hash: rowHash(r) }))];

    setStatus('loading', `Saving ${toAdd.length} new row${toAdd.length !== 1 ? 's' : ''} to GitHub…`);
    try {
      await ghPutFile(merged);
      allData   = merged;
      processed = processData(allData);
      setStatus('ok',
        `✓ ${toAdd.length} new row${toAdd.length !== 1 ? 's' : ''} saved` +
        (skipped > 0 ? ` · ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped` : '')
      );
      showDashboard();
      setTimeout(hideStatus, 5000);
    } catch (e) {
      setStatus('error', `GitHub save failed: ${e.message} — check your token and repo settings.`);
    }
  };

  if (!ghToken) {
    showTokenModal(doMerge);
  } else {
    await doMerge();
  }
}

// ── Data processing ────────────────────────────────────────────────────────
function processData(rows) {
  const deposits  = rows.filter(r => r['Type'] === 'Money Movement');
  const tradeRows = rows.filter(r => r['Type'] === 'Trade');
  const expiries  = rows.filter(r => r['Type'] === 'Receive Deliver' && r['Sub Type'] === 'Expiration');

  const orderMap = {};
  tradeRows.forEach(r => {
    const oid = r['Order #'] || r['Order Number'] || '';
    if (!oid) return;
    if (!orderMap[oid]) orderMap[oid] = [];
    orderMap[oid].push(r);
  });

  // Classify each order: 'open', 'close', or 'roll' (has both open + close legs)
  const orderType = {};
  Object.entries(orderMap).forEach(([oid, legs]) => {
    const hasOpen  = legs.some(l => l['Action'].includes('OPEN'));
    const hasClose = legs.some(l => l['Action'].includes('CLOSE'));
    orderType[oid] = hasOpen && hasClose ? 'roll'
                   : hasOpen             ? 'open'
                   :                       'close';
  });

  // Map each symbol → its originating open order
  const symToOpenOrder = {};
  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (orderType[oid] === 'open')
      legs.forEach(l => { symToOpenOrder[l['Symbol']] = oid; });
  });

  // Also map roll open legs to their new open order
  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (orderType[oid] === 'roll') {
      legs.filter(l => l['Action'].includes('OPEN'))
          .forEach(l => { symToOpenOrder[l['Symbol']] = oid; });
    }
  });

  // Link close orders → parent open order
  const openToCloseOrders = {};
  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (orderType[oid] !== 'close') return;
    legs.forEach(l => {
      const parent = symToOpenOrder[l['Symbol']];
      if (!parent) return;
      if (!openToCloseOrders[parent]) openToCloseOrders[parent] = [];
      if (!openToCloseOrders[parent].includes(oid)) openToCloseOrders[parent].push(oid);
    });
  });

  // Link roll CLOSE legs → their parent open order
  // (so the original position shows the roll-close legs as its close)
  const openToRollClose = {};   // parent oid → [roll oid, ...]
  const rollFrom = {};          // roll oid → parent oid (what it rolled from)
  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (orderType[oid] !== 'roll') return;
    legs.filter(l => l['Action'].includes('CLOSE')).forEach(l => {
      const parent = symToOpenOrder[l['Symbol']];
      if (!parent || parent === oid) return;
      if (!openToRollClose[parent]) openToRollClose[parent] = [];
      if (!openToRollClose[parent].includes(oid)) openToRollClose[parent].push(oid);
      rollFrom[oid] = parent;
    });
  });

  const openToExpiries = {};
  expiries.forEach(exp => {
    const parent = symToOpenOrder[exp['Symbol']];
    if (!parent) return;
    if (!openToExpiries[parent]) openToExpiries[parent] = [];
    openToExpiries[parent].push(exp);
  });

  const positions = [];
  Object.entries(orderMap).forEach(([oid, legs]) => {
    const type     = orderType[oid];
    const openLegs = legs.filter(l => l['Action'].includes('OPEN'));
    if (!openLegs.length) return;  // pure-close orders have no open legs → skip

    const closeOids   = openToCloseOrders[oid] || [];
    const rollCloseOids = openToRollClose[oid] || [];
    const expiryRows  = openToExpiries[oid] || [];
    const closeLegs   = closeOids.flatMap(cid => orderMap[cid] || []);
    const rollCloseLegs = rollCloseOids.flatMap(rid => (orderMap[rid] || []).filter(l => l['Action'].includes('CLOSE')));
    const allCloseLegs = [...closeLegs, ...rollCloseLegs];
    const isClosed    = allCloseLegs.length > 0 || expiryRows.length > 0;
    const isExpired   = expiryRows.length > 0;
    const isRoll      = type === 'roll';
    const rolledFromOid = rollFrom[oid] || null;

    // For a roll, include BOTH the close legs (old spread) and open legs (new spread)
    const allLegsForCard = isRoll ? legs : openLegs;

    const sample    = openLegs[0];
    const openDate  = openLegs.reduce((m, l) => l['Date'] < m ? l['Date'] : m, openLegs[0]['Date']);
    const allClose  = [...allCloseLegs, ...expiryRows];
    const closeDate = allClose.length ? allClose.reduce((m, l) => l['Date'] < m ? l['Date'] : m, allClose[0]['Date']) : null;
    const openTotal = openLegs.reduce((s, l) => s + parseVal(l['Total']), 0);

    // For rolls: closeTotal = sum of the CLOSE legs inside the roll order
    const rollCloseTotal = isRoll
      ? legs.filter(l => l['Action'].includes('CLOSE')).reduce((s, l) => s + parseVal(l['Total']), 0)
      : 0;
    const regularCloseTotal = [...closeLegs, ...expiryRows].reduce((s, l) => s + parseVal(l['Total']), 0);
    const closeTotal = regularCloseTotal + rollCloseTotal;

    positions.push({
      oid, ul: sample['Underlying Symbol'] || sample['Root Symbol'] || '—',
      expDate: sample['Expiration Date'] || '—', openDate, closeDate,
      isClosed, isExpired, isRoll, rolledFromOid,
      openLegs, closeLegs: allCloseLegs, expiryRows, allLegsForCard,
      openTotal, closeTotal, netPnl: openTotal + closeTotal
    });
  });

  positions.sort((a, b) => {
    if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
    const da = a.isClosed ? a.closeDate : a.openDate;
    const db = b.isClosed ? b.closeDate : b.openDate;
    return da > db ? -1 : da < db ? 1 : 0;
  });

  const totalDeposits = deposits.filter(r => r['Sub Type'] === 'Deposit').reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalInterest = deposits.filter(r => r['Sub Type'] === 'Credit Interest').reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalAdj      = deposits.filter(r => r['Sub Type'] === 'Balance Adjustment').reduce((s, r) => s + parseVal(r['Total']), 0);
  const tradePnl      = tradeRows.reduce((s, r) => s + parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees'])), 0);
  const balance       = totalDeposits + totalInterest + totalAdj + tradePnl;

  return { deposits, tradeRows, expiries, positions, balance, totalDeposits };
}

// ── Show dashboard ─────────────────────────────────────────────────────────
function showDashboard() {
  el('uploadZone').hidden = true;
  el('dashboard').hidden  = false;
  renderModeBar();
  renderForMode();
}

function renderModeBar() {
  let bar = el('modeBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'modeBar';
    bar.className = 'mode-bar';
    el('dashboard').insertBefore(bar, el('dashboard').firstChild);
  }
  bar.innerHTML = `
    <button class="mode-btn ${activeMode === 'trading'   ? 'active' : ''}" onclick="switchMode('trading')">
      <i class="ti ti-arrows-exchange" aria-hidden="true"></i> Trading
    </button>
    <button class="mode-btn ${activeMode === 'investing' ? 'active' : ''}" onclick="switchMode('investing')">
      <i class="ti ti-trending-up" aria-hidden="true"></i> Investing
    </button>`;
}

function renderForMode() {
  const metricsRow = el('metricsRow');
  const tabBar     = el('tabBar');
  if (activeMode === 'trading') {
    metricsRow.style.display = '';
    tabBar.style.display     = '';
    renderMetrics();
    renderTabs();
  } else {
    metricsRow.style.display = 'none';
    tabBar.style.display     = 'none';
  }
  renderTabContent();
}

// ── Metrics ────────────────────────────────────────────────────────────────
function renderMetrics() {
  const { positions, balance, totalDeposits } = processed;
  const closed    = positions.filter(p => p.isClosed);
  const open      = positions.filter(p => !p.isClosed);
  const closedPnl = closed.reduce((s, p) => s + p.netPnl, 0);
  const winners   = closed.filter(p => p.netPnl > 0).length;
  const winRate   = closed.length ? Math.round(winners / closed.length * 100) : 0;
  el('metricsRow').innerHTML = [
    { label: 'Account Balance',  value: fmt(balance),       cls: balance   >= 0 ? 'pos' : 'neg' },
    { label: 'Total Deposited',  value: fmt(totalDeposits), cls: '' },
    { label: 'Closed P&L',      value: fmt(closedPnl),     cls: closedPnl >= 0 ? 'pos' : 'neg' },
    { label: 'Open Positions',   value: open.length,        cls: '' },
    { label: 'Closed Positions', value: closed.length,      cls: '' },
    { label: 'Win Rate',         value: winRate + '%',      cls: winRate >= 50 ? 'pos' : 'neg' },
  ].map(m => `<div class="metric"><div class="label">${m.label}</div><div class="value ${m.cls}">${m.value}</div></div>`).join('');
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function renderTabs() {
  el('tabBar').innerHTML = TABS.map((t, i) =>
    `<button class="tab ${i === activeTab ? 'active' : ''}" role="tab" aria-selected="${i === activeTab}" onclick="switchTab(${i})">
       <i class="ti ${t.icon}" aria-hidden="true"></i>${t.label}
     </button>`
  ).join('');
}
function switchTab(i) { activeTab = i; renderTabs(); renderTabContent(); }
window.switchTab = switchTab;
function renderTabContent() {
  if (activeMode === 'investing') {
    renderInvesting(el('tabContent'));
  } else {
    [renderSummary, renderDeposits, renderTrades, renderAll][activeTab](el('tabContent'));
  }
}

window.switchMode = function(mode) {
  activeMode = mode;
  renderModeBar();
  renderForMode();
};

// ── Pagination ─────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;
window.changePage = function(key, dir) { pages[key] = (pages[key] || 1) + dir; renderTabContent(); };

function paginate(key, rows, renderRow, headers) {
  if (!pages[key]) pages[key] = 1;
  const total      = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages[key] > totalPages) pages[key] = totalPages;
  const slice = rows.slice((pages[key] - 1) * PAGE_SIZE, pages[key] * PAGE_SIZE);
  const thead = headers.map(h => `<th${h.w ? ` style="width:${h.w}"` : ''}>${h.label}</th>`).join('');
  const tbody = slice.length
    ? slice.map(renderRow).join('')
    : `<tr><td colspan="${headers.length}" class="empty">No records found</td></tr>`;
  const pg = `<div class="pg">
    <span>${total} record${total !== 1 ? 's' : ''}</span>
    ${pages[key] > 1 ? `<button onclick="changePage('${key}',-1)">← Prev</button>` : ''}
    <span>Page ${pages[key]} / ${totalPages}</span>
    ${pages[key] < totalPages ? `<button onclick="changePage('${key}',1)">Next →</button>` : ''}
  </div>`;
  return `<div class="tbl-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>${pg}`;
}

// ── Summary tab ────────────────────────────────────────────────────────────
function renderSummary(container) {
  const { positions } = processed;
  const closed = positions.filter(p => p.isClosed);
  const sorted = [...closed].sort((a, b) => b.netPnl - a.netPnl);
  const monthPnl = {};
  processed.tradeRows.forEach(r => {
    const d = new Date(r['Date']);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    monthPnl[key] = (monthPnl[key] || 0) + parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees']));
  });
  const months = Object.keys(monthPnl).sort();
  const symList = items => items.map(p => `
    <div class="sym-row">
      <span class="sym-name mono">${p.ul} ${p.expDate}</span>
      <span class="sym-val ${p.netPnl >= 0 ? 'pos' : 'neg'}">${fmt(p.netPnl)}</span>
    </div>`).join('');

  container.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><h3>Top 5 winners</h3>${symList(sorted.slice(0,5))}</div>
      <div class="summary-card"><h3>Top 5 losers</h3>${symList(sorted.slice(-5).reverse())}</div>
    </div>
    <div class="chart-card">
      <h3>Monthly P&L</h3>
      <div style="position:relative;height:${Math.max(180, months.length*26)}px">
        <canvas id="monthChart" role="img" aria-label="Monthly P&L bar chart">Monthly P&L for ${months.length} months.</canvas>
      </div>
    </div>`;

  requestAnimationFrame(() => {
    const canvas = el('monthChart');
    if (!canvas || !window.Chart) return;
    const vals = months.map(m => +monthPnl[m].toFixed(2));
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: months.map(m => { const [y,mo] = m.split('-'); return new Date(y,mo-1).toLocaleString('en-US',{month:'short',year:'2-digit'}); }),
        datasets: [{ label: 'P&L', data: vals, backgroundColor: vals.map(v => v >= 0 ? 'rgba(29,158,117,0.75)' : 'rgba(216,90,48,0.75)'), borderRadius: 3, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font:{size:11}, color: isDark?'#a0a09b':'#6b6b67', autoSkip:false, maxRotation:45 }, grid:{color: isDark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.07)'} },
          y: { ticks: { font:{size:11}, color: isDark?'#a0a09b':'#6b6b67', callback: v => (v<0?'-':'')+'$'+Math.abs(v).toLocaleString() }, grid:{color: isDark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.07)'} }
        }
      }
    });
  });
}

// ── Deposits tab ───────────────────────────────────────────────────────────
function fmtSgd(n) {
  if (!n) return '—';
  return 'S$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderDeposits(container) {
  const { deposits } = processed;
  const depRows = deposits.filter(r => r['Sub Type'] === 'Deposit').sort((a,b) => new Date(b['Date'])-new Date(a['Date']));
  const intRows = deposits.filter(r => r['Sub Type'] === 'Credit Interest').sort((a,b) => new Date(b['Date'])-new Date(a['Date']));
  const adjRows = deposits.filter(r => r['Sub Type'] === 'Balance Adjustment').sort((a,b) => new Date(b['Date'])-new Date(a['Date']));
  const totalDep = depRows.reduce((s,r) => s+parseVal(r['Total']),0);
  const totalInt = intRows.reduce((s,r) => s+parseVal(r['Total']),0);
  const totalAdj = adjRows.reduce((s,r) => s+parseVal(r['Total']),0);

  // Build a lookup: rowHash -> sgd amount from sgdData
  const sgdMap = {};
  sgdData.forEach(e => { if (e.rowHash) sgdMap[e.rowHash] = e.sgd; });
  const totalSgd = Object.values(sgdMap).reduce((s,v) => s+(v||0), 0);

  // Deposit table — each row has an inline SGD input
  const depTableRows = depRows.map(r => {
    const t    = parseVal(r['Total']);
    const hash = rowHash(r);
    const sgdVal = sgdMap[hash] || '';
    return `<tr>
      <td>${fmtDate(r['Date'])}</td>
      <td><span class="badge open">Deposit</span></td>
      <td>${r['Description']}</td>
      <td class="pos">${fmt(t)}</td>
      <td class="sgd-cell">
        ${sgdVal
          ? `<span class="sgd-set" onclick="openSgdInput('${hash}')" title="Click to edit">${fmtSgd(sgdVal)}</span>`
          : `<button class="sgd-add-btn" onclick="openSgdInput('${hash}')">+ SGD</button>`
        }
        <span class="sgd-input-wrap" id="sgd-wrap-${hash}" style="display:none">
          <input type="number" class="sgd-inline-input" id="sgd-input-${hash}"
            placeholder="SGD amount" min="0" step="0.01"
            value="${sgdVal}"
            onkeydown="if(event.key==='Enter')saveSgdInline('${hash}');if(event.key==='Escape')closeSgdInput('${hash}')">
          <button class="sgd-save-btn" onclick="saveSgdInline('${hash}')">Save</button>
          <button class="sgd-cancel-btn" onclick="closeSgdInput('${hash}')">✕</button>
        </span>
      </td>
    </tr>`;
  }).join('');

  const badge  = r => r['Sub Type']==='Credit Interest'?'trade':'closed';
  const hdrs2  = [{label:'Date',w:'90px'},{label:'Type',w:'130px'},{label:'Description'},{label:'Amount',w:'90px'}];
  const tblRow2 = r => { const t=parseVal(r['Total']); return `<tr><td>${fmtDate(r['Date'])}</td><td><span class="badge ${badge(r)}">${r['Sub Type']}</span></td><td>${r['Description']}</td><td class="${t>=0?'pos':'neg'}">${fmt(t)}</td></tr>`; };

  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Total deposited (USD)</div><div class="value pos">${fmt(totalDep)}</div></div>
      <div class="metric"><div class="label">Total deposited (SGD)</div><div class="value pos">${totalSgd ? fmtSgd(totalSgd) : '—'}</div></div>
      <div class="metric"><div class="label">Interest earned</div><div class="value pos">${fmt(totalInt)}</div></div>
      <div class="metric"><div class="label">Balance adjustments</div><div class="value ${totalAdj>=0?'pos':'neg'}">${fmt(totalAdj)}</div></div>
    </div>

    <div class="dep-section">
      <div class="dep-section-header"><i class="ti ti-building-bank" aria-hidden="true"></i> Deposits <span class="dep-count">${depRows.length}</span></div>
      <div id="sgd-status-bar" style="display:none;font-size:12px;padding:5px 0;color:var(--text-secondary)"></div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th style="width:90px">Date</th>
            <th style="width:90px">Type</th>
            <th>Description</th>
            <th style="width:90px">USD Amount</th>
            <th style="width:160px">SGD Amount</th>
          </tr></thead>
          <tbody>${depTableRows}</tbody>
        </table>
      </div>
    </div>

    <div class="dep-section"><div class="dep-section-header"><i class="ti ti-coin" aria-hidden="true"></i> Credit interest <span class="dep-count">${intRows.length}</span></div>${paginate('int',intRows,tblRow2,hdrs2)}</div>
    <div class="dep-section"><div class="dep-section-header"><i class="ti ti-adjustments-horizontal" aria-hidden="true"></i> Balance adjustments <span class="dep-count">${adjRows.length}</span></div>${paginate('adj',adjRows,tblRow2,hdrs2)}</div>`;
}

window.openSgdInput = function(hash) {
  const wrap = el(`sgd-wrap-${hash}`);
  if (!wrap) return;
  wrap.style.display = 'inline-flex';
  const input = el(`sgd-input-${hash}`);
  if (input) { input.focus(); input.select(); }
  // Hide the badge/button while editing
  const cell = wrap.parentElement;
  const set  = cell.querySelector('.sgd-set');
  const btn  = cell.querySelector('.sgd-add-btn');
  if (set) set.style.display = 'none';
  if (btn) btn.style.display = 'none';
};

window.closeSgdInput = function(hash) {
  const wrap = el(`sgd-wrap-${hash}`);
  if (wrap) wrap.style.display = 'none';
  // Restore the badge/button
  const cell = wrap?.parentElement;
  const set  = cell?.querySelector('.sgd-set');
  const btn  = cell?.querySelector('.sgd-add-btn');
  if (set) set.style.display = '';
  if (btn) btn.style.display = '';
};

window.saveSgdInline = async function(hash) {
  const input = el(`sgd-input-${hash}`);
  const sgd   = parseFloat(input?.value);
  const sbar  = el('sgd-status-bar');

  if (!input || isNaN(sgd) || sgd <= 0) {
    if (sbar) { sbar.textContent = 'Please enter a valid SGD amount.'; sbar.style.display = 'block'; }
    return;
  }
  if (!ghToken) { showTokenModal(() => saveSgdInline(hash)); return; }

  if (sbar) { sbar.textContent = 'Saving…'; sbar.style.display = 'block'; }

  // Upsert entry by rowHash
  const existing = sgdData.filter(e => e.rowHash !== hash);
  const updated  = [...existing, { rowHash: hash, sgd, updatedAt: new Date().toISOString() }];

  try {
    await ghPutSgd(updated);
    if (sbar) { sbar.textContent = '✓ Saved!'; setTimeout(() => { sbar.style.display='none'; }, 2500); }
    renderDeposits(el('tabContent'));
  } catch(e) {
    if (sbar) { sbar.textContent = `Error: ${e.message}`; sbar.style.display = 'block'; }
  }
};

// ── Trades tab ─────────────────────────────────────────────────────────────
function renderTrades(container) {
  const { positions } = processed;
  const open=positions.filter(p=>!p.isClosed), closed=positions.filter(p=>p.isClosed);
  const closedPnl=closed.reduce((s,p)=>s+p.netPnl,0), winners=closed.filter(p=>p.netPnl>0).length;
  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Closed P&L</div><div class="value ${closedPnl>=0?'pos':'neg'}">${fmt(closedPnl)}</div></div>
      <div class="metric"><div class="label">Open</div><div class="value">${open.length}</div></div>
      <div class="metric"><div class="label">Closed</div><div class="value">${closed.length}</div></div>
      <div class="metric"><div class="label">Winners / Losers</div><div class="value">${winners} / ${closed.length-winners}</div></div>
    </div>
    <div class="search-row">
      <input id="tradeSearch" placeholder="Search underlying, symbol…" oninput="filterTrades(this.value)">
      <select id="tradeFilter" onchange="filterTrades(document.getElementById('tradeSearch').value)">
        <option value="all">All positions</option>
        <option value="open">Open only</option>
        <option value="closed">Closed only</option>
      </select>
    </div>
    <div id="tradesTable">${buildTradesTable(positions,'','all')}</div>`;
}

window.filterTrades = function(q) {
  const filter = el('tradeFilter')?.value || 'all';
  pages['trades'] = 1;
  el('tradesTable').innerHTML = buildTradesTable(processed.positions, q||'', filter);
};

function legsHtml(legs) {
  if (!legs.length) return '<span style="color:var(--text-tertiary);font-size:11px">—</span>';
  return legs.map(l => {
    const isSell=(l['Action']||'').startsWith('SELL');
    const cp=l['Call or Put'], strike=l['Strike Price']?parseFloat(l['Strike Price']).toFixed(0):'';
    const qty=l['Quantity']||'', total=parseVal(l['Total']);
    const rawAvg=l['Average Price']&&l['Average Price']!=='--'?l['Average Price']:'';
    const avgPx=rawAvg?parseFloat(rawAvg).toFixed(4):'';
    return `<div class="leg-row">
      <span class="leg-action ${isSell?'leg-sell':'leg-buy'}">${isSell?'S':'B'}</span>
      <span class="leg-detail">
        <span class="mono leg-sym">${l['Symbol']||'—'}</span>
        <span class="leg-meta">${cp?cp[0]:''} ${strike?'@ '+strike:''} × ${qty}${avgPx?' · avg '+avgPx:''}</span>
        <span class="leg-nums">
          <span class="${total>=0?'pos':'neg'}">${fmt(total)}</span>
          <span class="leg-cf">comm ${fmt(parseVal(l['Commissions']))} · fees ${fmt(-Math.abs(parseVal(l['Fees'])))}</span>
        </span>
      </span>
    </div>`;
  }).join('');
}

window.toggleTrade = function(id) {
  const card = document.getElementById(id);
  if (!card) return;
  card.classList.toggle('expanded');
  card.classList.toggle('collapsed');
};

function buildTradesTable(positions, q, filter) {
  let rows = positions;
  if (filter==='open')   rows=rows.filter(p=>!p.isClosed);
  if (filter==='closed') rows=rows.filter(p=>p.isClosed);
  if (q) { const ql=q.toLowerCase(); rows=rows.filter(p=>p.ul.toLowerCase().includes(ql)||p.expDate.toLowerCase().includes(ql)||p.openLegs.some(l=>l['Symbol'].toLowerCase().includes(ql))); }
  if (!rows.length) return '<div class="empty">No positions found</div>';
  if (!pages['trades']) pages['trades']=1;
  const total=rows.length, totalPages=Math.max(1,Math.ceil(total/PAGE_SIZE));
  if (pages['trades']>totalPages) pages['trades']=totalPages;
  const slice=rows.slice((pages['trades']-1)*PAGE_SIZE,pages['trades']*PAGE_SIZE);
  const rowsHtml=slice.map((p,idx)=>{
    const isRoll = p.isRoll;
    const statusBadge = isRoll
      ? `<span class="badge trade">Roll</span><span class="badge open">Open</span>`
      : p.isClosed
        ? `<span class="badge ${p.isExpired?'expired':'closed'}">${p.isExpired?'Expired':'Closed'}</span>`
        : `<span class="badge open">Open</span>`;
    const pnlVal  = isRoll ? p.openTotal + p.closeTotal : p.isClosed ? p.netPnl : p.openTotal;
    const pnlLabel = isRoll ? 'Roll Credit' : p.isClosed ? 'Net P&L' : 'Open P&L';
    const cardId  = `trade-${pages['trades']||1}-${idx}`;
    const startOpen = !p.isClosed || isRoll;

    // Roll-specific: split the allLegsForCard into close and open groups
    const rollCloseLegs = isRoll ? p.allLegsForCard.filter(l => l['Action'].includes('CLOSE')) : [];
    const rollOpenLegs  = isRoll ? p.allLegsForCard.filter(l => l['Action'].includes('OPEN'))  : [];
    const rollCloseTotal = rollCloseLegs.reduce((s,l) => s + parseVal(l['Total']), 0);
    const rollOpenTotal  = rollOpenLegs.reduce((s,l) => s + parseVal(l['Total']), 0);

    const rollExpClose = isRoll && rollCloseLegs.length
      ? rollCloseLegs[0]['Expiration Date'] || ''
      : '';
    const rollExpOpen = isRoll && rollOpenLegs.length
      ? rollOpenLegs[0]['Expiration Date'] || ''
      : '';

    const tradeBody = isRoll ? `
      <div class="trade-body">
        <div class="trade-side">
          <div class="side-label" style="color:var(--red)"><i class="ti ti-lock" aria-hidden="true"></i> Closed ${rollExpClose ? 'exp ' + rollExpClose : ''}</div>
          <div class="legs">${legsHtml(rollCloseLegs)}</div>
          <div class="side-total">Total <span class="${rollCloseTotal>=0?'pos':'neg'}">${fmt(rollCloseTotal)}</span></div>
        </div>
        <div class="trade-divider" aria-hidden="true"><div class="divider-line"></div><i class="ti ti-refresh"></i><div class="divider-line"></div></div>
        <div class="trade-side">
          <div class="side-label" style="color:var(--green)"><i class="ti ti-lock-open" aria-hidden="true"></i> Rolled to ${rollExpOpen ? 'exp ' + rollExpOpen : ''}</div>
          <div class="legs">${legsHtml(rollOpenLegs)}</div>
          <div class="side-total">Total <span class="${rollOpenTotal>=0?'pos':'neg'}">${fmt(rollOpenTotal)}</span></div>
        </div>
      </div>` : `
      <div class="trade-body">
        <div class="trade-side">
          <div class="side-label"><i class="ti ti-lock-open" aria-hidden="true"></i> Opened ${fmtDate(p.openDate)}</div>
          <div class="legs">${legsHtml(p.openLegs)}</div>
          <div class="side-total">Total <span class="${p.openTotal>=0?'pos':'neg'}">${fmt(p.openTotal)}</span></div>
        </div>
        <div class="trade-divider" aria-hidden="true"><div class="divider-line"></div><i class="ti ti-arrow-right"></i><div class="divider-line"></div></div>
        <div class="trade-side">
          <div class="side-label"><i class="ti ti-lock" aria-hidden="true"></i> ${p.isClosed?'Closed '+fmtDate(p.closeDate):'Not yet closed'}</div>
          ${p.isClosed?`<div class="legs">${legsHtml([...p.closeLegs,...p.expiryRows])}</div><div class="side-total">Total <span class="${p.closeTotal>=0?'pos':'neg'}">${fmt(p.closeTotal)}</span></div>`:`<div class="legs open-placeholder"><span class="placeholder-text">Position still open</span></div>`}
        </div>
      </div>`;

    return `<div class="trade-row ${p.isClosed&&!isRoll?'trade-closed':'trade-open'} ${startOpen?'expanded':'collapsed'}" id="${cardId}">
      <div class="trade-header" onclick="toggleTrade('${cardId}')" style="cursor:pointer">
        <div class="trade-header-left"><span class="trade-ul">${p.ul}</span><span class="trade-exp">exp ${p.expDate}</span>${statusBadge}</div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="trade-pnl"><span class="pnl-label">${pnlLabel}</span><span class="pnl-value ${pnlVal>=0?'pos':'neg'}">${fmt(pnlVal)}</span></div>
          <i class="ti ti-chevron-down trade-chevron" aria-hidden="true"></i>
        </div>
      </div>
      ${tradeBody}
    </div>`;
  }).join('');
  const pg=`<div class="pg"><span>${total} position${total!==1?'s':''}</span>${pages['trades']>1?`<button onclick="changePage('trades',-1)">← Prev</button>`:''}<span>Page ${pages['trades']} / ${totalPages}</span>${pages['trades']<totalPages?`<button onclick="changePage('trades',1)">Next →</button>`:''}</div>`;
  return `<div class="trades-list">${rowsHtml}</div>${pg}`;
}

// ── All Ledger tab ─────────────────────────────────────────────────────────
function renderAll(container) {
  container.innerHTML = `
    <div class="search-row">
      <input id="allSearch" placeholder="Search anything…" oninput="filterAll()" style="max-width:260px">
      <select id="allType" onchange="filterAll()">
        <option value="">All types</option><option>Trade</option><option>Money Movement</option><option>Receive Deliver</option>
      </select>
    </div>
    <div id="allTable">${buildAllTable('','')}</div>`;
}
window.filterAll = function() {
  const q=(el('allSearch')?.value||'').trim(), type=el('allType')?.value||'';
  pages['all']=1; el('allTable').innerHTML=buildAllTable(q,type);
};
function buildAllTable(q, typeFilter) {
  let rows=[...allData].sort((a,b)=>new Date(b['Date'])-new Date(a['Date']));
  if (typeFilter) rows=rows.filter(r=>r['Type']===typeFilter);
  if (q) rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const tb=r=>r['Type']==='Trade'?'trade':r['Type']==='Money Movement'?'money':'deliver';
  return paginate('all',rows,r=>{const t=parseVal(r['Total']);return`<tr><td>${fmtDate(r['Date'])}</td><td><span class="badge ${tb(r)}">${r['Type']}</span></td><td style="font-size:11px">${r['Sub Type']||'—'}</td><td class="mono">${r['Symbol']||'—'}</td><td style="font-size:11.5px;color:var(--text-secondary)">${r['Description']||'—'}</td><td class="neg">${r['Commissions']&&r['Commissions']!=='--'?fmt(parseVal(r['Commissions'])):'—'}</td><td class="neg">${r['Fees']?fmt(-Math.abs(parseVal(r['Fees']))):'—'}</td><td class="${t>=0?'pos':'neg'}">${fmt(t)}</td></tr>`;},
    [{label:'Date',w:'82px'},{label:'Type',w:'90px'},{label:'Sub type',w:'90px'},{label:'Symbol'},{label:'Description',w:'170px'},{label:'Comm',w:'55px'},{label:'Fees',w:'45px'},{label:'Total',w:'80px'}]);
}

// ── Investment calculator ──────────────────────────────────────────────────
const ALLOC = [
  { sym: 'DGRO', pct: 5,  avgComm: 0.31 },
  { sym: 'FBTC', pct: 5,  avgComm: 0.38 },
  { sym: 'QQQM', pct: 25, avgComm: 0.30 },
  { sym: 'SCHD', pct: 10, avgComm: 0.33 },
  { sym: 'SMH',  pct: 5,  avgComm: 0.36 },
  { sym: 'SPYL', pct: 25, avgComm: 2.49 },
  { sym: 'VGT',  pct: 25, avgComm: 0.30 },
];

function buildCalculator() {
  const rows = ALLOC.map(a => `
    <tr>
      <td><span class="badge trade" style="font-size:11px;padding:2px 7px">${a.sym}</span></td>
      <td class="mono" style="color:var(--text-secondary)">${a.pct}%</td>
      <td class="pos mono" id="calc-amt-${a.sym}">—</td>
      <td class="neg mono" id="calc-comm-${a.sym}">—</td>
      <td class="pos mono" id="calc-net-${a.sym}">—</td>
      <td class="mono" id="calc-sh-${a.sym}" style="color:var(--text-secondary)">—</td>
    </tr>`).join('');

  return `
    <div class="dep-section calc-section">
      <div class="dep-section-header calc-toggle" onclick="this.closest('.calc-section').classList.toggle('calc-open')">
        <i class="ti ti-calculator" aria-hidden="true"></i> Investment Calculator
        <span class="dep-count">DGRO 5% · FBTC 5% · QQQM 25% · SCHD 10% · SMH 5% · SPYL 25% · VGT 25%</span>
        <i class="ti ti-chevron-down" style="margin-left:auto;font-size:14px;color:var(--text-tertiary)" aria-hidden="true"></i>
      </div>
      <div class="calc-body">
        <div class="calc-input-row">
          <span class="calc-currency">$</span>
          <input id="calcInput" type="number" min="0" step="100"
            placeholder="Enter amount to invest (USD)"
            oninput="runCalc(this.value)"
            style="flex:1;background:var(--bg);border:none;padding:9px 12px;
                   font-size:15px;color:var(--text);outline:none;-moz-appearance:textfield">
        </div>
        <div class="tbl-wrap" style="margin-top:10px">
          <table>
            <thead><tr>
              <th>Ticker</th><th>Alloc</th><th>Allocated</th>
              <th>Est. Comm</th><th>Into Shares</th><th>Est. Shares</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr id="calc-foot" style="display:none">
                <td colspan="2" style="color:var(--text-secondary);font-size:11.5px;font-weight:600">TOTAL</td>
                <td class="pos mono" id="calc-tot-gross"></td>
                <td class="neg mono" id="calc-tot-comm"></td>
                <td class="pos mono" id="calc-tot-net"></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);padding:0 2px">
          Commissions based on your actual IB trade history. SPYL is higher due to LSE exchange fees.
        </div>
      </div>
    </div>`;
}

window.runCalc = function(val) {
  const total = parseFloat(val) || 0;
  let totGross = 0, totComm = 0, totNet = 0;

  ALLOC.forEach(({ sym, pct, avgComm }) => {
    const allocated = total * pct / 100;        // your % of input budget
    const comm      = total > 0 ? avgComm : 0; // commission taken from allocation
    const intoShares = Math.max(0, allocated - comm); // what actually buys shares
    totGross += allocated; totComm += comm; totNet += intoShares;

    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set(`calc-amt-${sym}`,  total > 0 ? '$' + allocated.toFixed(2)   : '—');
    set(`calc-comm-${sym}`, total > 0 ? '$' + comm.toFixed(2)        : '—');
    set(`calc-net-${sym}`,  total > 0 ? '$' + intoShares.toFixed(2)  : '—');

    const shEl = document.getElementById(`calc-sh-${sym}`);
    if (shEl) {
      const card      = document.getElementById(`inv-sym-${sym}`);
      const badge     = card?.querySelector('.live-price');
      const livePrice = badge ? parseFloat(badge.textContent.replace('live','').replace('$','').trim()) : 0;
      const pos       = (window._ibOpenPositions || {})[sym];
      const price     = livePrice || pos?.closePrice || 0;
      shEl.textContent = (total > 0 && price > 0) ? (intoShares / price).toFixed(4) + ' sh' : '—';
    }
  });

  const foot = document.getElementById('calc-foot');
  if (foot) foot.style.display = total > 0 ? 'table-row' : 'none';
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  if (total > 0) {
    set('calc-tot-gross', '$' + totGross.toFixed(2));  // = input total
    set('calc-tot-comm',  '$' + totComm.toFixed(2));
    set('calc-tot-net',   '$' + totNet.toFixed(2));
  }
};

// ── Options section (embedded inside Investing) ────────────────────────────
function buildOptionsSection() {
  const optTrades   = ibData.optionTrades     || [];
  const assignStock = ibData.assignmentStocks || [];
  if (optTrades.length === 0 && assignStock.length === 0) return '';

  // Group option trades by underlying
  const byUl = {};
  for (const t of optTrades) {
    const ul = t.symbol.split(' ')[0];
    if (!byUl[ul]) byUl[ul] = { optTrades: [], assignTrades: [], pl: 0, comm: 0 };
    byUl[ul].optTrades.push(t);
    byUl[ul].pl   += t.realPL;
    byUl[ul].comm += t.comm;
  }
  // Attach assignment stock trades to matching underlying
  for (const t of assignStock) {
    const ul = Object.keys(byUl).find(k => t.symbol === k || t.symbol.startsWith(k)) || t.symbol;
    if (!byUl[ul]) byUl[ul] = { optTrades: [], assignTrades: [], pl: 0, comm: 0 };
    byUl[ul].assignTrades.push(t);
    byUl[ul].pl   += t.realPL; // includes the assignment close sell P&L (negative)
    byUl[ul].comm += t.comm;
  }

  const totalPL       = Object.values(byUl).reduce((s, d) => s + d.pl, 0);
  const totalComm     = Object.values(byUl).reduce((s, d) => s + Math.abs(d.comm), 0);
  const totalContracts = optTrades.length;
  const winners       = Object.values(byUl).filter(d => d.pl > 0).length;
  const losers        = Object.values(byUl).filter(d => d.pl < 0).length;

  // Monthly P&L (options only)
  const monthly = {};
  for (const t of [...optTrades, ...assignStock]) {
    if (t.realPL === 0) continue;
    const m = (t.dateRaw || '').slice(0, 7);
    if (m) monthly[m] = (monthly[m] || 0) + t.realPL;
  }
  const months = Object.keys(monthly).sort();

  const sortedUls = Object.keys(byUl).sort((a, b) => Math.abs(byUl[b].pl) - Math.abs(byUl[a].pl));

  const ulCards = sortedUls.map(ul => {
    const d = byUl[ul];
    const allTrades = [
      ...d.optTrades.map(t => ({ ...t, _type: 'option' })),
      ...d.assignTrades.map(t => ({ ...t, _type: 'assign' }))
    ].sort((a, b) => (a.dateRaw || '').localeCompare(b.dateRaw || ''));

    const tradeRowsHtml = allTrades.map(t => {
      const isBuy = t.qty > 0;
      const isOpt = t._type === 'option';
      const label = isOpt ? (isBuy ? 'BUY' : 'SELL') : (isBuy ? 'ASSIGN' : 'SELL');
      const cls   = isOpt ? (isBuy ? 'money' : 'trade') : (isBuy ? 'expired' : 'closed');
      return `<tr>
        <td>${(t.dateRaw || '').slice(0, 10)}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${t.symbol}">${t.symbol}</td>
        <td class="mono">${Math.abs(t.qty)}</td>
        <td class="mono">${t.tPrice > 0 ? '$' + t.tPrice.toFixed(2) : '—'}</td>
        <td class="${t.proceeds >= 0 ? 'pos' : 'neg'}">${fmt(t.proceeds)}</td>
        <td class="neg">${fmt(t.comm)}</td>
        <td class="${t.realPL > 0 ? 'pos' : t.realPL < 0 ? 'neg' : ''}">
          ${t.realPL !== 0 ? (t.realPL > 0 ? '+' : '') + fmt(t.realPL) : '—'}
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="inv-sym-card ${d.pl >= 0 ? '' : 'inv-sym-loss'}" id="opt-ul-${ul}">
        <div class="inv-sym-header" onclick="toggleOptUl('${ul}')">
          <div class="inv-sym-left">
            <span class="badge ${d.pl >= 0 ? 'open' : 'closed'}" style="font-size:12px;padding:3px 8px">${ul}</span>
            <div class="inv-sym-meta">
              <span>${d.optTrades.length} contracts</span>
              ${d.assignTrades.length ? `<span class="inv-sep">·</span><span>${d.assignTrades.filter(t=>t.qty>0).length} assigned</span>` : ''}
            </div>
          </div>
          <div class="inv-sym-right">
            <div class="inv-stat">
              <span class="inv-stat-label">Realized P&L</span>
              <span class="inv-stat-val ${d.pl >= 0 ? 'pos' : 'neg'}">${d.pl > 0 ? '+' : ''}${fmt(d.pl)}</span>
            </div>
            <div class="inv-stat">
              <span class="inv-stat-label">Comm</span>
              <span class="inv-stat-val neg">${fmt(d.comm)}</span>
            </div>
            <i class="ti ti-chevron-down inv-chevron" aria-hidden="true"></i>
          </div>
        </div>
        <div class="inv-sym-body">
          <div class="tbl-wrap" style="margin:10px 14px 14px">
            <table>
              <thead><tr>
                <th>Date</th><th>Type</th><th>Contract / Symbol</th>
                <th>Qty</th><th>Price</th><th>Proceeds</th><th>Comm</th><th>Realized P&L</th>
              </tr></thead>
              <tbody>${tradeRowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');

  // Store months/vals for chart rendering after innerHTML is set
  window._optChartData = { months, monthly };

  return `
    <div class="dep-section opts-section">
      <div class="dep-section-header opts-toggle" onclick="this.closest('.opts-section').classList.toggle('opts-open')">
        <i class="ti ti-chart-candle" aria-hidden="true"></i> Past Options Trading
        <span class="dep-count">${totalContracts} contracts · ${Object.keys(byUl).length} underlyings</span>
        <i class="ti ti-chevron-down" style="margin-left:auto;font-size:14px;color:var(--text-tertiary)" aria-hidden="true"></i>
      </div>
      <div class="opts-body">
        <div class="opt-summary-grid">
          <div class="metric"><div class="label">Realized P&L</div>
            <div class="value ${totalPL >= 0 ? 'pos' : 'neg'}">${totalPL > 0 ? '+' : ''}${fmt(totalPL)}</div></div>
          <div class="metric"><div class="label">Winners / Losers</div>
            <div class="value"><span class="pos">${winners}</span> / <span class="neg">${losers}</span></div></div>
          <div class="metric"><div class="label">Commissions</div><div class="value neg">${fmt(totalComm)}</div></div>
          <div class="metric"><div class="label">Assignments</div>
            <div class="value">${assignStock.filter(t=>t.qty>0).length}</div></div>
        </div>
        <div class="chart-card" style="margin-bottom:12px">
          <h3>Monthly Options P&L</h3>
          <div style="position:relative;height:140px">
            <canvas id="optMonthChart" role="img" aria-label="Monthly options P&L"></canvas>
          </div>
        </div>
        <div class="inv-holdings">${ulCards}</div>
      </div>
    </div>`;
}

window.toggleOptUl = function(ul) {
  const card = el(`opt-ul-${ul}`);
  if (card) card.classList.toggle('inv-expanded');
};

function renderOptChart() {
  const data = window._optChartData;
  if (!data) return;
  const canvas = el('optMonthChart');
  if (!canvas || !window.Chart) return;
  const { months, monthly } = data;
  const vals = months.map(m => +monthly[m].toFixed(2));
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months.map(m => {
        const [y, mo] = m.split('-');
        return new Date(y, mo - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
      }),
      datasets: [{ label: 'P&L', data: vals,
        backgroundColor: vals.map(v => v >= 0 ? 'rgba(29,158,117,0.72)' : 'rgba(216,90,48,0.72)'),
        borderRadius: 3, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 11 }, color: isDark ? '#a0a09b' : '#6b6b67', autoSkip: false, maxRotation: 45 },
             grid: { color: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)' } },
        y: { ticks: { font: { size: 11 }, color: isDark ? '#a0a09b' : '#6b6b67',
                       callback: v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString() },
             grid: { color: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)' } }
      }
    }
  });
}

// ── Live price fetcher ─────────────────────────────────────────────────────
// SPYL is London-listed (USD-quoted on IB) — Yahoo Finance uses SPYL.L in GBP,
// so we fetch it separately and use the IB cost basis for P&L estimation.
const YF_MAP = { DGRO:'DGRO', FBTC:'FBTC', QQQM:'QQQM', SCHD:'SCHD', SMH:'SMH', VGT:'VGT', SPYL:'SPYL.L' };

async function fetchAndUpdateLivePrices(tickers, openPositions) {
  try {
    const syms = tickers.filter(s => YF_MAP[s]).map(s => YF_MAP[s]);
    if (!syms.length) return;

    // Include GBPUSD rate so we can convert SPYL.L if it's quoted in GBP
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms.join(',')},GBPUSD%3DX`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const quotes = data?.quoteResponse?.result || [];
    if (!quotes.length) throw new Error('No quotes returned');

    // Get GBP/USD rate for SPYL conversion if needed
    const gbpusd = quotes.find(q => q.symbol === 'GBPUSD=X')?.regularMarketPrice || 1;

    // Build price map — convert GBP-quoted prices to USD
    const livePrices = {};
    for (const q of quotes) {
      if (q.symbol === 'GBPUSD=X') continue;
      const price = q.regularMarketPrice;
      const inUsd = (q.currency === 'GBp') ? price / 100 * gbpusd   // pence → USD
                  : (q.currency === 'GBP') ? price * gbpusd          // pounds → USD
                  : price;                                            // already USD
      livePrices[q.symbol] = inUsd;
    }

    // Update each ticker card in the DOM
    let totalLiveMkt = 0, totalLiveUnreal = 0;
    for (const sym of tickers) {
      const price = livePrices[YF_MAP[sym]];
      const pos   = openPositions[sym];
      if (!price || !pos) continue;
      const mktVal  = price * pos.qty;
      const unrealPL = mktVal - pos.costBasis;
      const pct      = pos.costBasis > 0 ? ((unrealPL / pos.costBasis) * 100).toFixed(1) : 0;
      totalLiveMkt   += mktVal;
      totalLiveUnreal += unrealPL;

      // Update the card stats
      const card = el(`inv-sym-${sym}`);
      if (!card) continue;
      const stats = card.querySelectorAll('.inv-stat');
      // stats order: Amount Invested, Mkt Value, Unreal P&L, Comm
      if (stats[1]) stats[1].querySelector('.inv-stat-val').textContent = fmt(mktVal);
      if (stats[2]) {
        const v = stats[2].querySelector('.inv-stat-val');
        v.textContent = `${unrealPL > 0 ? '+' : ''}${fmt(unrealPL)} (${pct}%)`;
        v.className   = `inv-stat-val ${unrealPL >= 0 ? 'pos' : 'neg'}`;
      }
      // Update avg cost with live price
      const meta = card.querySelector('.inv-sym-meta');
      if (meta) {
        const spans = meta.querySelectorAll('span');
        // Add live price badge after the last span
        const existing = meta.querySelector('.live-price');
        if (!existing) {
          const badge = document.createElement('span');
          badge.className = 'live-price badge open';
          badge.style.cssText = 'font-size:10px;padding:2px 5px;margin-left:4px';
          badge.textContent = `$${price.toFixed(2)} live`;
          meta.appendChild(badge);
        } else {
          existing.textContent = `$${price.toFixed(2)} live`;
        }
      }
    }

    // Update summary grid using IDs
    const mktEl    = el('sum-mkt');
    const unrEl    = el('sum-unreal');
    const retEl    = el('sum-return');
    const costBasis = Object.values(openPositions).reduce((s, p) => s + (p.costBasis || 0), 0);

    if (mktEl) mktEl.textContent = fmt(totalLiveMkt);
    if (unrEl) {
      unrEl.textContent = `${totalLiveUnreal > 0 ? '+' : ''}${fmt(totalLiveUnreal)}`;
      unrEl.className   = `sgd-val ${totalLiveUnreal >= 0 ? 'pos' : 'neg'}`;
    }
    if (retEl && costBasis > 0) {
      const pct = (totalLiveUnreal / costBasis * 100).toFixed(1);
      retEl.textContent = `${pct}%`;
      retEl.className   = `sgd-val ${totalLiveUnreal >= 0 ? 'pos' : 'neg'}`;
    }
  } catch(e) {
    // Silently fall back to CSV prices — no action needed
    console.warn('Live price fetch failed, using CSV prices:', e.message);
  }
}

// ── Investing tab ──────────────────────────────────────────────────────────
function renderInvesting(container) {
  const { trades, openPositions, dividends, sgdDeposits, forexTrades, corporateActions } = ibData;
  const hasData = trades.length > 0 || (sgdDeposits || []).length > 0;

  // Build split lookup: symbol -> { ratio, date }
  const splitMap = {};
  for (const a of (corporateActions || [])) {
    if (a.type === 'split') splitMap[a.symbol] = a;
  }

  const importHtml = `
    <div class="dep-section">
      <div class="dep-section-header">
        <i class="ti ti-file-import" aria-hidden="true"></i>
        IB Activity Statement
        <span class="dep-count">${trades.length} trades · ${(sgdDeposits||[]).length} SGD entries</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <label class="inv-import-btn">
            <input type="file" accept=".csv" id="ibCsvInput" style="display:none">
            <i class="ti ti-upload" aria-hidden="true"></i> Import CSV
          </label>
          ${hasData ? `<button class="inv-clear-btn" onclick="clearIbData()">Clear</button>` : ''}
        </div>
      </div>
      <div id="ib-status" style="display:none;font-size:12px;padding:4px 0;color:var(--text-secondary)"></div>
    </div>`;

  if (!hasData) {
    container.innerHTML = importHtml + `
      <div class="upload-zone" style="margin:0;cursor:default">
        <i class="ti ti-building-bank" aria-hidden="true"></i>
        <p class="upload-title">No IB data yet</p>
        <p class="upload-sub">Import your Interactive Brokers Activity Statement CSV above</p>
        <p class="upload-hint">IB → Reports → Activity → Create Statement → Download CSV</p>
      </div>`;
    attachIbFileInput();
    return;
  }

  // ── SGD deposit / withdrawal summary ──
  const deps   = (sgdDeposits || []);
  const sgdIn  = deps.filter(d => d.amount > 0).reduce((s, d) => s + d.amount, 0);
  const sgdOut = deps.filter(d => d.amount < 0).reduce((s, d) => s + d.amount, 0);
  const sgdNet = sgdIn + sgdOut;

  // Forex: separate conversions IN (SGD→USD, positive usdAmt) vs OUT (USD→SGD, negative usdAmt)
  const fxAll    = (forexTrades || []);
  const fxIn     = fxAll.filter(f => f.usdAmt > 0);   // SGD converted to USD
  const fxOut    = fxAll.filter(f => f.usdAmt < 0);   // USD converted back to SGD
  const usdIn    = fxIn.reduce((s, f) => s + f.usdAmt, 0);
  const usdOut   = fxOut.reduce((s, f) => s + f.usdAmt, 0);  // negative
  const sgdUsed  = fxIn.reduce((s, f) => s + Math.abs(f.sgdAmt), 0);
  const fxComm   = fxAll.reduce((s, f) => s + Math.abs(f.comm), 0);
  const netUsd   = usdIn + usdOut;
  const effRate  = sgdUsed > 0 && usdIn > 0 ? sgdUsed / usdIn : 0;

  const fmtSgd = n => 'S$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const sgdRows = deps.map(d => `<tr>
    <td>${(d.dateRaw || '').slice(0, 10)}</td>
    <td><span class="badge ${d.amount > 0 ? 'open' : 'closed'}">${d.amount > 0 ? 'Deposit' : 'Withdrawal'}</span></td>
    <td style="color:var(--text-secondary);font-size:11.5px">${d.desc}</td>
    <td class="${d.amount > 0 ? 'pos' : 'neg'}">${d.amount > 0 ? '+' : ''}${fmtSgd(d.amount)}</td>
  </tr>`).join('');

  // ── per-ticker cost basis from open positions (most accurate — IB calculated) ──
  const CURRENT_TICKERS = ['DGRO','FBTC','QQQM','SCHD','SMH','SPYL','VGT'];
  const totalDiv = (dividends || []).reduce((s, d) => s + d.amount, 0);

  let totalCostBasis = 0, totalMktVal = 0, totalUnreal = 0;
  const tickerRows = CURRENT_TICKERS.map(sym => {
    const pos = openPositions[sym];
    if (!pos) return '';
    totalCostBasis += pos.costBasis || 0;
    totalMktVal    += pos.mktValue  || 0;
    totalUnreal    += pos.unrealPL  || 0;
    const pct = pos.costBasis > 0 ? ((pos.unrealPL / pos.costBasis) * 100).toFixed(1) : null;
    // Count buy trades for this ticker
    const buyCount = trades.filter(t => t.symbol === sym && t.qty > 0).length;
    const comm = trades.filter(t => t.symbol === sym).reduce((s, t) => s + Math.abs(t.comm), 0);
    const split = splitMap[sym];
    return `
      <div class="inv-sym-card" id="inv-sym-${sym}">
        <div class="inv-sym-header" onclick="toggleInvSym('${sym}')">
          <div class="inv-sym-left">
            <span class="badge trade" style="font-size:12px;padding:3px 8px">${sym}</span>
            ${split ? `<span class="badge expired" style="font-size:10px;padding:2px 6px">${split.ratio} split ${split.date}</span>` : ''}
            <div class="inv-sym-meta">
              <span>${pos.qty.toFixed(4)} shares</span>
              <span class="inv-sep">·</span>
              <span>avg $${(pos.costPrice || 0).toFixed(2)}</span>
              <span class="inv-sep">·</span>
              <span>${buyCount} buys</span>
            </div>
          </div>
          <div class="inv-sym-right">
            <div class="inv-stat">
              <span class="inv-stat-label">Amount Invested</span>
              <span class="inv-stat-val pos">${fmt(pos.costBasis)}</span>
            </div>
            <div class="inv-stat">
              <span class="inv-stat-label">Mkt Value</span>
              <span class="inv-stat-val">${fmt(pos.mktValue)}</span>
            </div>
            <div class="inv-stat">
              <span class="inv-stat-label">Unreal P&L</span>
              <span class="inv-stat-val ${pos.unrealPL >= 0 ? 'pos' : 'neg'}">${pos.unrealPL > 0 ? '+' : ''}${fmt(pos.unrealPL)}${pct ? ` (${pct}%)` : ''}</span>
            </div>
            <div class="inv-stat">
              <span class="inv-stat-label">Comm</span>
              <span class="inv-stat-val neg">${fmt(comm)}</span>
            </div>
            <i class="ti ti-chevron-down inv-chevron" aria-hidden="true"></i>
          </div>
        </div>
        <div class="inv-sym-body">
          <div class="tbl-wrap" style="margin:10px 14px 14px">
            ${split ? `<div style="font-size:11.5px;color:var(--text-secondary);padding:8px 10px;background:var(--bg-secondary);border-bottom:0.5px solid var(--border)"><i class="ti ti-info-circle" style="font-size:13px;margin-right:4px"></i>${split.ratio} stock split on ${split.date}. Pre-split trades show original qty &amp; price. Position (${pos.qty.toFixed(4)} shares @ $${(pos.costPrice||0).toFixed(2)}) is split-adjusted by IB.</div>` : ''}
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Price</th><th>Cost</th><th>Comm</th></tr></thead>
              <tbody>${trades.filter(t => t.symbol === sym && t.qty > 0)
                .sort((a, b) => (a.dateRaw || '').localeCompare(b.dateRaw || ''))
                .map(t => `<tr>
                  <td>${(t.dateRaw || '').slice(0, 10)}</td>
                  <td><span class="badge open">BUY</span></td>
                  <td class="mono">${t.qty.toFixed(4)}</td>
                  <td class="mono">$${t.tPrice.toFixed(4)}</td>
                  <td class="pos">$${Math.abs(t.proceeds).toFixed(2)}</td>
                  <td class="neg">$${Math.abs(t.comm).toFixed(2)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).filter(Boolean).join('');

  container.innerHTML = importHtml + `

    <!-- ── SGD Deposits ── -->
    <div class="dep-section">
      <div class="dep-section-header">
        <i class="ti ti-cash" aria-hidden="true"></i> SGD Deposits &amp; Withdrawals
        <span class="dep-count">${deps.length} entries</span>
      </div>

      <div class="sgd-grid">
        <div class="sgd-cell"><div class="sgd-lbl">Deposited</div><div class="sgd-val pos">${fmtSgd(sgdIn)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Withdrawn</div><div class="sgd-val neg">${fmtSgd(Math.abs(sgdOut))}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Net SGD</div><div class="sgd-val">${fmtSgd(sgdNet)}</div></div>
        <div class="sgd-divider"></div>
        <div class="sgd-cell"><div class="sgd-lbl">→ USD</div><div class="sgd-val pos">${fmt(usdIn)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Withdrawn</div><div class="sgd-val neg">${fmt(Math.abs(usdOut))}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Net USD</div><div class="sgd-val">${fmt(netUsd)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Avg Rate</div><div class="sgd-val">${effRate.toFixed(4)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Forex Fees</div><div class="sgd-val neg">${fmt(fxComm)}</div></div>
      </div>

      <div class="sgd-txn-toggle" onclick="this.classList.toggle('open')">
        <span><i class="ti ti-list" aria-hidden="true"></i> Show transactions</span>
        <i class="ti ti-chevron-down" aria-hidden="true"></i>
      </div>
      <div class="sgd-txn-body">
        <div class="tbl-wrap" style="margin-top:8px">
          <table><thead><tr>
            <th style="width:90px">Date</th><th style="width:100px">Type</th>
            <th>Description</th><th style="width:110px">Amount</th>
          </tr></thead><tbody>${sgdRows}</tbody></table>
        </div>
      </div>
    </div>

    <!-- ── Portfolio Summary + Pie ── -->
    <div class="dep-section" style="margin-top:12px">
      <div class="dep-section-header">
        <i class="ti ti-briefcase" aria-hidden="true"></i> Holdings
        <span class="dep-count">${CURRENT_TICKERS.filter(s => openPositions[s]).length} positions</span>
      </div>

      <div class="sgd-grid" style="margin-bottom:14px">
        <div class="sgd-cell"><div class="sgd-lbl">Amount Invested</div><div class="sgd-val pos">${fmt(totalCostBasis)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Market Value</div><div id="sum-mkt" class="sgd-val">${fmt(totalMktVal)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Unrealised P&L</div><div id="sum-unreal" class="sgd-val ${totalUnreal >= 0 ? 'pos' : 'neg'}">${totalUnreal > 0 ? '+' : ''}${fmt(totalUnreal)}</div></div>
        <div class="sgd-divider"></div>
        <div class="sgd-cell"><div class="sgd-lbl">Dividends Received</div><div class="sgd-val pos">${fmt(totalDiv)}</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">Return %</div><div id="sum-return" class="sgd-val ${totalUnreal >= 0 ? 'pos' : 'neg'}">${totalCostBasis > 0 ? (totalUnreal/totalCostBasis*100).toFixed(1) : '0.0'}%</div></div>
        <div class="sgd-cell"><div class="sgd-lbl">&nbsp;</div><div class="sgd-val"> </div></div>
      </div>

      <div class="holdings-pie-card">
        <canvas id="holdingsPie" aria-label="Holdings allocation chart"></canvas>
        <div class="pie-legend" id="pieLegend"></div>
      </div>

      <div class="inv-holdings">${tickerRows}</div>
    </div>

    ${buildCalculator()}
    ${buildOptionsSection()}`;

  attachIbFileInput();
  window._ibOpenPositions = openPositions;
  requestAnimationFrame(() => {
    renderOptChart();

    // ── Holdings pie chart ──
    const pie = el('holdingsPie');
    const legend = el('pieLegend');
    if (!pie || !window.Chart) return;

    const PIE_COLORS = ['#58a6ff','#3fb950','#f0883e','#bc8cff','#ff7b72','#ffa657','#39d353'];
    const pieLabels = [], pieValues = [], pieColors = [];
    const total = CURRENT_TICKERS.reduce((s, sym) => s + (openPositions[sym]?.costBasis || 0), 0);

    CURRENT_TICKERS.forEach((sym, i) => {
      const pos = openPositions[sym];
      if (!pos?.costBasis) return;
      pieLabels.push(sym);
      pieValues.push(+pos.costBasis.toFixed(2));
      pieColors.push(PIE_COLORS[i % PIE_COLORS.length]);
    });

    new Chart(pie, {
      type: 'doughnut',
      data: {
        labels: pieLabels,
        datasets: [{ data: pieValues, backgroundColor: pieColors,
          borderWidth: 3, borderColor: '#161b22', hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, cutout: '55%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => {
            const pct = (ctx.parsed / total * 100).toFixed(1);
            return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
          }}}
        }
      }
    });

    // Build legend
    if (legend) {
      legend.innerHTML = pieLabels.map((sym, i) => {
        const pct = (pieValues[i] / total * 100).toFixed(1);
        return `<div class="pie-legend-item">
          <span class="pie-dot" style="background:${pieColors[i]}"></span>
          <span class="pie-sym">${sym}</span>
          <span class="pie-pct">${pct}%</span>
        </div>`;
      }).join('');
    }
  });
  fetchAndUpdateLivePrices(CURRENT_TICKERS, openPositions);
}

window.toggleInvSym = function(sym) {
  const card = el(`inv-sym-${sym}`);
  if (card) card.classList.toggle('inv-expanded');
};

window.clearIbData = async function() {
  if (!confirm('Clear all IB investing data? This will also delete ib.json on GitHub.')) return;
  ibData = { trades: [], openPositions: {}, dividends: [], optionTrades: [], assignmentStocks: [], sgdDeposits: [], forexTrades: [], corporateActions: [] };
  if (ghToken) {
    try { await ghPutIb(ibData); } catch(e) { console.warn('Could not clear ib.json:', e); }
  }
  renderInvesting(el('tabContent'));
};

function attachIbFileInput() {
  const input = el('ibCsvInput');
  if (!input || input._wired) return;
  input._wired = true;
  input.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => mergeAndCommitIb(ev.target.result);
    reader.readAsText(file);
    e.target.value = '';
  });
}

async function mergeAndCommitIb(csvText) {
  const sbar = el('ib-status');
  const show = msg => { if (sbar) { sbar.textContent = msg; sbar.style.display = 'block'; } };

  const { trades: newTrades, positions: newPositions, dividends: newDivs,
          optionTrades: newOpts, assignmentStocks: newAssigns,
          sgdDeposits: newSgdDeps, forexTrades: newForex,
          corporateActions: newCorpActs } = parseIbCSV(csvText);

  const ibKey = t => `${t.symbol}|${t.dateRaw}|${t.qty}|${t.tPrice}`;
  const existingStockKeys  = new Set((ibData.trades || []).map(ibKey));
  const existingOptKeys    = new Set((ibData.optionTrades || []).map(ibKey));
  const existingAssgnKeys  = new Set((ibData.assignmentStocks || []).map(ibKey));

  const toAddStocks  = newTrades.filter(t => !existingStockKeys.has(ibKey(t)));
  const toAddOpts    = newOpts.filter(t => !existingOptKeys.has(ibKey(t)));
  const toAddAssigns = newAssigns.filter(t => !existingAssgnKeys.has(ibKey(t)));

  const totalNew = toAddStocks.length + toAddOpts.length + toAddAssigns.length;
  if (totalNew === 0 && Object.keys(newPositions).length === 0) {
    show('⚠️ No new data found — everything already imported.');
    return;
  }

  const merged = {
    trades:           [...(ibData.trades || []), ...toAddStocks],
    openPositions:    { ...(ibData.openPositions || {}), ...newPositions },
    dividends:        [...(ibData.dividends || []),
                       ...newDivs.filter(d => !(ibData.dividends || []).some(x => x.dateRaw === d.dateRaw && x.desc === d.desc))],
    optionTrades:     [...(ibData.optionTrades || []), ...toAddOpts],
    assignmentStocks: [...(ibData.assignmentStocks || []), ...toAddAssigns],
    sgdDeposits:      [...(ibData.sgdDeposits || []),
                       ...newSgdDeps.filter(d => !(ibData.sgdDeposits || []).some(x => x.dateRaw === d.dateRaw && x.amount === d.amount))],
    forexTrades:      [...(ibData.forexTrades || []),
                       ...newForex.filter(f => !(ibData.forexTrades || []).some(x => x.dateRaw === f.dateRaw && x.usdAmt === f.usdAmt))],
    corporateActions: [...(ibData.corporateActions || []),
                       ...newCorpActs.filter(a => !(ibData.corporateActions || []).some(x => x.symbol === a.symbol && x.date === a.date && x.type === a.type))],
  };

  show(`Saving ${totalNew} new rows to GitHub…`);
  const doSave = async () => {
    try {
      await ghPutIb(merged);
      show(`✓ ${toAddStocks.length} stock · ${toAddOpts.length} option · ${toAddAssigns.length} assignment trades added`);
      setTimeout(() => { if (sbar) sbar.style.display = 'none'; }, 5000);
      renderTabContent();
    } catch(e) {
      show(`Error: ${e.message}`);
    }
  };

  if (!ghToken) { showTokenModal(doSave); } else { await doSave(); }
}

// ── IB CSV parser ──────────────────────────────────────────────────────────
function parseIbCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const newPositions = {}, newDivs = [];
  const newOptionTrades = [];
  const newSgdDeposits = [];
  const newForexTrades = [];
  const newCorpActions = [];  // stock splits etc.
  const allStockRows = [];
  let section = '';

  for (const line of lines) {
    const cols = parseIbCSVLine(line);
    if (!cols.length) continue;
    const first  = cols[0]?.trim() || '';
    const second = cols[1]?.trim() || '';

    if (second === 'Header') { section = first.toLowerCase(); continue; }

    // ── trades ──
    if (section === 'trades' && first === 'Trades' && second === 'Data') {
      if ((cols[2] || '').trim() !== 'Order') continue;
      if (cols.length < 12) continue;
      const cat     = (cols[3] || '').trim();
      const symbol  = (cols[5] || '').trim();
      if (!symbol || symbol === 'Symbol') continue;
      const dateRaw = (cols[6] || '').trim();
      const qty     = safeFloat(cols[7]);
      const tPrice  = safeFloat(cols[8]);
      const proceeds = safeFloat(cols[10]);
      const comm    = safeFloat(cols[11]);
      const realPL  = safeFloat(cols[13]);
      const code    = (cols[cols.length - 1] || '').trim();

      if (cat.includes('Option') || (cat.includes('Future') && symbol.includes(' '))) {
        newOptionTrades.push({ symbol, dateRaw, qty, tPrice, proceeds, comm, realPL, code, cat });
      } else if (cat.includes('Stock')) {
        allStockRows.push({ symbol, dateRaw, qty, tPrice, proceeds, comm, realPL, code });
      } else if (cat.includes('Forex') && symbol.includes('SGD')) {
        // qty = USD received (+) or paid (-), proceeds = SGD paid (negative for buys)
        newForexTrades.push({ dateRaw, usdAmt: qty, sgdAmt: proceeds, rate: tPrice, comm });
      }
    }

    // ── open positions — capture cost basis ──
    if (section === 'open positions' && first === 'Open Positions' && second === 'Data') {
      if (cols.length < 12) continue;
      const symbol     = (cols[5] || '').trim();
      const qty        = safeFloat(cols[6]);
      const costPrice  = safeFloat(cols[8]);   // avg cost per share
      const costBasis  = safeFloat(cols[9]);   // total cost basis
      const closePrice = safeFloat(cols[10]);
      const mktValue   = safeFloat(cols[11]);
      const unrealPL   = safeFloat(cols[12]);
      if (!symbol || qty === 0) continue;
      newPositions[symbol] = { qty, costPrice, costBasis, closePrice, mktValue, unrealPL };
    }

    // ── dividends ──
    if (section === 'dividends' && first === 'Dividends' && second === 'Data') {
      if (cols.length < 6) continue;
      const dateRaw = (cols[3] || '').trim();
      const desc    = (cols[4] || '').trim();
      const amount  = safeFloat(cols[5]);
      if (amount > 0) newDivs.push({ dateRaw, desc, amount });
    }

    // ── corporate actions (splits, etc.) ──
    if (section === 'corporate actions' && first === 'Corporate Actions' && second === 'Data') {
      if (cols.length < 8) continue;
      const desc = (cols[6] || '').trim();
      const qty  = safeFloat(cols[7]);
      const date = (cols[4] || '').trim();
      // Parse "VGT(US92...) Split 8 for 1 (...)"
      const splitMatch = desc.match(/^(\w+)\(.*?\)\s+Split\s+(\d+)\s+for\s+(\d+)/i);
      if (splitMatch) {
        const symbol = splitMatch[1];
        const ratio  = parseInt(splitMatch[2]) + ':' + parseInt(splitMatch[3]);
        newCorpActions.push({ symbol, date, type: 'split', ratio, sharesAdded: qty, desc });
      }
    }

    // ── SGD deposits & withdrawals ──
    if ((section === 'deposits & withdrawals' || section === 'deposits &amp; withdrawals')
        && first === 'Deposits & Withdrawals' && second === 'Data') {
      if (cols.length < 6) continue;
      const currency = (cols[2] || '').trim();
      if (currency !== 'SGD') continue;
      const dateRaw = (cols[3] || '').trim();
      const desc    = (cols[4] || '').trim();
      const amount  = safeFloat(cols[5]);
      if (amount !== 0) newSgdDeposits.push({ dateRaw, desc, amount });
    }
  }

  // Second pass: separate assignment stocks from DCA stocks
  const assignedSymbols = new Set(
    allStockRows.filter(r => r.code.split(';').includes('A')).map(r => r.symbol)
  );
  const newTrades = [], newAssignmentStocks = [];
  for (const r of allStockRows) {
    if (assignedSymbols.has(r.symbol)) newAssignmentStocks.push(r);
    else newTrades.push(r);
  }

  return { trades: newTrades, positions: newPositions, dividends: newDivs,
           optionTrades: newOptionTrades, assignmentStocks: newAssignmentStocks,
           sgdDeposits: newSgdDeposits, forexTrades: newForexTrades,
           corporateActions: newCorpActions };
}

function safeFloat(s) {
  try { return parseFloat(String(s || '').replace(/,/g, '')) || 0; } catch(_) { return 0; }
}


function parseIbCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

// ── File handlers ──────────────────────────────────────────────────────────
function attachFileHandlers() {
  const fileInput=el('fileInput'), zone=el('uploadZone');
  fileInput.addEventListener('change', e => {
    const file=e.target.files[0]; if (!file) return;
    const reader=new FileReader();
    reader.onload=ev=>mergeAndCommit(ev.target.result);
    reader.readAsText(file); e.target.value='';
  });
  zone.addEventListener('click',    ()=>fileInput.click());
  zone.addEventListener('keydown',  e=>{if(e.key==='Enter'||e.key===' ')fileInput.click();});
  zone.addEventListener('dragover', e=>{e.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{
    e.preventDefault();zone.classList.remove('drag-over');
    const file=e.dataTransfer.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>mergeAndCommit(ev.target.result);
    reader.readAsText(file);
  });

  // Settings button
  el('settingsBtn').addEventListener('click', () => {
    if (!el('tokenPanel').hidden) {
      hideTokenPanel();
    } else {
      showTokenModal(() => loadFromGitHub());
    }
  });

  // Token panel buttons — wired once at startup, no dynamic cloning needed
  el('tokenSaveBtn').addEventListener('click', doTokenSave);
  el('tokenCancelBtn').addEventListener('click', hideTokenPanel);
  el('tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doTokenSave(); });
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  attachFileHandlers();
  loadFromGitHub();
});