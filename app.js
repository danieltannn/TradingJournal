'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allData = [];
let processed = null;
let activeTab = 0;
let pages = {};

const TABS = [
  { label: 'Summary',       icon: 'ti-layout-dashboard' },
  { label: 'Deposits',      icon: 'ti-wallet' },
  { label: 'Open Trades',   icon: 'ti-lock-open' },
  { label: 'Closed Trades', icon: 'ti-lock' },
  { label: 'All Transactions', icon: 'ti-list' }
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
  const str = frac !== undefined ? intFmt + '.' + frac : intFmt;
  return (n < 0 ? '-' : '') + '$' + str;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function el(id) { return document.getElementById(id); }

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

// ── Data processing ────────────────────────────────────────────────────────
function processData(rows) {
  const deposits = rows.filter(r => r['Type'] === 'Money Movement');
  const trades   = rows.filter(r => r['Type'] === 'Trade');
  const expiries = rows.filter(r => r['Type'] === 'Receive Deliver' && r['Sub Type'] === 'Expiration');

  // Group trade legs by symbol
  const tradeGroups = {};
  trades.forEach(r => {
    const sym = r['Symbol'] || '';
    if (!tradeGroups[sym]) tradeGroups[sym] = [];
    tradeGroups[sym].push(r);
  });

  // Symbols with any open leg
  const openSyms = new Set(
    trades.filter(r => (r['Action'] || '').includes('OPEN')).map(r => r['Symbol'])
  );

  // Symbols that have been closed or expired
  const closedSyms = new Set([
    ...trades.filter(r => (r['Action'] || '').includes('CLOSE')).map(r => r['Symbol']),
    ...expiries.map(r => r['Symbol'])
  ]);

  const trulyOpen   = [...openSyms].filter(s => !closedSyms.has(s));
  const trulyClosed = [...openSyms].filter(s =>  closedSyms.has(s));

  // P&L per symbol (all trade legs + expiry rows)
  const pnlBySymbol = {};
  [...trulyOpen, ...trulyClosed].forEach(sym => {
    const symRows = [...(tradeGroups[sym] || []), ...expiries.filter(e => e['Symbol'] === sym)];
    let net = 0;
    symRows.forEach(r => {
      net += parseVal(r['Value']);
      net += parseVal(r['Commissions']);
      net -= Math.abs(parseVal(r['Fees']));
    });
    pnlBySymbol[sym] = net;
  });

  return { deposits, trades, expiries, tradeGroups, trulyOpen, trulyClosed, pnlBySymbol };
}

// ── Metric cards ───────────────────────────────────────────────────────────
function renderMetrics() {
  const { deposits, trades, trulyOpen, trulyClosed, pnlBySymbol } = processed;

  const totalDeposits = deposits.filter(r => r['Sub Type'] === 'Deposit')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalInterest = deposits.filter(r => r['Sub Type'] === 'Credit Interest')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalAdj = deposits.filter(r => r['Sub Type'] === 'Balance Adjustment')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const tradePnl = trades.reduce((s, r) =>
    s + parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees'])), 0);
  const balance = totalDeposits + totalInterest + totalAdj + tradePnl;
  const closedPnl = trulyClosed.reduce((s, sym) => s + (pnlBySymbol[sym] || 0), 0);

  const metrics = [
    { label: 'Account Balance',    value: fmt(balance),           cls: balance   >= 0 ? 'pos' : 'neg' },
    { label: 'Total Deposited',    value: fmt(totalDeposits),     cls: '' },
    { label: 'Closed P&L',        value: fmt(closedPnl),         cls: closedPnl >= 0 ? 'pos' : 'neg' },
    { label: 'Open Positions',     value: trulyOpen.length,       cls: '' },
    { label: 'Closed Positions',   value: trulyClosed.length,     cls: '' },
    { label: 'Total Trades',       value: trades.length,          cls: '' },
  ];

  el('metricsRow').innerHTML = metrics.map(m =>
    `<div class="metric">
       <div class="label">${m.label}</div>
       <div class="value ${m.cls}">${m.value}</div>
     </div>`
  ).join('');
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function renderTabs() {
  el('tabBar').innerHTML = TABS.map((t, i) =>
    `<button class="tab ${i === activeTab ? 'active' : ''}"
             role="tab" aria-selected="${i === activeTab}"
             onclick="switchTab(${i})">
       <i class="ti ${t.icon}" aria-hidden="true"></i>${t.label}
     </button>`
  ).join('');
}

function switchTab(i) {
  activeTab = i;
  renderTabs();
  renderTabContent();
}
window.switchTab = switchTab;

function renderTabContent() {
  const container = el('tabContent');
  const fns = [renderSummary, renderDeposits, renderOpen, renderClosed, renderAll];
  fns[activeTab](container);
}

// ── Pagination helper ──────────────────────────────────────────────────────
const PAGE_SIZE = 20;

function paginate(key, rows, renderRow, headers, container) {
  if (!pages[key]) pages[key] = 1;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages[key] > totalPages) pages[key] = totalPages;
  const start = (pages[key] - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  const thead = headers.map(h =>
    `<th${h.w ? ` style="width:${h.w}"` : ''}>${h.label}</th>`
  ).join('');
  const tbody = slice.length
    ? slice.map(renderRow).join('')
    : `<tr><td colspan="${headers.length}" class="empty">No records found</td></tr>`;

  const pg = `
    <div class="pg">
      <span>${total} record${total !== 1 ? 's' : ''}</span>
      ${pages[key] > 1
        ? `<button onclick="changePage('${key}',-1)">← Prev</button>` : ''}
      <span>Page ${pages[key]} / ${totalPages}</span>
      ${pages[key] < totalPages
        ? `<button onclick="changePage('${key}',1)">Next →</button>` : ''}
    </div>`;

  return `<div class="tbl-wrap">
    <table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>${pg}`;
}

window.changePage = function(key, dir) {
  pages[key] = (pages[key] || 1) + dir;
  renderTabContent();
};

// ── Summary tab ────────────────────────────────────────────────────────────
function renderSummary(container) {
  const { trulyClosed, pnlBySymbol } = processed;

  const sorted = [...trulyClosed].sort((a, b) => (pnlBySymbol[b] || 0) - (pnlBySymbol[a] || 0));
  const top5   = sorted.slice(0, 5);
  const bot5   = sorted.slice(-5).reverse();

  // Monthly P&L from all trade rows
  const monthPnl = {};
  processed.trades.forEach(r => {
    const d = new Date(r['Date']);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const val = parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees']));
    monthPnl[key] = (monthPnl[key] || 0) + val;
  });
  const months = Object.keys(monthPnl).sort();

  const symList = (items) => items.map(s => {
    const v = pnlBySymbol[s] || 0;
    return `<div class="sym-row">
      <span class="sym-name mono">${s}</span>
      <span class="sym-val ${v >= 0 ? 'pos' : 'neg'}">${fmt(v)}</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card">
        <h3>Top 5 winners</h3>${symList(top5)}
      </div>
      <div class="summary-card">
        <h3>Top 5 losers</h3>${symList(bot5)}
      </div>
    </div>
    <div class="chart-card">
      <h3>Monthly P&L</h3>
      <div style="position:relative;height:${Math.max(180, months.length * 26)}px">
        <canvas id="monthChart"
          role="img"
          aria-label="Monthly P&L bar chart showing trading performance by month">
          Monthly P&L data for ${months.length} months.
        </canvas>
      </div>
    </div>`;

  // Draw chart after DOM is ready
  requestAnimationFrame(() => {
    const canvas = el('monthChart');
    if (!canvas || !window.Chart) return;
    const vals = months.map(m => +monthPnl[m].toFixed(2));
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    const labelColor = isDark ? '#a0a09b' : '#6b6b67';

    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: months.map(m => {
          const [y, mo] = m.split('-');
          return new Date(y, mo - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
        }),
        datasets: [{
          label: 'P&L',
          data: vals,
          backgroundColor: vals.map(v => v >= 0 ? 'rgba(29,158,117,0.75)' : 'rgba(216,90,48,0.75)'),
          borderRadius: 3,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: {
              font: { size: 11 },
              color: labelColor,
              autoSkip: false,
              maxRotation: 45,
            },
            grid: { color: gridColor }
          },
          y: {
            ticks: {
              font: { size: 11 },
              color: labelColor,
              callback: v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString()
            },
            grid: { color: gridColor }
          }
        }
      }
    });
  });
}

// ── Deposits tab ───────────────────────────────────────────────────────────
function renderDeposits(container) {
  const { deposits } = processed;
  const sorted = [...deposits].sort((a, b) => new Date(b['Date']) - new Date(a['Date']));

  const totalDep = deposits.filter(r => r['Sub Type'] === 'Deposit')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalInt = deposits.filter(r => r['Sub Type'] === 'Credit Interest')
    .reduce((s, r) => s + parseVal(r['Total']), 0);

  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Total deposits</div><div class="value pos">${fmt(totalDep)}</div></div>
      <div class="metric"><div class="label">Interest earned</div><div class="value pos">${fmt(totalInt)}</div></div>
      <div class="metric"><div class="label">Total movements</div><div class="value">${deposits.length}</div></div>
    </div>
    ${paginate('dep', sorted, r => {
      const total = parseVal(r['Total']);
      return `<tr>
        <td>${fmtDate(r['Date'])}</td>
        <td><span class="badge ${r['Sub Type'] === 'Deposit' ? 'open' : 'closed'}">${r['Sub Type']}</span></td>
        <td style="max-width:200px">${r['Description']}</td>
        <td class="${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</td>
      </tr>`;
    }, [
      { label: 'Date', w: '90px' },
      { label: 'Sub type', w: '110px' },
      { label: 'Description' },
      { label: 'Amount', w: '90px' }
    ], container)}`;
}

// ── Open trades tab ────────────────────────────────────────────────────────
function getOpenRows() {
  const { trulyOpen, tradeGroups } = processed;
  return trulyOpen
    .flatMap(sym => (tradeGroups[sym] || []).filter(r => (r['Action'] || '').includes('OPEN')))
    .sort((a, b) => new Date(b['Date']) - new Date(a['Date']));
}

function renderOpen(container) {
  const rows = getOpenRows();
  const totalCost = rows.reduce((s, r) => s + parseVal(r['Total']), 0);

  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Open positions</div><div class="value">${processed.trulyOpen.length}</div></div>
      <div class="metric"><div class="label">Net credit / debit</div><div class="value ${totalCost >= 0 ? 'pos' : 'neg'}">${fmt(totalCost)}</div></div>
      <div class="metric"><div class="label">Total legs</div><div class="value">${rows.length}</div></div>
    </div>
    <div class="search-row">
      <input id="openSearch" placeholder="Search symbol, type…" oninput="filterOpen(this.value)">
    </div>
    <div id="openTable">${buildOpenTable(rows)}</div>`;
}

window.filterOpen = function(q) {
  const rows = getOpenRows();
  const filtered = q
    ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))
    : rows;
  el('openTable').innerHTML = buildOpenTable(filtered);
};

function buildOpenTable(rows) {
  return paginate('open', rows, r => {
    const total = parseVal(r['Total']);
    const cp = r['Call or Put'];
    return `<tr>
      <td>${fmtDate(r['Date'])}</td>
      <td class="mono">${r['Symbol']}</td>
      <td>${r['Underlying Symbol'] || '—'}</td>
      <td><span class="badge open">${(r['Sub Type'] || '').replace(' to ', '→')}</span></td>
      <td>${cp ? `<span class="badge ${cp.toLowerCase()}">${cp[0]}</span>` : '—'}</td>
      <td>${r['Strike Price'] ? fmt(parseFloat(r['Strike Price']), 0) : '—'}</td>
      <td>${r['Expiration Date'] || '—'}</td>
      <td>${r['Quantity'] || '—'}</td>
      <td>${r['Average Price'] && r['Average Price'] !== '--' ? r['Average Price'] : '—'}</td>
      <td class="neg">${r['Commissions'] !== '--' && r['Commissions'] ? fmt(parseVal(r['Commissions'])) : '—'}</td>
      <td class="neg">${r['Fees'] ? fmt(-Math.abs(parseVal(r['Fees']))) : '—'}</td>
      <td class="${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</td>
    </tr>`;
  }, [
    { label: 'Date', w: '82px' }, { label: 'Symbol' }, { label: 'U/L', w: '50px' },
    { label: 'Action', w: '90px' }, { label: 'P/C', w: '40px' }, { label: 'Strike', w: '60px' },
    { label: 'Exp', w: '80px' }, { label: 'Qty', w: '35px' }, { label: 'Avg px', w: '60px' },
    { label: 'Comm', w: '55px' }, { label: 'Fees', w: '45px' }, { label: 'Total', w: '80px' }
  ], null);
}

// ── Closed trades tab ──────────────────────────────────────────────────────
function buildClosedSymRows() {
  const { trulyClosed, pnlBySymbol, tradeGroups, expiries } = processed;
  return trulyClosed.map(sym => {
    const symTrades = [...(tradeGroups[sym] || []), ...expiries.filter(e => e['Symbol'] === sym)];
    const opens  = symTrades.filter(r => (r['Action'] || '').includes('OPEN'));
    const closes = symTrades.filter(r => (r['Action'] || '').includes('CLOSE'));
    const allDates  = symTrades.map(r => new Date(r['Date']));
    const openDate  = new Date(Math.min(...allDates));
    const closeDate = new Date(Math.max(...allDates));
    const openVal   = opens.reduce((s, r)  => s + parseVal(r['Total']), 0);
    const closeVal  = closes.reduce((s, r) => s + parseVal(r['Total']), 0);
    const comm = symTrades.reduce((s, r) => s + parseVal(r['Commissions']), 0);
    const fees = symTrades.reduce((s, r) => s - Math.abs(parseVal(r['Fees'])), 0);
    const pnl  = pnlBySymbol[sym] || 0;
    const isExpired = symTrades.some(r => r['Type'] === 'Receive Deliver');
    const sample = opens[0] || symTrades[0];
    return { sym, openDate, closeDate, openVal, closeVal, comm, fees, pnl, isExpired, sample };
  }).sort((a, b) => b.closeDate - a.closeDate);
}

function renderClosed(container) {
  const { trulyClosed, pnlBySymbol } = processed;
  const closedPnl = trulyClosed.reduce((s, sym) => s + (pnlBySymbol[sym] || 0), 0);
  const winners   = trulyClosed.filter(s => (pnlBySymbol[s] || 0) > 0).length;
  const losers    = trulyClosed.filter(s => (pnlBySymbol[s] || 0) < 0).length;
  const symRows   = buildClosedSymRows();

  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Total closed P&L</div><div class="value ${closedPnl >= 0 ? 'pos' : 'neg'}">${fmt(closedPnl)}</div></div>
      <div class="metric"><div class="label">Winners</div><div class="value pos">${winners}</div></div>
      <div class="metric"><div class="label">Losers</div><div class="value neg">${losers}</div></div>
      <div class="metric"><div class="label">Win rate</div><div class="value">${trulyClosed.length ? Math.round(winners / trulyClosed.length * 100) : 0}%</div></div>
    </div>
    <div class="search-row">
      <input id="closedSearch" placeholder="Search symbol…" oninput="filterClosed(this.value)" style="max-width:260px">
    </div>
    <div id="closedTable">${buildClosedTable(symRows)}</div>`;
}

window.filterClosed = function(q) {
  const symRows = buildClosedSymRows();
  const filtered = q
    ? symRows.filter(r => r.sym.toLowerCase().includes(q.toLowerCase()))
    : symRows;
  el('closedTable').innerHTML = buildClosedTable(filtered);
};

function buildClosedTable(symRows) {
  return paginate('closed', symRows, r => `<tr>
    <td class="mono">${r.sym}</td>
    <td>${r.sample?.['Underlying Symbol'] || '—'}</td>
    <td>${fmtDate(r.openDate)}</td>
    <td>${fmtDate(r.closeDate)}</td>
    <td class="${r.openVal  >= 0 ? 'pos' : 'neg'}">${fmt(r.openVal)}</td>
    <td class="${r.closeVal >= 0 ? 'pos' : 'neg'}">${fmt(r.closeVal)}</td>
    <td class="neg">${fmt(r.comm)}</td>
    <td class="neg">${fmt(r.fees)}</td>
    <td class="${r.pnl >= 0 ? 'pos' : 'neg'}" style="font-weight:600">${fmt(r.pnl)}</td>
    <td><span class="badge ${r.isExpired ? 'expired' : 'closed'}">${r.isExpired ? 'Expired' : 'Closed'}</span></td>
  </tr>`, [
    { label: 'Symbol' },       { label: 'U/L', w: '50px' },
    { label: 'Opened', w: '82px' }, { label: 'Closed', w: '82px' },
    { label: 'Open cost', w: '80px' }, { label: 'Close val', w: '80px' },
    { label: 'Comm', w: '60px' }, { label: 'Fees', w: '50px' },
    { label: 'Net P&L', w: '82px' }, { label: 'Status', w: '70px' }
  ], null);
}

// ── All transactions tab ───────────────────────────────────────────────────
function getAllRows(q, typeFilter) {
  let rows = [...allData].sort((a, b) => new Date(b['Date']) - new Date(a['Date']));
  if (typeFilter) rows = rows.filter(r => r['Type'] === typeFilter);
  if (q) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  return rows;
}

function renderAll(container) {
  container.innerHTML = `
    <div class="search-row">
      <input id="allSearch" placeholder="Search anything…" oninput="filterAll()" style="max-width:260px">
      <select id="allType" onchange="filterAll()">
        <option value="">All types</option>
        <option>Trade</option>
        <option>Money Movement</option>
        <option>Receive Deliver</option>
      </select>
    </div>
    <div id="allTable">${buildAllTable('', '')}</div>`;
}

window.filterAll = function() {
  const q    = (el('allSearch')?.value || '').trim();
  const type = el('allType')?.value || '';
  pages['all'] = 1;
  el('allTable').innerHTML = buildAllTable(q, type);
};

function buildAllTable(q, typeFilter) {
  const rows = getAllRows(q, typeFilter);
  return paginate('all', rows, r => {
    const total = parseVal(r['Total']);
    const typeBadge = r['Type'] === 'Trade' ? 'trade'
      : r['Type'] === 'Money Movement' ? 'money' : 'deliver';
    return `<tr>
      <td>${fmtDate(r['Date'])}</td>
      <td><span class="badge ${typeBadge}">${r['Type']}</span></td>
      <td style="font-size:11px">${r['Sub Type'] || '—'}</td>
      <td class="mono">${r['Symbol'] || '—'}</td>
      <td style="font-size:11.5px;color:var(--text-secondary)">${r['Description'] || '—'}</td>
      <td class="neg">${r['Commissions'] && r['Commissions'] !== '--' ? fmt(parseVal(r['Commissions'])) : '—'}</td>
      <td class="neg">${r['Fees'] ? fmt(-Math.abs(parseVal(r['Fees']))) : '—'}</td>
      <td class="${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</td>
    </tr>`;
  }, [
    { label: 'Date', w: '82px' }, { label: 'Type', w: '90px' },
    { label: 'Sub type', w: '90px' }, { label: 'Symbol' },
    { label: 'Description', w: '170px' },
    { label: 'Comm', w: '55px' }, { label: 'Fees', w: '45px' }, { label: 'Total', w: '80px' }
  ], null);
}

// ── Load data ──────────────────────────────────────────────────────────────
function loadCSV(text) {
  allData   = parseCSV(text);
  processed = processData(allData);
  pages     = {};

  el('uploadZone').hidden  = true;
  el('dashboard').hidden   = false;

  renderMetrics();
  renderTabs();
  renderTabContent();
}

// ── File input ─────────────────────────────────────────────────────────────
function attachFileHandlers() {
  const fileInput = el('fileInput');
  const zone      = el('uploadZone');

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadCSV(ev.target.result);
    reader.readAsText(file);
  });

  // Also trigger upload via click on zone
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  // Drag and drop
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadCSV(ev.target.result);
    reader.readAsText(file);
  });
}

document.addEventListener('DOMContentLoaded', attachFileHandlers);
