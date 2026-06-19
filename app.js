'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allData = [];
let processed = null;
let activeTab = 0;
let pages = {};

const TABS = [
  { label: 'Summary',      icon: 'ti-layout-dashboard' },
  { label: 'Deposits',     icon: 'ti-wallet' },
  { label: 'Trades',       icon: 'ti-arrows-exchange' },
  { label: 'All Ledger',   icon: 'ti-list' }
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
  const tradeRows = rows.filter(r => r['Type'] === 'Trade');
  const expiries  = rows.filter(r => r['Type'] === 'Receive Deliver' && r['Sub Type'] === 'Expiration');

  // Group trade legs by Order #
  const orderMap = {};
  tradeRows.forEach(r => {
    const oid = r['Order #'];
    if (!oid) return;
    if (!orderMap[oid]) orderMap[oid] = [];
    orderMap[oid].push(r);
  });

  // Map each symbol to the open order that created it
  const symToOpenOrder = {};
  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (legs.some(l => l['Action'].includes('OPEN'))) {
      legs.forEach(l => { symToOpenOrder[l['Symbol']] = oid; });
    }
  });

  // Map open orders → their corresponding close orders and expiry rows
  const openToCloseOrders = {};
  const openToExpiries = {};

  Object.entries(orderMap).forEach(([oid, legs]) => {
    if (legs.every(l => l['Action'].includes('CLOSE'))) {
      legs.forEach(l => {
        const parent = symToOpenOrder[l['Symbol']];
        if (!parent) return;
        if (!openToCloseOrders[parent]) openToCloseOrders[parent] = [];
        if (!openToCloseOrders[parent].includes(oid)) openToCloseOrders[parent].push(oid);
      });
    }
  });

  expiries.forEach(exp => {
    const parent = symToOpenOrder[exp['Symbol']];
    if (!parent) return;
    if (!openToExpiries[parent]) openToExpiries[parent] = [];
    openToExpiries[parent].push(exp);
  });

  // Build position objects — one per open order
  const positions = [];
  Object.entries(orderMap).forEach(([oid, legs]) => {
    const openLegs = legs.filter(l => l['Action'].includes('OPEN'));
    if (!openLegs.length) return;

    const closeOids   = openToCloseOrders[oid] || [];
    const expiryRows  = openToExpiries[oid] || [];
    const closeLegs   = closeOids.flatMap(cid => orderMap[cid] || []);
    const isClosed    = closeLegs.length > 0 || expiryRows.length > 0;
    const isExpired   = expiryRows.length > 0;

    const sample    = openLegs[0];
    const openDate  = openLegs.reduce((min, l) => l['Date'] < min ? l['Date'] : min, openLegs[0]['Date']);
    const allClose  = [...closeLegs, ...expiryRows];
    const closeDate = allClose.length
      ? allClose.reduce((max, l) => l['Date'] > max ? l['Date'] : max, allClose[0]['Date'])
      : null;

    const openTotal  = openLegs.reduce((s, l) => s + parseVal(l['Total']), 0);
    const closeTotal = [...closeLegs, ...expiryRows].reduce((s, l) => s + parseVal(l['Total']), 0);
    const openComm   = openLegs.reduce((s, l) => s + parseVal(l['Commissions']), 0);
    const openFees   = openLegs.reduce((s, l) => s - Math.abs(parseVal(l['Fees'])), 0);
    const closeComm  = closeLegs.reduce((s, l) => s + parseVal(l['Commissions']), 0);
    const closeFees  = closeLegs.reduce((s, l) => s - Math.abs(parseVal(l['Fees'])), 0);
    // Net P&L = open total (already net of open comm+fees) + close total (already net of close comm+fees)
    const netPnl = openTotal + closeTotal;

    positions.push({
      oid,
      ul: sample['Underlying Symbol'] || sample['Root Symbol'] || '—',
      expDate: sample['Expiration Date'] || '—',
      openDate,
      closeDate,
      isClosed,
      isExpired,
      openLegs,
      closeLegs,
      expiryRows,
      openTotal,
      closeTotal,
      openComm,
      openFees,
      closeComm,
      closeFees,
      netPnl,
    });
  });

  // Sort: open first (by open date desc), then closed (by close date desc)
  positions.sort((a, b) => {
    if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
    const da = a.isClosed ? a.closeDate : a.openDate;
    const db = b.isClosed ? b.closeDate : b.openDate;
    return da > db ? -1 : da < db ? 1 : 0;
  });

  const totalDeposits = deposits.filter(r => r['Sub Type'] === 'Deposit')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalInterest = deposits.filter(r => r['Sub Type'] === 'Credit Interest')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalAdj = deposits.filter(r => r['Sub Type'] === 'Balance Adjustment')
    .reduce((s, r) => s + parseVal(r['Total']), 0);
  const tradePnl = tradeRows.reduce((s, r) =>
    s + parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees'])), 0);
  const balance = totalDeposits + totalInterest + totalAdj + tradePnl;

  return { deposits, tradeRows, expiries, positions, balance, totalDeposits };
}

