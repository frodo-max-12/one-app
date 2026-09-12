const user = requireAuth();
if (user) {
  renderSidebar('dashboard');
  setRoleTag();
  loadDashboard();
}

// Currency symbol — set when /sales/dashboard responds. Defaults from session.
let SYM = (typeof getCompany === 'function' && getCompany() === 'COMPANYB') ? '$' : '₹';

async function loadDashboard() {
  const loading  = document.getElementById('dashboardLoading');
  const content  = document.getElementById('dashboardContent');
  const errorBox = document.getElementById('dashboardError');
  try {
    const data = await apiRequest('/sales/dashboard');
    SYM = data.symbol || (data.currency === 'USD' ? '$' : '₹');
    loading.style.display = 'none';
    content.style.display = 'block';
    renderCards(data);
    renderAging(data.outstanding || {});
    renderTopDebtors(data.topDebtors || []);
    renderBottomSection(data);
  } catch (err) {
    loading.style.display = 'none';
    errorBox.style.display = 'block';
  }
}

function renderCards(data) {
  const cards = document.getElementById('dashboardCards');
  const o = data.outstanding   || {};
  const c = data.customers     || {};
  const s = data.soStats       || {};
  const b = data.billingStats  || {};

  cards.innerHTML = `
    <div class="card" style="border-top:2px solid var(--accent);">
      <div class="card-title">Total AR</div>
      <div class="card-value" style="color:var(--accent)">${SYM} ${fmt(o.TotalOutstanding)}</div>
      <div class="card-sub">${o.TotalCustomers||0} customers</div>
    </div>
    <div class="card" style="border-top:2px solid var(--red);">
      <div class="card-title">Overdue Amount</div>
      <div class="card-value" style="color:var(--red)">${SYM} ${fmt(o.Overdue)}</div>
      <div class="card-sub">Past due date</div>
    </div>
    <div class="card" style="border-top:2px solid var(--green);">
      <div class="card-title">Current (Not Due)</div>
      <div class="card-value" style="color:var(--green)">${SYM} ${fmt(o.Current_)}</div>
      <div class="card-sub">Within terms</div>
    </div>
    <div class="card" style="border-top:2px solid var(--purple);">
      <div class="card-title">Total Customers</div>
      <div class="card-value" style="color:var(--purple)">${fmt(c.Total)}</div>
      <div class="card-sub">${c.Active||0} active</div>
    </div>
  `;

  /* Second stat row — SO + Billing */
  const statsRow = document.createElement('div');
  statsRow.className = 'grid-2';
  statsRow.style.marginBottom = '20px';
  statsRow.innerHTML = `
    <div class="card" style="border-top:2px solid var(--teal);">
      <div class="card-title">Total SO Backlog Value</div>
      <div class="card-value" style="color:var(--teal)">${SYM} ${fmt(s.TotalSOValue)}</div>
      <div class="card-sub">${fmt(s.TotalSOCount)} open orders</div>
    </div>
    <div class="card" style="border-top:2px solid var(--amber);">
      <div class="card-title">Billing (Last 30 Days)</div>
      <div class="card-value" style="color:var(--amber)">${SYM} ${fmt(b.TotalBillingValue)}</div>
      <div class="card-sub">${fmt(b.TotalInvoiceCount)} invoices</div>
    </div>
  `;
  cards.after(statsRow);
}

function renderAging(o) {
  const total = o.TotalOutstanding || 1;
  document.getElementById('agingBreakdown').innerHTML = [
    { label:'0–30 days',  value:o.Age0_30,   color:'var(--green)' },
    { label:'31–60 days', value:o.Age31_60,  color:'var(--amber)' },
    { label:'61–90 days', value:o.Age61_90,  color:'var(--amber)' },
    { label:'90+ days',   value:o.Age90Plus, color:'var(--red)'   }
  ].map(r => `
    <div class="progress-row">
      <span class="progress-label">${r.label}</span>
      <div class="progress-track">
        <div class="progress-fill" style="width:${Math.min(100,((r.value||0)/total)*100)}%;background:${r.color};"></div>
      </div>
      <span class="progress-val">${SYM} ${fmt(r.value)}</span>
    </div>
  `).join('');
}

function renderTopDebtors(items) {
  const maxVal = items[0]?.Outstanding || 1;
  const colors = ['var(--accent)','var(--purple)','var(--teal)','var(--amber)','var(--green)','var(--red)','#e879f9'];
  document.getElementById('topDebtors').innerHTML = items.map((d,i) => `
    <div class="progress-row">
      <span class="progress-label" title="${d.CustomerName||''}">${(d.CustomerName||d.CustomerNo||'').substring(0,22)}</span>
      <div class="progress-track">
        <div class="progress-fill" style="width:${((d.Outstanding||0)/maxVal)*100}%;background:${colors[i%colors.length]};"></div>
      </div>
      <span class="progress-val">${SYM} ${fmt(d.Outstanding)}</span>
    </div>
  `).join('');
}

function renderBottomSection(data) {
  const card = document.getElementById('salespersonCard');
  const grid = document.getElementById('salespersonGrid');
  const h2   = card.querySelector('.section-head h2');

  const colors = ['var(--accent)','var(--purple)','var(--teal)','var(--amber)','var(--green)','var(--red)','#e879f9','var(--accent2)'];

  if (data.isAdmin && data.bySalesperson?.length) {
    h2.textContent = 'Outstanding by Salesperson';
    const maxVal = data.bySalesperson[0].Outstanding || 1;
    grid.innerHTML = data.bySalesperson.map((s,i) => `
      <div style="background:var(--bg3);border-radius:10px;padding:14px;border:1px solid var(--border);">
        <div style="font-size:13px;font-weight:500;margin-bottom:4px;">${s.Salesperson}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px;font-family:var(--mono);">${s.Customers} customer${s.Customers!==1?'s':''}</div>
        <div style="height:4px;background:var(--bg4);border-radius:2px;margin-bottom:6px;overflow:hidden;">
          <div style="height:100%;width:${((s.Outstanding||0)/maxVal)*100}%;background:${colors[i%colors.length]};"></div>
        </div>
        <div style="font-size:13px;font-family:var(--mono);color:${colors[i%colors.length]};font-weight:500;">${SYM} ${fmt(s.Outstanding)}</div>
      </div>
    `).join('');
    card.style.display = '';
  } else if (!data.isAdmin && data.byCustomer?.length) {
    h2.textContent = 'Outstanding by Customer';
    const maxVal = data.byCustomer[0].Outstanding || 1;
    grid.innerHTML = data.byCustomer.map((c,i) => `
      <div style="background:var(--bg3);border-radius:10px;padding:14px;border:1px solid var(--border);">
        <div style="font-size:13px;font-weight:500;margin-bottom:4px;">${c.CustomerName||c.CustomerNo}</div>
        <div style="height:4px;background:var(--bg4);border-radius:2px;margin-bottom:6px;overflow:hidden;margin-top:10px;">
          <div style="height:100%;width:${((c.Outstanding||0)/maxVal)*100}%;background:${colors[i%colors.length]};"></div>
        </div>
        <div style="font-size:13px;font-family:var(--mono);color:${colors[i%colors.length]};font-weight:500;">${SYM} ${fmt(c.Outstanding)}</div>
      </div>
    `).join('');
    card.style.display = '';
  } else {
    card.style.display = 'none';
  }
}