// ── Metric cards ───────────────────────────────────────────────────────────
function renderMetrics() {
  const { positions, balance, totalDeposits } = processed;
  const closed    = positions.filter(p => p.isClosed);
  const open      = positions.filter(p => !p.isClosed);
  const closedPnl = closed.reduce((s, p) => s + p.netPnl, 0);
  const winners   = closed.filter(p => p.netPnl > 0).length;
  const winRate   = closed.length ? Math.round(winners / closed.length * 100) : 0;

  const metrics = [
    { label: 'Account Balance',  value: fmt(balance),      cls: balance   >= 0 ? 'pos' : 'neg' },
    { label: 'Total Deposited',  value: fmt(totalDeposits), cls: '' },
    { label: 'Closed P&L',      value: fmt(closedPnl),    cls: closedPnl >= 0 ? 'pos' : 'neg' },
    { label: 'Open Positions',   value: open.length,       cls: '' },
    { label: 'Closed Positions', value: closed.length,     cls: '' },
    { label: 'Win Rate',         value: winRate + '%',     cls: winRate >= 50 ? 'pos' : 'neg' },
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
  [renderSummary, renderDeposits, renderTrades, renderAll][activeTab](container);
}

// ── Pagination ─────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;
window.changePage = function(key, dir) {
  pages[key] = (pages[key] || 1) + dir;
  renderTabContent();
};

function paginate(key, rows, renderRow, headers) {
  if (!pages[key]) pages[key] = 1;
  const total      = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages[key] > totalPages) pages[key] = totalPages;
  const slice  = rows.slice((pages[key] - 1) * PAGE_SIZE, pages[key] * PAGE_SIZE);
  const thead  = headers.map(h => `<th${h.w ? ` style="width:${h.w}"` : ''}>${h.label}</th>`).join('');
  const tbody  = slice.length
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
  const top5   = sorted.slice(0, 5);
  const bot5   = sorted.slice(-5).reverse();

  const monthPnl = {};
  processed.tradeRows.forEach(r => {
    const d   = new Date(r['Date']);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const val = parseVal(r['Value']) + parseVal(r['Commissions']) - Math.abs(parseVal(r['Fees']));
    monthPnl[key] = (monthPnl[key] || 0) + val;
  });
  const months = Object.keys(monthPnl).sort();

  const symList = items => items.map(p => `
    <div class="sym-row">
      <span class="sym-name mono">${p.ul} ${p.expDate}</span>
      <span class="sym-val ${p.netPnl >= 0 ? 'pos' : 'neg'}">${fmt(p.netPnl)}</span>
    </div>`).join('');

  container.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><h3>Top 5 winners</h3>${symList(top5)}</div>
      <div class="summary-card"><h3>Top 5 losers</h3>${symList(bot5)}</div>
    </div>
    <div class="chart-card">
      <h3>Monthly P&L</h3>
      <div style="position:relative;height:${Math.max(180, months.length * 26)}px">
        <canvas id="monthChart" role="img" aria-label="Monthly P&L bar chart">Monthly P&L data for ${months.length} months.</canvas>
      </div>
    </div>`;

  requestAnimationFrame(() => {
    const canvas = el('monthChart');
    if (!canvas || !window.Chart) return;
    const vals = months.map(m => +monthPnl[m].toFixed(2));
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const gridColor  = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
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
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 11 }, color: labelColor, autoSkip: false, maxRotation: 45 }, grid: { color: gridColor } },
          y: { ticks: { font: { size: 11 }, color: labelColor, callback: v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString() }, grid: { color: gridColor } }
        }
      }
    });
  });
}

// ── Deposits tab ───────────────────────────────────────────────────────────
function renderDeposits(container) {
  const { deposits } = processed;
  const sorted    = [...deposits].sort((a, b) => new Date(b['Date']) - new Date(a['Date']));
  const totalDep  = deposits.filter(r => r['Sub Type'] === 'Deposit').reduce((s, r) => s + parseVal(r['Total']), 0);
  const totalInt  = deposits.filter(r => r['Sub Type'] === 'Credit Interest').reduce((s, r) => s + parseVal(r['Total']), 0);

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
        <td>${r['Description']}</td>
        <td class="${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</td>
      </tr>`;
    }, [
      { label: 'Date', w: '90px' }, { label: 'Type', w: '110px' },
      { label: 'Description' }, { label: 'Amount', w: '90px' }
    ])}`;
}

// ── Trades tab (unified open + close side by side) ─────────────────────────
function renderTrades(container) {
  const { positions } = processed;
  const open   = positions.filter(p => !p.isClosed);
  const closed = positions.filter(p =>  p.isClosed);
  const closedPnl = closed.reduce((s, p) => s + p.netPnl, 0);
  const winners   = closed.filter(p => p.netPnl > 0).length;

  container.innerHTML = `
    <div class="section-metrics">
      <div class="metric"><div class="label">Closed P&L</div><div class="value ${closedPnl >= 0 ? 'pos' : 'neg'}">${fmt(closedPnl)}</div></div>
      <div class="metric"><div class="label">Open</div><div class="value">${open.length}</div></div>
      <div class="metric"><div class="label">Closed</div><div class="value">${closed.length}</div></div>
      <div class="metric"><div class="label">Winners / Losers</div><div class="value">${winners} / ${closed.length - winners}</div></div>
    </div>
    <div class="search-row">
      <input id="tradeSearch" placeholder="Search underlying, symbol…" oninput="filterTrades(this.value)">
      <select id="tradeFilter" onchange="filterTrades(document.getElementById('tradeSearch').value)">
        <option value="all">All positions</option>
        <option value="open">Open only</option>
        <option value="closed">Closed only</option>
      </select>
    </div>
    <div id="tradesTable">${buildTradesTable(positions, '', 'all')}</div>`;
}

window.filterTrades = function(q) {
  const filter = el('tradeFilter')?.value || 'all';
  pages['trades'] = 1;
  el('tradesTable').innerHTML = buildTradesTable(processed.positions, q || '', filter);
};

function legsHtml(legs, type) {
  if (!legs.length) return '<span style="color:var(--text-tertiary);font-size:11px">—</span>';
  return legs.map(l => {
    const action = l['Action'] || '';
    const isSell = action.startsWith('SELL');
    const cp     = l['Call or Put'];
    const strike = l['Strike Price'] ? parseFloat(l['Strike Price']).toFixed(0) : '';
    const qty    = l['Quantity'] || '';
    const total  = parseVal(l['Total']);
    const avgPx  = l['Average Price'] && l['Average Price'] !== '--' ? l['Average Price'] : '';
    const comm   = parseVal(l['Commissions']);
    const fees   = -Math.abs(parseVal(l['Fees']));
    return `<div class="leg-row">
      <span class="leg-action ${isSell ? 'leg-sell' : 'leg-buy'}">${isSell ? 'S' : 'B'}</span>
      <span class="leg-detail">
        <span class="mono leg-sym">${l['Symbol'] || '—'}</span>
        <span class="leg-meta">${cp ? cp[0] : ''} ${strike ? '@' + strike : ''} × ${qty}${avgPx ? ' · px ' + avgPx : ''}</span>
        <span class="leg-nums">
          <span class="${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</span>
          <span class="leg-cf">comm ${fmt(comm)} · fees ${fmt(fees)}</span>
        </span>
      </span>
    </div>`;
  }).join('');
}

function buildTradesTable(positions, q, filter) {
  let rows = positions;
  if (filter === 'open')   rows = rows.filter(p => !p.isClosed);
  if (filter === 'closed') rows = rows.filter(p =>  p.isClosed);
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter(p =>
      p.ul.toLowerCase().includes(ql) ||
      p.expDate.toLowerCase().includes(ql) ||
      p.openLegs.some(l => l['Symbol'].toLowerCase().includes(ql))
    );
  }

  if (!rows.length) {
    return '<div class="empty">No positions found</div>';
  }

  if (!pages['trades']) pages['trades'] = 1;
  const total      = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages['trades'] > totalPages) pages['trades'] = totalPages;
  const slice = rows.slice((pages['trades'] - 1) * PAGE_SIZE, pages['trades'] * PAGE_SIZE);

  const rowsHtml = slice.map(p => {
    const statusBadge = p.isClosed
      ? `<span class="badge ${p.isExpired ? 'expired' : 'closed'}">${p.isExpired ? 'Expired' : 'Closed'}</span>`
      : `<span class="badge open">Open</span>`;
    const pnlClass = p.netPnl >= 0 ? 'pos' : 'neg';
    // For open positions, P&L is the open total (credit/debit received to open)
    const pnlLabel = p.isClosed ? 'Net P&L' : 'Open P&L';
    const pnlVal   = p.isClosed ? p.netPnl : p.openTotal;

    return `<div class="trade-row ${p.isClosed ? 'trade-closed' : 'trade-open'}">
      <div class="trade-header">
        <div class="trade-header-left">
          <span class="trade-ul">${p.ul}</span>
          <span class="trade-exp">exp ${p.expDate}</span>
          ${statusBadge}
        </div>
        <div class="trade-pnl">
          <span class="pnl-label">${pnlLabel}</span>
          <span class="pnl-value ${pnlClass}">${fmt(pnlVal)}</span>
        </div>
      </div>
      <div class="trade-body">
        <div class="trade-side">
          <div class="side-label">
            <i class="ti ti-lock-open" aria-hidden="true"></i>
            Opened ${fmtDate(p.openDate)}
          </div>
          <div class="legs">${legsHtml(p.openLegs, 'open')}</div>
          <div class="side-total">
            Total <span class="${p.openTotal >= 0 ? 'pos' : 'neg'}">${fmt(p.openTotal)}</span>
          </div>
        </div>
        <div class="trade-divider" aria-hidden="true">
          <div class="divider-line"></div>
          <i class="ti ti-arrow-right"></i>
          <div class="divider-line"></div>
        </div>
        <div class="trade-side">
          <div class="side-label">
            <i class="ti ti-lock" aria-hidden="true"></i>
            ${p.isClosed ? 'Closed ' + fmtDate(p.closeDate) : 'Not yet closed'}
          </div>
          ${p.isClosed
            ? `<div class="legs">${legsHtml([...p.closeLegs, ...p.expiryRows], 'close')}</div>
               <div class="side-total">Total <span class="${p.closeTotal >= 0 ? 'pos' : 'neg'}">${fmt(p.closeTotal)}</span></div>`
            : `<div class="legs open-placeholder"><span class="placeholder-text">Position still open</span></div>`
          }
        </div>
      </div>
    </div>`;
  }).join('');

  const pg = `<div class="pg">
    <span>${total} position${total !== 1 ? 's' : ''}</span>
    ${pages['trades'] > 1 ? `<button onclick="changePage('trades',-1)">← Prev</button>` : ''}
    <span>Page ${pages['trades']} / ${totalPages}</span>
    ${pages['trades'] < totalPages ? `<button onclick="changePage('trades',1)">Next →</button>` : ''}
  </div>`;

  return `<div class="trades-list">${rowsHtml}</div>${pg}`;
}

// ── All ledger tab ─────────────────────────────────────────────────────────
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
    const total     = parseVal(r['Total']);
    const typeBadge = r['Type'] === 'Trade' ? 'trade' : r['Type'] === 'Money Movement' ? 'money' : 'deliver';
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
  ]);
}

// ── Load data ──────────────────────────────────────────────────────────────
function loadCSV(text) {
  allData   = parseCSV(text);
  processed = processData(allData);
  pages     = {};
  el('uploadZone').hidden = true;
  el('dashboard').hidden  = false;
  renderMetrics();
  renderTabs();
  renderTabContent();
}

// ── File handlers ──────────────────────────────────────────────────────────
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

  zone.addEventListener('click',   () => fileInput.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
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
