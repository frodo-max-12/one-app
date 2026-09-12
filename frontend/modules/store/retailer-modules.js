/* ============================================================================
   retailer-modules.js  — Retailer Auditing expansion (Option C)
   Loaded AFTER app.js, so it reuses app.js's proven engine:
     $, storeApiFetch, toast, setStatus, startCamera, grabFrame, codeOf,
     esc, fmtDateTime, fmtTime, switchView, computeRole/ROLE, userDisplayName.

   Adds the new modules: Pickout, Store Audit, Shipment, Item Audit, and the
   role-based tab visibility. The existing Inward/Outward/Total Audit code in
   app.js is untouched.
   ============================================================================ */
(function(){
  'use strict';

  /* tiny helpers (fall back if app.js didn't define one) */
  const $ = (window.$ || (id=>document.getElementById(id)));
  /* safe DOM helpers — never throw if an element is missing */
  function setHTML(id, html){ const el=$(id); if(el) el.innerHTML = html; }
  function setText(id, txt){ const el=$(id); if(el) el.textContent = txt; }
  function setShow(id, show){ const el=$(id); if(el) el.classList.toggle('hidden', !show); }
  const esc = window.esc || (s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])));
  const fmtDateTime = window.fmtDateTime || (d=>{const x=new Date(d);return x.toLocaleString();});
  function toast(m){ if(window.toast) return window.toast(m); }
  async function api(path, opts){
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    if(method !== 'GET' && typeof bjReadOnly === 'function' && bjReadOnly()){
      try{ toast('👁 Read-only login — you can view but not edit'); }catch(e){}
      /* mimic a blocked response so callers that check resp.ok handle it gracefully */
      return { ok:false, status:403, json: async()=>({ error:'read-only' }), text: async()=>'read-only' };
    }
    return window.storeApiFetch(path, opts);
  }

  /* ── SELF-CONTAINED role detection (does NOT depend on app.js) ──────────────
     Decode the JWT 'nav_token' ourselves so tab gating works even if app.js is an
     older build without computeRole/ROLE. */
  function bjToken(){ return localStorage.getItem('nav_token') || sessionStorage.getItem('nav_token'); }
  function bjDecode(){
    try{
      const t = bjToken(); if(!t) return {};
      const p = t.split('.')[1];
      const json = decodeURIComponent(atob(p.replace(/-/g,'+').replace(/_/g,'/'))
        .split('').map(c=>'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json) || {};
    }catch(e){ return {}; }
  }
  function bjRole(){
    /* try the cached user object first (most reliable), then the token */
    try{
      const raw = localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user');
      if(raw){ const u = JSON.parse(raw); if(u && u.role) return String(u.role).toLowerCase().trim(); }
    }catch(e){}
    return String(bjDecode().role || '').toLowerCase().trim();
  }
  const ROLE = {};
  function bjComputeRole(){
    const r = bjRole();
    ROLE.role       = r;
    ROLE.isAuditor  = (r === 'retailer auditor');
    ROLE.isDelivery = (r === 'retailer delivery');
    ROLE.isStore    = (r === 'store electrical' || r === 'mis store');
    ROLE.isAdmin    = (r === 'admin' || r === 'operation head' || r === 'director' || /\bhead\b/.test(r));
    window.ROLE = ROLE;          // share for any other code
    return ROLE;
  }
  /* logged-in user's email (for per-person access like Ritesh + Shipment) */
  function bjEmail(){
    try{ const raw = localStorage.getItem('nav_user') || sessionStorage.getItem('nav_user');
      if(raw){ const u = JSON.parse(raw); return String((u && (u.email||u.username))||'').toLowerCase().trim(); } }catch(e){}
    return '';
  }
  const SHIP_AUDITOR_EMAILS = ['auditor1@company-a.example', 'auditor2@company-a.example'];
  function bjIsShipAuditor(){ return bjComputeRole().isAuditor && SHIP_AUDITOR_EMAILS.includes(bjEmail()); }
  /* Read-only viewers — see all 4 Store Auditing tabs but can only VIEW. Every
     write is blocked here (and on the server) and the capture camera won't open. */
  const RETAILER_READONLY_EMAILS = ['store@company-a.example', 'store2@company-a.example'];
  function bjReadOnly(){ return RETAILER_READONLY_EMAILS.includes(bjEmail()); }
  /* a line is "name-only" (free capture, no code match) when it has no item code
     OR its name contains "pipe" (unscannable items). */
  function bjIsNameOnly(row){
    const code = ((row && row.ItemCode) || '').toString().trim();
    const name = ((row && row.ItemName) || '').toString().toLowerCase();
    return !code || /pipe/.test(name);
  }

  /* qty colour class (physical vs system) — same logic as Total Audit */
  function qtyClass(physical, system){
    if(system==null) return 'num';
    if(physical===system) return 'num qtymatch';
    if(physical < system) return 'num qtyunder';
    return 'num qtyover';
  }
  function photoCell(path){
    if(!path) return '—';
    const url = path.startsWith('http') ? path : ('/'+path.replace(/^\/+/,''));
    return '<img class="thumb" src="'+esc(url)+'" onclick="retailerLightbox(\''+esc(url)+'\')">';
  }

  /* photo viewer — responsive on BOTH desktop and mobile:
       • desktop: mouse-wheel zoom, +/- buttons, click-drag to pan, Esc/X to close
       • mobile:  pinch to zoom, one-finger drag to pan, +/- buttons, X to close
     Uses Pointer Events so one code path covers mouse + touch. Fully self-styled
     (inline) so it works in every login and every photo column. */
  window.retailerLightbox = function(url){
    let scale = 1, panX = 0, panY = 0;
    const clamp = s => Math.max(0.5, Math.min(s, 6));

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.88);'
      + 'display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;';

    const img = document.createElement('img');
    img.src = url;            // DOM property → safe, no escaping needed
    img.draggable = false;
    img.style.cssText = 'max-width:92vw;max-height:92vh;transform-origin:center center;'
      + 'border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,0.6);'
      + 'cursor:grab;user-select:none;-webkit-user-drag:none;touch-action:none;';
    function apply(){ img.style.transform = 'translate('+panX+'px,'+panY+'px) scale('+scale+')'; }
    function clearPanIfUnzoomed(){ if(scale<=1){ panX=0; panY=0; } }

    function makeBtn(label, title){
      const b = document.createElement('button');
      b.textContent = label; b.title = title;
      b.style.cssText = 'width:44px;height:44px;border:none;border-radius:8px;'
        + 'background:rgba(255,255,255,0.92);color:#111;font-size:22px;font-weight:700;'
        + 'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);line-height:1;touch-action:manipulation;';
      return b;
    }
    // Controls top-LEFT: X, zoom out, zoom in
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:16px;left:16px;display:flex;gap:10px;z-index:100000;';
    const closeBtn = makeBtn('✕', 'Close');
    const outBtn   = makeBtn('−', 'Zoom out');
    const inBtn    = makeBtn('+', 'Zoom in');

    function close(){ document.removeEventListener('keydown', onKey); overlay.remove(); }
    closeBtn.onclick = (e)=>{ e.stopPropagation(); close(); };
    inBtn.onclick    = (e)=>{ e.stopPropagation(); scale = clamp(scale + 0.25); apply(); };
    outBtn.onclick   = (e)=>{ e.stopPropagation(); scale = clamp(scale - 0.25); clearPanIfUnzoomed(); apply(); };

    /* desktop wheel zoom */
    overlay.addEventListener('wheel', (e)=>{ e.preventDefault();
      scale = clamp(scale + (e.deltaY < 0 ? 0.2 : -0.2)); clearPanIfUnzoomed(); apply();
    }, { passive:false });

    /* pinch (2 pointers) + drag-pan (1 pointer) — works for touch AND mouse */
    const pts = new Map();
    let startDist = 0, startScale = 1, lastX = 0, lastY = 0, dragging = false, moved = false;
    const dist = (a,b)=> Math.hypot(a.x-b.x, a.y-b.y);

    img.addEventListener('pointerdown', (e)=>{
      try{ img.setPointerCapture(e.pointerId); }catch(_){}
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY }); moved=false;
      if(pts.size===1){ dragging=true; lastX=e.clientX; lastY=e.clientY; }
      else if(pts.size===2){ const a=[...pts.values()]; startDist=dist(a[0],a[1]); startScale=scale; dragging=false; }
    });
    img.addEventListener('pointermove', (e)=>{
      if(!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if(pts.size===2){
        const a=[...pts.values()]; const d=dist(a[0],a[1]);
        if(startDist>0){ scale = clamp(startScale * (d/startDist)); moved=true; apply(); }
      } else if(pts.size===1 && dragging && scale>1){
        panX += e.clientX-lastX; panY += e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; moved=true; apply();
      }
    });
    function endPointer(e){
      if(pts.has(e.pointerId)) pts.delete(e.pointerId);
      if(pts.size<2) startDist=0;
      if(pts.size===0) dragging=false;
      clearPanIfUnzoomed(); apply();
    }
    img.addEventListener('pointerup', endPointer);
    img.addEventListener('pointercancel', endPointer);

    /* tap/click the dark area closes; tapping the image does not (and a drag won't) */
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    img.addEventListener('click', (e)=> e.stopPropagation());

    function onKey(e){ if(e.key === 'Escape') close();
      else if(e.key === '+' || e.key === '=') { scale = clamp(scale+0.25); apply(); }
      else if(e.key === '-') { scale = clamp(scale-0.25); clearPanIfUnzoomed(); apply(); } }
    document.addEventListener('keydown', onKey);

    bar.appendChild(closeBtn); bar.appendChild(outBtn); bar.appendChild(inBtn);
    overlay.appendChild(img); overlay.appendChild(bar);
    document.body.appendChild(overlay);
  };

  /* Ensure the verified/rejected row colours exist even if the store stylesheet
     doesn't define them — this is why Raj's row never turned green after the
     store verified it (the class was applied, but nothing painted it). */
  (function injectRetailerRowStyles(){
    if(document.getElementById('retailerInlineStyles')) return;
    const s = document.createElement('style'); s.id = 'retailerInlineStyles';
    s.textContent =
      '.row-verified td{background:#d8f5d8 !important;}' +
      '.row-rejected td{background:#fde2e2 !important;}' +
      /* Store Audit counts — own line, flush-left, responsive, attractive pills */
      '#storeAuditCount.sa-counts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;text-align:left;}' +
      '@media(max-width:700px){#storeAuditCount.sa-counts{width:100%;margin-left:0;margin-top:6px;}}' +
      '.sa-count-pill{display:inline-flex;align-items:baseline;gap:6px;padding:5px 14px;border-radius:10px;' +
        'font-size:13px;font-weight:600;line-height:1.3;white-space:nowrap;border:1px solid transparent;letter-spacing:.1px;}' +
      '.sa-count-pill b{font-size:15px;font-weight:800;}' +
      '.sa-count-phys{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;}' +
      '.sa-count-sys{background:#f5f3ff;color:#6d28d9;border-color:#ddd6fe;}';
    (document.head || document.documentElement).appendChild(s);
  })();

  /* ───────────────────────── ROLE-BASED TABS ───────────────────────── */
  function applyRoleTabs(){
    const R = bjComputeRole();
    const show = (id, on)=>{ const el=$(id); if(el){ el.classList.toggle('hidden', !on); } };

    /* Auditors: Inward, Pickout, Store Audit */
    /* Store/Admin: Store Audit, Pickout(review), Shipment, Item Audit (NO inward/outward) */
    /* Delivery: Shipment only */
    const isAud = R.isAuditor, isStore = R.isStore || R.isAdmin, isDel = R.isDelivery, ro = bjReadOnly();

    show('tabIn',         isAud);                 // read-only viewers do NOT scan inward
    show('tabOut',        false);                 // outward not used in the new flow
    show('tabTotal',      false);                 // replaced by Store Audit
    show('tabPickout',    isAud || isStore || ro);
    show('tabStoreAudit', isAud || isStore || ro);
    show('tabShipment',   isStore || isDel || bjIsShipAuditor() || ro);
    show('tabItemAudit',  isStore || ro);

    /* TAB ORDER for store/admin: Store Audit → Pickout → Shipment → Total Audit.
       Auditors keep their home.html order untouched. Re-append the four into the
       desired sequence (appendChild moves them to the end in order; hidden tabs
       stay before them and don't show). Guarded so the tab watchdog, which re-runs
       this every ~400ms, doesn't churn the DOM after the first pass. */
    if((isStore || ro) && !isAud){
      const seq = ['tabStoreAudit','tabPickout','tabShipment','tabItemAudit'];
      const first = $(seq[0]);
      const parent = first && first.parentNode;
      if(parent && parent.dataset.bjOrder !== 'store'){
        seq.forEach(id => { const el = $(id); if(el) parent.appendChild(el); });
        parent.dataset.bjOrder = 'store';
      }
    }

    console.log('[retailer] applyRoleTabs ran. role=', bjRole(),
      'isAud=', isAud, 'isStore=', isStore, 'isDel=', isDel,
      '| tabOut hidden?', $('tabOut') && $('tabOut').classList.contains('hidden'),
      '| tabPickout exists?', !!$('tabPickout'));

    /* pick a sensible default tab for each role */
    let def = 'inward';
    if(isDel) def = 'shipment';
    else if((isStore || ro) && !isAud) def = 'storeaudit';
    else if(isAud) def = 'inward';
    window._retailerDefaultView = def;
  }
  window.applyRoleTabs = applyRoleTabs;   // expose for debugging + re-runs

  /* ───────────────────────── VIEW SWITCHING ───────────────────────── */
  /* We wrap app.js switchView so the new views show/hide too. */
  const _origSwitch = window.switchView;
  window.switchView = function(v){
    /* hide all retailer views first */
    ['pickout','storeaudit','shipment','itemaudit'].forEach(name=>{
      const el=$('view-'+name); if(el) el.classList.add('hidden');
    });
    /* clear active state on all tabs */
    document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active'));

    if(v==='pickout' || v==='storeaudit' || v==='shipment' || v==='itemaudit'){
      window.view = v;
      /* hide the original inward/outward/total cards */
      ['scanCard','listCard','totalCard'].forEach(id=>{ const el=$(id); if(el) el.classList.add('hidden'); });
      if(window.stopScan) window.stopScan();
      /* free app.js's Inward camera so it doesn't fight the retailer camera for the
         back lens (two live streams starve each other → "could not read"), and
         drop any leftover "Type code" button it left on a .camera-wrap. */
      try{ const iv=$('video'); if(iv && iv.srcObject){ iv.srcObject.getTracks().forEach(t=>t.stop()); iv.srcObject=null; } }catch(e){}
      try{ const tb=document.getElementById('typeCodeBtn'); if(tb) tb.remove(); }catch(e){}
      const el=$('view-'+v); if(el) el.classList.remove('hidden');
      const tabId = 'tab'+v.charAt(0).toUpperCase()+v.slice(1).replace('audit','Audit').replace('out','out');
      /* map view→tab id */
      const map={ pickout:'tabPickout', storeaudit:'tabStoreAudit', shipment:'tabShipment', itemaudit:'tabItemAudit' };
      const tb=$(map[v]); if(tb) tb.classList.add('active');
      if(v==='pickout')    loadPickout();
      if(v==='storeaudit') loadStoreAudit();
      if(v==='shipment')   loadShipment();
      if(v==='itemaudit')  loadItemAudit();
      return;
    }
    /* otherwise defer to the original (inward/outward/total).
       IMPORTANT: app.js's switchView REWRITES tabOut/tabTotal classNames, which
       wipes the 'hidden' class applyRoleTabs added. So we re-apply role tabs right
       after, to keep the correct tabs hidden for this role. */
    if(_origSwitch){ const r = _origSwitch(v); applyRoleTabs();
      /* Inward-only bars (Capture-to toggle, date filter, needs-edit) must NOT leak
         into Store Audit or other tabs — show them only on Inward. */
      { const onInward=(v==='inward');
        ['inwardModeBar','inDateBar','bjNeedsEdit','bjNeedsEditPanel'].forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display = onInward ? '' : 'none'; }); }
      /* if we freed the Inward camera for a retailer capture earlier, re-acquire it
         (startScan alone doesn't restart the stream — only boot/watchdog do). */
      if(v==='inward' || v==='outward'){
        const iv=$('video');
        if(iv && (!iv.srcObject || !iv.srcObject.active) && typeof window.startCamera==='function'){
          window.startCamera().then(ok=>{ if(ok && typeof window.startScan==='function') window.startScan(); });
        }
        if(v==='inward') try{ bjEnsureInwardModeBar(); bjEnsureNeedsEditPanel(true); }catch(e){}
      }
      return r;
    }
  };


  /* ════════════════════════ PICKOUT MODULE ════════════════════════ */
  /* Auditor mode: fetch invoice lines, each row has Ready-to-capture.
     Store mode: list all pickouts with Yes/No verify + Reset. */
  let pkInvoiceRows = [];     // invoice lines from NAV (auditor)
  let pkRenderedRows = [];    // the filtered+sorted rows actually shown (index source for capture)
  let pkDoneByCode = {};      // itemCode -> pickout row already captured this session
  let pkActiveRow = null;     // the invoice row currently capturing

  function isStoreSide(){ const R=bjComputeRole(); return R.isStore || R.isAdmin; }

  /* Compact, stylish filter bars (Pickout / Store Audit / Total Audit). The base
     CSS makes .filterbar a full-width column with tall 15px buttons — too big,
     especially on desktop. This lays controls out inline + wrapping, with small
     auto-width buttons, and shrinks them further on wide screens. Injected once. */
  function bjInjectModuleStyles(){
    if(document.getElementById('bjModuleStyles')) return;
    const css = [
      /* ═══ built on ONE App's own tokens (--brand, --line, --green …) so the
             module looks native rather than bolted on ═══ */

      /* ---------- BUTTONS ---------- */
      '.btn{border:none;border-radius:10px;padding:9px 15px;font-weight:700;font-size:13.5px;',
        'cursor:pointer;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;',
        'gap:6px;min-height:38px;white-space:nowrap;',
        'transition:transform .06s ease, box-shadow .16s ease, filter .16s ease;',
        'box-shadow:0 1px 2px rgba(15,23,42,.06);}',
      '.btn:hover{filter:brightness(.95);box-shadow:0 3px 10px rgba(15,23,42,.12);}',
      '.btn:active{transform:translateY(1px);box-shadow:0 1px 2px rgba(15,23,42,.06);}',
      '.btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}',
      '.btn.sm{padding:6px 11px;font-size:12.5px;min-height:32px;border-radius:8px;}',
      '.btn[disabled]{opacity:.5;cursor:not-allowed;filter:none;}',

      /* ---------- CARDS ---------- */
      '.card{border-radius:16px;background:var(--card);border:1px solid var(--line);',
        'box-shadow:var(--shadow);padding:18px;margin-bottom:16px;}',

      /* ---------- TABLES ----------
         DELIBERATELY MINIMAL. ONE App already styles its tables correctly, and
         overriding the layout is what made the columns collide. We only stop
         buttons/badges from breaking apart inside a cell. Nothing else. */
      '[id^="view-"] tbody td .btn{white-space:nowrap;}',
      '[id^="view-"] tbody td .badge{white-space:nowrap;}',

      /* ---------- FORM CONTROLS ---------- */
      '[id^="view-"] input[type=number],[id^="view-"] input[type=text],[id^="view-"] input[type=date],',
        '[id^="view-"] input[type=search],[id^="view-"] select{',
        'padding:9px 11px;border:1px solid var(--line);border-radius:10px;font-size:14px;',
        'background:var(--card);color:var(--ink);font-weight:600;',
        'transition:border-color .14s ease, box-shadow .14s ease;}',
      '[id^="view-"] input:focus,[id^="view-"] select:focus{outline:none;border-color:var(--brand);',
        'box-shadow:0 0 0 3px rgba(14,165,233,.14);}',

      /* ---------- BADGES ---------- */
      '.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;',
        'font-size:11.5px;font-weight:800;line-height:1.6;white-space:nowrap;}',
      '.badge.ok{background:var(--green-l);color:#15803d;}',
      '.badge.bad{background:var(--red-l);color:#b91c1c;}',
      '.badge.muted{background:#f1f5f9;color:var(--muted);}',

      /* ---------- TOOLBARS / DASHBOARDS ---------- */
      '#saModeBar,#inwardModeBar,#inDateBar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '#saDashboard,#saProgress{border:1px solid var(--line);border-radius:14px;padding:12px;',
        'background:var(--card);box-shadow:0 1px 2px rgba(15,23,42,.04);}',
      '#saDashboard table,#saProgress table{min-width:max-content;font-size:13px;}',
      '#saQtyPanel{z-index:9999;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);}',

      /* top slider that mirrors the table scroll */
      '.bj-topscroll::-webkit-scrollbar{height:10px;}',
      '.bj-topscroll::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:999px;}',
      '.bj-topscroll::-webkit-scrollbar-thumb:hover{background:#94a3b8;}',
      '.bj-topscroll::-webkit-scrollbar-track{background:#f1f5f9;border-radius:999px;}',

      /* photo thumbnails */
      '[id^="view-"] img{border-radius:8px;transition:transform .16s ease;}',
      '[id^="view-"] img:hover{transform:scale(1.06);}',

      /* tabs */
      '.tab{border-radius:12px 12px 0 0;transition:background .14s ease,color .14s ease;}',

      /* ═══ DESKTOP ═══ */
      '@media(min-width:900px){',
        '.card{padding:22px;max-width:1600px;margin-left:auto;margin-right:auto;}',
      '}',
      '@media(min-width:1500px){ .card{max-width:1800px;} }',

      /* ═══ MOBILE — still a TABLE, just sized to fit ═══ */
      '@media(max-width:640px){',
        /* Give each table room so columns stay READABLE — item name 2-3 lines, codes
           and numbers on one line. Anything past the screen is reached via the slider. */
        '#view-storeaudit table{min-width:940px;}',
        '#view-pickout table,#view-shipment table{min-width:820px;}',
        '#view-itemaudit table,#view-total table{min-width:720px;}',
        '[id^="view-"] tbody td.num,[id^="view-"] tbody .big{white-space:nowrap;}',
        '#view-storeaudit tbody td:nth-child(2){white-space:nowrap;}',   /* item code: one line */
        '#view-storeaudit tbody td:nth-child(3){min-width:150px;}',      /* item name: 2-3 lines */
        /* my own dashboards must NOT get that min-width — they already fit */
        '#saDashboard table,#saProgress table{min-width:0;}',

        '.card{padding:12px;border-radius:14px;margin-bottom:12px;}',
        '.btn{min-height:40px;font-size:13.5px;padding:9px 13px;}',
        '.btn.sm{min-height:32px;padding:6px 10px;font-size:12px;border-radius:8px;}',
        '#saModeBar button[data-mode],#inwardModeBar button[data-imode]{flex:1 1 40%;min-width:0;}',
        '#saDashboard,#saProgress{padding:9px;border-radius:12px;}',
        '#saDashboard table,#saProgress table{font-size:11.5px;}',
        '#saDashboard th,#saDashboard td,#saProgress th,#saProgress td{padding:5px 7px !important;}',
        '[id^="view-"] input,[id^="view-"] select{font-size:16px;padding:8px 10px;}',  /* 16px stops iOS zoom */
        '.badge{font-size:10.5px;padding:2px 7px;}',
        '.tab{font-size:13px;padding:9px 8px;border-radius:10px 10px 0 0;}',
      '}',

      /* respect reduced-motion */
      '@media(prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important;}}'
    ].join('');
    const st=document.createElement('style'); st.id='bjModuleStyles'; st.textContent=css;
    document.head.appendChild(st);
  }
  function bjInjectFilterStyles(){
    if(document.getElementById('bjFilterStyles')) return;
    bjInjectModuleStyles();
    const css = ''
      + '.filterbar{flex-direction:row !important;flex-wrap:wrap !important;align-items:center !important;gap:8px !important;}'
      + '.filterbar input[type=text]{width:auto !important;flex:1 1 240px;min-width:180px;padding:10px 13px !important;font-size:14.5px !important;border-width:1px !important;}'
      + '.filterbar input[type=date],.filterbar select{width:auto !important;flex:0 0 auto;padding:7px 10px !important;font-size:13px !important;border:1px solid var(--line) !important;border-radius:9px !important;background:#fff;color:#0f172a;}'
      + '.filterbar .btn,.filterbar .btn.sm{flex:0 0 auto !important;padding:8px 14px !important;font-size:13px !important;font-weight:700 !important;border-radius:9px !important;line-height:1.1 !important;}'
      + '.filterbar .btn.ghost{background:#eef2f7 !important;color:#334155 !important;}'
      + '@media(min-width:900px){'
      +   '.filterbar{gap:10px !important;justify-content:flex-start;}'
      +   '.filterbar input[type=text]{flex:0 1 340px;}'
      +   '.filterbar input[type=date],.filterbar select{font-size:12.5px !important;padding:6px 9px !important;}'
      +   '.filterbar .btn,.filterbar .btn.sm{padding:7px 13px !important;font-size:12.5px !important;}'
      + '}';
    const st=document.createElement('style'); st.id='bjFilterStyles'; st.textContent=css;
    document.head.appendChild(st);
  }

  /* ── Store Audit / Total Audit: date filter (specific day OR range) for everyone
     who sees the tab; Excel download for store + admin only. ──────────────────── */
  const bjAuditFilter = { sa:{date:'',from:'',to:''}, ia:{date:'',from:'',to:''} };
  function bjFilterQS(prefix){
    const f = bjAuditFilter[prefix]; const p = new URLSearchParams();
    if(f.date) p.set('date', f.date);
    else if(f.from && f.to){ p.set('from', f.from); p.set('to', f.to); }
    const s = p.toString(); return s ? ('?'+s) : '';
  }
  /* cache-bust so a stale service-worker cache can't show old audit data after a
     clear/delete — appends a timestamp to the URL. */
  function bjBust(url){ return url + (url.indexOf('?')>=0 ? '&' : '?') + '_ts=' + Date.now(); }
  function bjInjectAuditFilter(prefix, onApply, excelPath, excelTitle){
    const search = $(prefix+'Search'); if(!search) return;
    const bar = search.parentElement; if(!bar || bar.dataset.bjDateFilter) return;
    bar.dataset.bjDateFilter='1';
    bar.style.flexWrap='wrap'; bar.style.gap='8px';
    const inStyle='padding:8px 10px;border:1px solid var(--line);border-radius:10px;font-size:13px;';
    const mode=document.createElement('select'); mode.style.cssText=inStyle;
    mode.innerHTML='<option value="">All dates</option><option value="date">Specific date</option><option value="range">Date range</option>';
    const dOne=document.createElement('input');  dOne.type='date';  dOne.style.cssText=inStyle;  dOne.classList.add('hidden');
    const dFrom=document.createElement('input'); dFrom.type='date'; dFrom.style.cssText=inStyle; dFrom.classList.add('hidden'); dFrom.title='From';
    const dTo=document.createElement('input');   dTo.type='date';   dTo.style.cssText=inStyle;   dTo.classList.add('hidden');   dTo.title='To';
    const apply=document.createElement('button'); apply.type='button'; apply.textContent='Apply'; apply.className='btn sm'; apply.style.cssText='background:var(--brand);color:#fff;'+inStyle;
    const clear=document.createElement('button'); clear.type='button'; clear.textContent='Clear'; clear.className='btn sm'; clear.style.cssText='background:#64748b;color:#fff;'+inStyle;
    mode.onchange=()=>{ const v=mode.value;
      dOne.classList.toggle('hidden', v!=='date');
      dFrom.classList.toggle('hidden', v!=='range');
      dTo.classList.toggle('hidden', v!=='range'); };
    apply.onclick=()=>{
      const f=bjAuditFilter[prefix]; f.date=''; f.from=''; f.to='';
      if(mode.value==='date'){ if(!dOne.value){ toast('Pick a date'); return; } f.date=dOne.value; }
      else if(mode.value==='range'){ if(!dFrom.value||!dTo.value){ toast('Pick both dates'); return; } f.from=dFrom.value; f.to=dTo.value; }
      onApply();
    };
    clear.onclick=()=>{ mode.value=''; dOne.value=''; dFrom.value=''; dTo.value=''; mode.onchange();
      const f=bjAuditFilter[prefix]; f.date='';f.from='';f.to=''; onApply(); };
    bar.appendChild(mode); bar.appendChild(dOne); bar.appendChild(dFrom); bar.appendChild(dTo); bar.appendChild(apply); bar.appendChild(clear);
    if(prefix==='sa'){ [mode,dOne,dFrom,dTo,apply,clear].forEach(el=>el.classList.add('sa-datefilter')); }
    if(isStoreSide()){
      const xl=document.createElement('button'); xl.type='button'; xl.textContent='⬇ Excel'; xl.className='btn sm';
      xl.style.cssText='background:#16a34a;color:#fff;font-weight:700;'+inStyle;
      xl.onclick=()=>{
        let url = excelPath; const parts=[];
        const qs = bjFilterQS(prefix); if(qs) parts.push(qs.slice(1));
        if(prefix==='sa') parts.push('mode='+saMode);
        if(parts.length) url += '?'+parts.join('&');
        bjDownloadExcel(url, excelTitle + (prefix==='sa' ? (' ('+(saMode==='final'?'Overall':'Today')+')') : ''));
      };
      bar.appendChild(xl);
      /* Store Audit only: one-click reset of ALL inward audit data (store/admin). */
      if(prefix==='sa'){
        const ca=document.createElement('button'); ca.type='button'; ca.id='saClearBtn'; ca.textContent='🗑 Clear All Inward'; ca.className='btn sm';
        ca.style.cssText='background:var(--red,#dc2626);color:#fff;font-weight:800;'+inStyle;
        ca.onclick=retailerClearAllInward;
        bar.appendChild(ca);
      }
    }
  }
  async function bjDownloadExcel(path, title){
    try{
      toast('Preparing Excel…');
      const resp = await api(path);
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      const blob = await resp.blob();
      const fname = title.replace(/\s+/g,'_')+'_'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.xlsx';
      if(typeof window.storeSaveAndShare==='function'){
        await window.storeSaveAndShare(blob, fname, { title, dialogTitle:'Share '+title+' via…' });  // APK-safe (reuses app.js)
      } else {
        const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=fname;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),5000);
      }
      toast('Excel ready');
    }catch(e){ toast('Excel failed: '+(e.message||e)); }
  }

  /* Store Audit reset: soft-delete ALL inward audit data (store/admin), regardless
     of the current date filter — one click wipes the whole inward audit. Double-
     confirmed; can't be undone in-app. */
  async function retailerClearAllInward(){
    const isFinal = (saMode==='final');
    const f = bjAuditFilter.sa || {};
    const scope = f.date ? ('for '+f.date)
                : (f.from && f.to) ? ('for '+f.from+' → '+f.to)
                : (isFinal ? '(entire Overall record)' : '(today)');
    const what = isFinal ? 'OVERALL audit data' : 'today\u2019s inward counts';
    const note = isFinal ? 'This removes items from the Overall record.'
                         : 'This removes those inward scans (physical becomes 0). Overall is not affected.';
    if(!confirm('Clear '+what+' '+scope+'?\n\n'+note+'\nThis cannot be undone from the app.')) return;
    if(!confirm('Are you sure? '+what+' '+scope+' will be cleared.')) return;
    try{
      const qs = bjFilterQS('sa');
      let url;
      if(isFinal){
        url = '/api/store/retailer/audit-final-clear' + qs;
      } else {
        url = '/api/store/retailer/store-audit-all' + (qs ? (qs+'&scope=today') : '?scope=today');
      }
      const resp = await api(url, { method:'DELETE' });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      const j = await resp.json().catch(()=>({}));
      toast('🗑 Cleared '+(j.rows!=null?j.rows+' ':'')+(isFinal?'final':'inward')+' entr'+((j.rows===1)?'y':'ies'));
      loadStoreAudit();
    }catch(e){ toast('Clear failed: '+(e.message||e)); }
  }

  /* ── client-side search + date filter for Pickout & Shipment (all roles) ─────
     Search matches Invoice No OR Item Code OR Item Name; date filter is a
     specific day OR an inclusive range, applied to each view's own date field. */
  const bjViewFilter = { pk:{search:'',mode:'',date:'',from:'',to:''}, sh:{search:'',mode:'',date:'',from:'',to:''} };
  function bjDateStr(d){ try{ const x=new Date(d); if(isNaN(x)) return ''; return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); }catch(e){ return ''; } }
  function bjFilterRows(rows, f, dateField, codeFields){
    if(!f) return rows;
    return (rows||[]).filter(r=>{
      if(f.search){ const q=f.search.toLowerCase(); if(!codeFields.some(k=>String(r[k]||'').toLowerCase().includes(q))) return false; }
      if(f.mode==='date' && f.date){ if(bjDateStr(r[dateField])!==f.date) return false; }
      else if(f.mode==='range' && f.from && f.to){ const ds=bjDateStr(r[dateField]); if(!ds || ds<f.from || ds>f.to) return false; }
      return true;
    });
  }
  function bjInjectViewFilter(prefix, barEl, placeholder, onChange, refreshFn){
    if(!barEl || barEl.dataset.bjvf) return;
    barEl.dataset.bjvf='1';
    barEl.innerHTML='';                       // rebuild this bar cleanly
    const f = bjViewFilter[prefix];
    const inStyle='padding:10px 13px;border:1px solid var(--line);border-radius:10px;font-size:14px;background:#fff;color:#0f172a;';
    const search=document.createElement('input'); search.type='text'; search.placeholder=placeholder;
    search.style.cssText='flex:1 1 240px;min-width:180px;'+inStyle;
    search.value=f.search||'';
    search.oninput=()=>{ f.search=search.value.trim(); clearTimeout(window['_bjvf_'+prefix]); window['_bjvf_'+prefix]=setTimeout(onChange,180); };
    const mode=document.createElement('select'); mode.style.cssText=inStyle;
    mode.innerHTML='<option value="">All dates</option><option value="date">Specific date</option><option value="range">Date range</option>';
    const dOne=document.createElement('input');  dOne.type='date';  dOne.style.cssText=inStyle; dOne.classList.add('hidden');
    const dFrom=document.createElement('input'); dFrom.type='date'; dFrom.style.cssText=inStyle; dFrom.classList.add('hidden'); dFrom.title='From';
    const dTo=document.createElement('input');   dTo.type='date';   dTo.style.cssText=inStyle; dTo.classList.add('hidden');   dTo.title='To';
    mode.onchange=()=>{ const v=mode.value; f.mode=v;
      dOne.classList.toggle('hidden', v!=='date'); dFrom.classList.toggle('hidden', v!=='range'); dTo.classList.toggle('hidden', v!=='range');
      if(v===''){ f.date='';f.from='';f.to=''; onChange(); } };
    dOne.onchange=()=>{ f.date=dOne.value; onChange(); };
    dFrom.onchange=()=>{ f.from=dFrom.value; if(f.to) onChange(); };
    dTo.onchange=()=>{ f.to=dTo.value; if(f.from) onChange(); };
    barEl.appendChild(search); barEl.appendChild(mode); barEl.appendChild(dOne); barEl.appendChild(dFrom); barEl.appendChild(dTo);
    if(refreshFn){
      const rb=document.createElement('button'); rb.type='button'; rb.textContent='↻ Refresh'; rb.className='btn ghost sm';
      rb.onclick=refreshFn; barEl.appendChild(rb);
    }
  }

  async function loadPickout(){
    const storeSide = isStoreSide();
    setText('pkTitle', storeSide ? 'Pickout — verify auditor captures' : 'Pickout — scan invoice items');
    /* one search+date filter bar for EVERYONE (auditor, store, admin) */
    $('pkFilters').style.display = 'flex';
    bjInjectViewFilter('pk', $('pkFilters'), '🔍 Search invoice no or item code…',
      ()=>{ if(isStoreSide()) renderPickoutReview(); else renderInvoiceLines(); },
      ()=> loadPickout());
    if(storeSide){ return loadPickoutReview(); }
    /* auditor mode: load invoice lines + my already-done pickouts */
    await loadInvoiceLines();
  }

  async function loadInvoiceLines(){
    const head = $('pkHead');
    head.innerHTML = '<th>#</th><th>Posting Date</th><th>Invoice No</th><th>Customer</th>'
      + '<th>Item Code</th><th>Item Name</th><th class="num">Qty</th><th>Action</th>'
      + '<th>Capture Date &amp; Time</th><th>Photo</th><th>Reset</th>';
    setHTML('pickoutBody', '<tr><td colspan="11" class="empty">Loading invoice lines…</td></tr>');
    try{
      const resp = await api('/api/store/retailer/invoices');
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      pkInvoiceRows = await resp.json();
      /* also load my pickouts so captured rows show their time */
      try{
        const pr = await api('/api/store/retailer/pickout-list');
        if(pr.ok){
          const mine = await pr.json();
          pkDoneByCode = {};
          mine.forEach(m=>{
            const k=(m.ItemCode||'')+'|'+(m.InvoiceNo||'');
            const cur = pkDoneByCode[k] || { CapturedQty:0, TargetQty:Number(m.TargetQty)||0, CapturedAt:m.CapturedAt, Photos:[], ImagePath:m.ImagePath, Verification:m.Verification, Id:m.Id, CapturedByName:m.CapturedByName };
            cur.CapturedQty += Math.round(Number(m.Qty)||0);
            if(m.ImagePath) cur.Photos.push(m.ImagePath);
            if(!cur.TargetQty && m.TargetQty) cur.TargetQty = Number(m.TargetQty)||0;
            pkDoneByCode[k] = cur;
          });
        }
      }catch(e){}
      renderInvoiceLines();
    }catch(e){
      setHTML('pickoutBody', '<tr><td colspan="11" class="empty">Could not load invoices: '+esc(e.message)+'</td></tr>');
    }
  }

  /* ── sortable "Capture Date & Time" columns ───────────────────────────────
     Click a capture-date header to toggle ascending/descending. State is per
     table+column. Works for both JS-built headers (pickout/shipment) and the
     static headers in home.html (store audit / total audit) by finding the
     header cell in the DOM at render time. */
  const bjSortState = {};
  function bjSortRows(rows, key, getTime){
    const dir = bjSortState[key];
    if(!dir) return rows;                 // no sort chosen → original order
    const arr = rows.slice();
    arr.sort((a,b)=>{ const av=getTime(a)||0, bv=getTime(b)||0; return dir==='asc' ? av-bv : bv-av; });
    return arr;
  }
  function bjTime(field){ return (r)=> r && r[field] ? new Date(r[field]).getTime() : 0; }
  /* ── RESPONSIVE TABLE (runs for EVERY module's table) ───────────────────────
     Adds the slider above the table and lets the columns size to the screen.
     Called from bjWireSortHeader, so Store Audit, Pickout, Shipment, Total Audit
     and the invoice lines all get it automatically. */
  function bjMakeResponsive(tbodyId){
    const tb=$(tbodyId); if(!tb) return;
    const table=tb.closest?tb.closest('table'):null; if(!table) return;
    table.classList.add('bj-rtable');
    bjEnsureTopScroller(tbodyId);   /* slider above the table, on every module */
  }
  function bjWireSortHeader(tbodyId, headerText, key, rerender){
    const tb = $(tbodyId); if(!tb) return;
    try{ bjMakeResponsive(tbodyId); }catch(e){}
    const table = tb.closest ? tb.closest('table') : null; if(!table) return;
    const ths = table.querySelectorAll('thead th');
    ths.forEach(th=>{
      const base = th.getAttribute('data-bjlabel') || th.textContent.replace(/\s*[▲▼↕]\s*$/,'');
      if(base.toLowerCase().indexOf(headerText.toLowerCase()) >= 0){
        th.setAttribute('data-bjlabel', base);
        th.style.cursor='pointer'; th.style.whiteSpace='nowrap'; th.style.userSelect='none';
        const arrow = bjSortState[key]==='asc' ? ' ▲' : bjSortState[key]==='desc' ? ' ▼' : ' ↕';
        th.textContent = base + arrow;
        th.onclick = ()=>{ bjSortState[key] = bjSortState[key]==='asc' ? 'desc' : 'asc'; rerender(); };
      }
    });
  }
  /* Total Audit has TWO capture columns; clicking one sorts by it and clears the other. */
  function bjWireItemAuditHeaders(){
    const tb=$('itemAuditBody'); if(!tb || !tb.closest) return;
    const table=tb.closest('table'); if(!table) return;
    table.querySelectorAll('thead th').forEach(th=>{
      const base = th.getAttribute('data-bjlabel') || th.textContent.replace(/\s*[▲▼↕]\s*$/,'');
      const isPhys = base.toLowerCase().indexOf('physical capture')>=0;
      const isPick = base.toLowerCase().indexOf('pickout capture')>=0;
      if(isPhys || isPick){
        th.setAttribute('data-bjlabel', base);
        th.style.cursor='pointer'; th.style.whiteSpace='nowrap'; th.style.userSelect='none';
        const k = isPhys ? 'iaPhys' : 'iaPick';
        const arrow = bjSortState[k]==='asc' ? ' ▲' : bjSortState[k]==='desc' ? ' ▼' : ' ↕';
        th.textContent = base + arrow;
        th.onclick = ()=>{
          const other = isPhys ? 'iaPick' : 'iaPhys';
          bjSortState[other] = undefined;
          bjSortState[k] = bjSortState[k]==='asc' ? 'desc' : 'asc';
          renderItemAudit();
        };
      }
    });
  }

  function renderInvoiceLines(){
    const getTime = (r)=>{ const d=pkDoneByCode[(r.ItemCode||'')+'|'+(r.InvoiceNo||'')]; return d&&d.CapturedAt?new Date(d.CapturedAt).getTime():0; };
    let rows = bjFilterRows(pkInvoiceRows || [], bjViewFilter.pk, 'PostingDate', ['InvoiceNo','ItemCode','ItemName']);
    rows = bjSortRows(rows, 'pkLines', getTime);
    pkRenderedRows = rows;   // capture handler indexes into THIS (filtered+sorted), not the raw array
    setText('pickoutCount', rows.length+' line'+(rows.length===1?'':'s'));
    $('pickoutEmpty').classList.toggle('hidden', rows.length>0);
    { const _e=$('pickoutBody'); if(_e) _e.innerHTML = rows.map((r,i)=>{
      const key=(r.ItemCode||'')+'|'+(r.InvoiceNo||'');
      const done = pkDoneByCode[key];
      const captured = done ? (done.CapturedQty||0) : 0;
      const target   = Math.round(Number(r.Qty)||0);
      const completed = (target>0 && captured>=target);
      const action = completed
        ? '<span class="badge ok">✓ Captured</span>'
        : '<button class="btn cap sm" style="background:var(--brand);color:#fff;" onclick="retailerReadyCapture('+i+')">📸 '
            + (captured>0 ? ('Capture more ('+captured+'/'+target+')') : 'Ready to capture') + '</button>';
      const resetCell = (done && !done.Verification)
        ? '<button class="btn sm" style="background:#64748b;color:#fff;" onclick="retailerAuditorReset('+done.Id+')">↺ Reset</button>'
        : '—';
      const photoCellHtml = (done && done.Photos && done.Photos.length) ? done.Photos.map(p=>photoCell(p)).join(' ') : (done ? photoCell(done.ImagePath) : '—');
      const when = done ? fmtDateTime(done.CapturedAt) : '—';
      /* per-person colour: once the STORE verifies/rejects MY pickout, colour my row.
         green = verified, red = rejected (only shows in the auditor's own view). */
      let rowClass = '';
      if(done){
        const v = (done.Verification||'').toLowerCase();
        if(v==='verified') rowClass = ' class="row-verified"';
        else if(v==='rejected') rowClass = ' class="row-rejected"';
      }
      return '<tr'+rowClass+'>'
        + '<td>'+(i+1)+'</td>'
        + '<td>'+(r.PostingDate?new Date(r.PostingDate).toLocaleDateString():'—')+'</td>'
        + '<td><b>'+esc(r.InvoiceNo||'—')+'</b></td>'
        + '<td>'+esc(r.CustomerName||'—')+'</td>'
        + '<td><b>'+esc(r.ItemCode||'—')+'</b></td>'
        + '<td>'+esc(r.ItemName||'—')+'</td>'
        + '<td class="num big">'+(Math.round(r.Qty)||0)+'</td>'
        + '<td>'+action+'</td>'
        + '<td>'+when+'</td>'
        + '<td>'+photoCellHtml+'</td>'
        + '<td>'+resetCell+'</td>'
        + '</tr>';
    }).join(''); }
    bjWireSortHeader('pickoutBody', 'capture date', 'pkLines', renderInvoiceLines);
  }

  /* auditor taps Ready-to-capture on a row → open camera, scan must match this code */
  window.retailerReadyCapture = function(idx){
    if(bjReadOnly()){ try{ toast('👁 Read-only login — you can view but not capture'); }catch(e){} return; }
    const row = (pkRenderedRows||[])[idx] || pkInvoiceRows[idx];
    if(!row) return;
    pkActiveRow = row;
    const key=(row.ItemCode||'')+'|'+(row.InvoiceNo||'');
    const done = pkDoneByCode[key];
    const captured = done ? (done.CapturedQty||0) : 0;
    const target   = Math.round(Number(row.Qty)||0);
    bjConfirmQty = Math.max(1, (target - captured) || 1);   // default box qty = remaining
    setText('pkRowLabel', (row.ItemCode||row.ItemName||'') + ' · ' + (row.ItemName||''));
    $('pkScanCard').classList.remove('hidden');
    const nameOnly = bjIsNameOnly(row);
    if(!nameOnly){
      setText('pkCamHint', 'Scan item code '+(row.ItemCode||'')+' for invoice '+row.InvoiceNo+' — remaining '+Math.max(0,target-captured)+' of '+target);
    } else {
      setText('pkCamHint', 'No code needed for "'+(row.ItemName||'item')+'" — tap 📸 Capture (remaining '+Math.max(0,target-captured)+' of '+target+')');
    }
    startRetailerCamera('pkVideo', nameOnly ? '' : row.ItemCode, async (scannedCode, photo, boxQty)=>{
      await submitPickout(row, scannedCode, photo, boxQty);
    });
    $('pkScanCard').scrollIntoView({behavior:'smooth', block:'start'});
  };

  $('pkCancel') && ($('pkCancel').onclick = ()=>{ stopRetailerCamera(); $('pkScanCard').classList.add('hidden'); pkActiveRow=null; });
  $('pkCapture') && ($('pkCapture').onclick = ()=>{ retailerManualCapture(); });
  /* pkApply/pkClear/pkRefresh removed — the Pickout filter bar (search + date) is
     now built by bjInjectViewFilter('pk', …) in loadPickout, for all roles. */

  async function submitPickout(row, scannedCode, photo, boxQty){
    try{
      const body = {
        postingDate: row.PostingDate, invoiceNo: row.InvoiceNo, customerName: row.CustomerName,
        itemCode: row.ItemCode, itemName: row.ItemName,
        qty: Math.max(1, Math.round(Number(boxQty)||1)),   // THIS box's captured qty
        invoiceQty: Math.round(Number(row.Qty)||0),        // invoice target (for partial/completed)
        nameOnly: bjIsNameOnly(row),
        scannedCode: scannedCode, imageBase64: photo
      };
      const resp = await api('/api/store/retailer/pickout', { method:'POST', body: JSON.stringify(body) });
      if(resp.status===409){
        let msg = '';
        try{ const j = await resp.json(); msg = j.error || j.message || ''; }catch(_){}
        toast('❌ Code mismatch — scan the correct item ('+row.ItemCode+')');
        stopRetailerCamera();
        $('pkScanCard').classList.add('hidden');
        pkActiveRow=null;
        loadInvoiceLines();
        return;
      }
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      /* refresh captured totals; if still short of the invoice qty, keep capturing */
      await loadInvoiceLines();
      const key=(row.ItemCode||'')+'|'+(row.InvoiceNo||'');
      const done = pkDoneByCode[key];
      const captured = done ? (done.CapturedQty||0) : 0;
      const target   = Math.round(Number(row.Qty)||0);
      if(target>0 && captured < target){
        toast('✓ Saved '+captured+'/'+target+' — capture the next box');
      } else {
        toast('✓ Completed '+captured+'/'+target);
      }
      stopRetailerCamera();
      $('pkScanCard').classList.add('hidden');
      pkActiveRow=null;
    }catch(e){ toast('Save failed: '+e.message); }
  }

  /* ── Pickout REVIEW (store) ── */
  let pkReviewRows = [];
  async function loadPickoutReview(){
    const head = $('pkHead');
    head.innerHTML = '<th>#</th><th>Posting Date</th><th>Invoice No</th><th>Customer</th>'
      + '<th>Item Code</th><th>Item Name</th><th class="num">Qty</th>'
      + '<th>Verification</th><th>Status</th><th>Capture Date &amp; Time</th>'
      + '<th>Captured By</th><th>Photo</th><th>Reset</th><th>Delete</th>';
    setHTML('pickoutBody', '<tr><td colspan="14" class="empty">Loading…</td></tr>');
    try{
      const resp = await api('/api/store/retailer/pickout-list');
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      pkReviewRows = await resp.json();
      renderPickoutReview();
    }catch(e){
      setHTML('pickoutBody', '<tr><td colspan="14" class="empty">Could not load: '+esc(e.message)+'</td></tr>');
    }
  }
  function renderPickoutReview(){
    /* aggregate raw box-captures into ONE row per invoice+item line */
    const groups = {};
    (pkReviewRows||[]).forEach(r=>{
      const k=(r.ItemCode||'')+'|'+(r.InvoiceNo||'');
      let g = groups[k];
      if(!g){ g = groups[k] = { PostingDate:r.PostingDate, InvoiceNo:r.InvoiceNo, CustomerName:r.CustomerName,
        ItemCode:r.ItemCode, ItemName:r.ItemName, Target:Math.round(Number(r.TargetQty)||0),
        Captured:0, Ids:[], Photos:[], Verifs:[], CapturedAt:r.CapturedAt, CapturedByName:r.CapturedByName, VerifiedBy:r.VerifiedBy }; }
      g.Captured += Math.round(Number(r.Qty)||0);
      if(!g.Target && r.TargetQty) g.Target = Math.round(Number(r.TargetQty)||0);
      g.Ids.push(r.Id);
      if(r.ImagePath) g.Photos.push(r.ImagePath);
      g.Verifs.push((r.Verification||'').toLowerCase());
      if(new Date(r.CapturedAt) > new Date(g.CapturedAt||0)){ g.CapturedAt=r.CapturedAt; g.CapturedByName=r.CapturedByName; if(r.VerifiedBy) g.VerifiedBy=r.VerifiedBy; }
    });
    let lines = Object.values(groups).filter(g => g.Target>0 ? (g.Captured >= g.Target) : true);  // ONLY completed → store
    lines.forEach(g=>{
      if(g.Verifs.some(v=>v==='rejected')) g.LineVerif='rejected';
      else if(g.Verifs.length && g.Verifs.every(v=>v==='verified')) g.LineVerif='verified';
      else g.LineVerif='';
    });
    let rows = bjFilterRows(lines, bjViewFilter.pk, 'PostingDate', ['InvoiceNo','ItemCode','ItemName','CapturedByName']);
    rows = bjSortRows(rows, 'pkReview', bjTime('CapturedAt'));
    const R = bjComputeRole();
    const isAdminView = R.isAdmin && !R.isStore;
    const verifierName = (r)=>{
      const vb = (r.VerifiedBy||'').toString().toLowerCase();
      if(!vb) return 'Dutta Sir';
      if(vb.indexOf('store.electrical')>=0) return 'Dutta Sir';
      return (r.VerifiedBy||'').toString().split('@')[0] || r.VerifiedBy;
    };
    setText('pickoutCount', rows.length+' pickout'+(rows.length===1?'':'s'));
    $('pickoutEmpty').classList.toggle('hidden', rows.length>0);
    { const _e=$('pickoutBody'); if(_e) _e.innerHTML = rows.map((r,i)=>{
      const v = r.LineVerif;
      const idsCsv = r.Ids.join(',');
      const verifyBtns = '<div style="display:flex;gap:5px;">'
        + '<button class="btn yes sm" style="background:var(--green);color:#fff;" onclick="retailerVerifyLine(\''+idsCsv+'\',\'verified\')">Yes</button>'
        + '<button class="btn no sm" style="background:var(--red);color:#fff;" onclick="retailerVerifyLine(\''+idsCsv+'\',\'rejected\')">No</button>'
        + '</div>';
      const adminText = v==='verified' ? '<span class="badge ok">Verified by '+esc(verifierName(r))+'</span>'
          : v==='rejected' ? '<span class="badge bad">Rejected by '+esc(verifierName(r))+'</span>'
          : '<span class="badge muted">Pending with Dutta Sir</span>';
      const verifyCell = isAdminView ? adminText : verifyBtns;
      const status = v==='verified' ? '<span class="badge ok">Verified</span>'
                   : v==='rejected' ? '<span class="badge bad">Rejected</span>'
                   : '<span class="badge muted">Pending</span>';
      const resetBtn = (v==='verified'||v==='rejected')
        ? '<button class="btn reset sm" style="background:#64748b;color:#fff;" onclick="retailerVerifyLine(\''+idsCsv+'\',\'reset\')">↺ Reset</button>' : '—';
      const photos = r.Photos.length ? r.Photos.map(p=>photoCell(p)).join(' ') : '—';
      return '<tr>'
        + '<td>'+(i+1)+'</td>'
        + '<td>'+(r.PostingDate?new Date(r.PostingDate).toLocaleDateString():'—')+'</td>'
        + '<td><b>'+esc(r.InvoiceNo||'—')+'</b></td>'
        + '<td>'+esc(r.CustomerName||'—')+'</td>'
        + '<td><b>'+esc(r.ItemCode||'—')+'</b></td>'
        + '<td>'+esc(r.ItemName||'—')+'</td>'
        + '<td class="num big">'+r.Captured+(r.Target?(' / '+r.Target):'')+'</td>'
        + '<td>'+verifyCell+'</td>'
        + '<td>'+status+'</td>'
        + '<td>'+fmtDateTime(r.CapturedAt)+'</td>'
        + '<td>'+esc(r.CapturedByName||'—')+'</td>'
        + '<td style="white-space:nowrap;">'+photos+'</td>'
        + '<td>'+resetBtn+'</td>'
        + '<td><button class="btn sm" style="background:var(--red,#dc2626);color:#fff;" onclick="retailerDeleteLine(\''+idsCsv+'\')">🗑 Delete</button></td>'
        + '</tr>';
    }).join(''); }
    bjWireSortHeader('pickoutBody', 'capture date', 'pkReview', renderPickoutReview);
  }
  /* verify/reset/delete apply to ALL box rows of the line */
  window.retailerVerifyLine = async function(idsCsv, decision){
    const ids = String(idsCsv||'').split(',').map(s=>parseInt(s,10)).filter(Boolean);
    if(!ids.length) return;
    try{
      for(const id of ids){
        const resp = await api('/api/store/retailer/verify/'+id, { method:'PUT', body: JSON.stringify({ decision }) });
        if(!resp.ok) throw new Error('HTTP '+resp.status);
      }
      toast(decision==='reset'?'↺ Reset':(decision==='verified'?'✓ Verified':'✗ Rejected'));
      loadPickoutReview();
    }catch(e){ toast('Failed: '+(e.message||e)); }
  };
  window.retailerDeleteLine = async function(idsCsv){
    if(!confirm('Delete this pickout line? All its box captures are removed from all views.')) return;
    const ids = String(idsCsv||'').split(',').map(s=>parseInt(s,10)).filter(Boolean);
    try{
      for(const id of ids){
        const resp = await api('/api/store/retailer/pickout/'+id, { method:'DELETE' });
        if(!resp.ok) throw new Error('HTTP '+resp.status);
      }
      toast('🗑 Deleted');
      loadPickoutReview();
    }catch(e){ toast('Delete failed: '+(e.message||e)); }
  };
  window.retailerDelete = async function(id){
    if(!confirm('Delete this pickout entry? It will be removed from all views (Pickout, Store Audit, Shipment).')) return;
    try{
      const resp = await api('/api/store/retailer/pickout/'+id, { method:'DELETE' });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('🗑 Deleted');
      loadPickoutReview();
    }catch(e){ toast('Delete failed: '+e.message); }
  };

  /* AUDITOR reset (Pickout) — clears their own capture and reopens the line.
     Allowed ONLY before the store verifies/rejects (enforced on the server). */
  window.retailerAuditorReset = async function(id){
    if(!confirm('Reset this capture? The photo is cleared and the line goes back to "Ready to capture". Only possible before the store verifies.')) return;
    try{
      const resp = await api('/api/store/retailer/pickout/'+id+'/reset', { method:'PUT' });
      if(resp.status===409){
        let msg=''; try{ const j=await resp.json(); msg=j.message||j.error||''; }catch(_){}
        toast('⚠ '+(msg||'Cannot reset — already verified by store'));
        loadPickout(); return;
      }
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('↺ Reset — ready to capture again');
      loadPickout();
    }catch(e){ toast('Reset failed: '+e.message); }
  };

  /* DELIVERY reset (Shipment) — clears the delivery photo and reopens for re-capture. */
  window.retailerDeliveryReset = async function(shipmentId){
    if(!shipmentId){ toast('Nothing to reset'); return; }
    if(!confirm('Reset this delivery photo and capture again?')) return;
    try{
      const resp = await api('/api/store/retailer/shipment/'+shipmentId+'/reset', { method:'PUT' });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('↺ Reset — ready to capture again');
      loadShipment();
    }catch(e){ toast('Reset failed: '+e.message); }
  };

  window.retailerVerify = async function(id, decision){
    try{
      const resp = await api('/api/store/retailer/verify/'+id, { method:'PUT', body: JSON.stringify({ decision }) });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast(decision==='reset'?'↺ Reset done':(decision==='verified'?'✓ Verified':'✗ Rejected'));
      loadPickoutReview();
    }catch(e){ toast('Failed: '+e.message); }
  };


  /* ════════════════════════ STORE AUDIT MODULE ════════════════════════ */
  let saRows = [];
  let saMode = 'today';   // 'today' (fresh daily) | 'final' (official cumulative)

  /* mode toggle + Transfer-All bar, injected once above the Store Audit filter */
  function bjEnsureAuditModeBar(){
    const search=$('saSearch'); if(!search) return;
    const filterbar=search.parentElement; if(!filterbar || document.getElementById('saModeBar')) return;
    const bar=document.createElement('div'); bar.id='saModeBar';
    bar.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 8px;';
    const mkTab=(label,mode)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=label; b.dataset.mode=mode;
      b.onclick=()=>{ saMode=mode; bjPaintModeTabs(); loadStoreAudit(); }; return b; };
    const today=mkTab('📅 Today\u2019s Auditing','today');
    const final=mkTab('🔒 Overall Auditing','final');
    const xfer=document.createElement('button'); xfer.type='button'; xfer.id='saXferAll'; xfer.textContent='⬆ Transfer All Today → Overall';
    xfer.style.cssText='background:#7c3aed;color:#fff;font-weight:800;padding:8px 14px;border:none;border-radius:9px;cursor:pointer;';
    xfer.onclick=()=>retailerTransferToday('');
    bar.appendChild(today); bar.appendChild(final); bar.appendChild(xfer);
    filterbar.parentElement.insertBefore(bar, filterbar);
    /* make sure the card gives its content breathing room from the outline (both
       desktop and mobile) — only tops up padding, never removes existing spacing. */
    const card = filterbar.parentElement;
    if(card && !card.dataset.bjPadded){
      card.dataset.bjPadded = '1';
      try{
        const cs = getComputedStyle(card);
        const thin = (v)=> (parseInt(v)||0) < 14;
        if(thin(cs.paddingLeft))   card.style.paddingLeft   = '14px';
        if(thin(cs.paddingRight))  card.style.paddingRight  = '14px';
        if(thin(cs.paddingBottom)) card.style.paddingBottom = '14px';
      }catch(e){}
    }
    const dash=document.createElement('div'); dash.id='saDashboard';
    dash.style.cssText='margin:0 0 10px;overflow-x:auto;';
    filterbar.parentElement.insertBefore(dash, filterbar);
    const prog=document.createElement('div'); prog.id='saProgress';
    prog.style.cssText='margin:0 0 10px;overflow-x:auto;';
    filterbar.parentElement.insertBefore(prog, filterbar);
    bjPaintModeTabs();
  }
  function bjPaintModeTabs(){
    const bar=document.getElementById('saModeBar'); if(!bar) return;
    bar.querySelectorAll('button[data-mode]').forEach(b=>{
      const on=b.dataset.mode===saMode;
      b.style.cssText='padding:8px 14px;border-radius:9px;font-weight:700;cursor:pointer;border:1px solid var(--line);'
        +(on?'background:var(--brand);color:#fff;':'background:#fff;color:#334155;');
    });
    /* Transfer-All: auditor + store (not admin), and only on the Today view */
    const xfer=document.getElementById('saXferAll');
    if(xfer){ const R=bjComputeRole(); xfer.style.display = ((R.isAuditor || R.isStore) && saMode==='today') ? '' : 'none'; }
    /* Clear button label follows the mode (store/admin only button) */
    const clr=document.getElementById('saClearBtn');
    if(clr) clr.textContent = (saMode==='final') ? '🗑 Clear Overall' : '🗑 Clear Today\u2019s Inward';
  }

  /* ── INWARD tab: Today/Final destination toggle (auditors only) ───────────────
     Today = normal daily scan. Final = the scanned item is auto-added to Overall
     straight away (no Transfer step). Store/admin never see this. */
  let inwardMode = 'today';
  /* "Needs edit" panel: items the store marked NO in Stock Audit. Shows each item's
     total with an editable qty box; saving corrects the physical qty. Auto-refreshes. */
  let _neLast = 0;
  async function bjEnsureNeedsEditPanel(force){
    if(isStoreSide()) return;                        // auditors only
    const anchor=$('scanCard'); if(!anchor || !anchor.parentElement) return;
    let panel=document.getElementById('inwardNeedsEdit');
    if(!panel){ panel=document.createElement('div'); panel.id='inwardNeedsEdit'; panel.style.cssText='margin:10px 0;';
      anchor.parentElement.insertBefore(panel, anchor.nextSibling); }
    const now=Date.now(); if(!force && (now-_neLast)<6000) return; _neLast=now;   // throttle
    try{
      const resp=await api(bjBust('/api/store/retailer/audit-today'));
      if(!resp.ok){ panel.innerHTML=''; return; }
      const rows=(await resp.json()||[]).filter(r=>(r.Decision||'').toLowerCase()==='no');
      if(!rows.length){ panel.innerHTML=''; return; }
      panel.innerHTML='<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:12px;padding:12px;">'
        + '<div style="font-weight:800;color:#c2410c;margin-bottom:6px;">✎ Needs edit — Dutta Sir asked to correct these quantities</div>'
        + rows.map(r=>{ const p=Math.round(r.PhysicalQty||0); const key='ne_'+(r.ItemCode||'').replace(/[^A-Za-z0-9]/g,'');
            return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #fed7aa;">'
              + '<b>'+esc(r.ItemCode||'')+'</b> <span style="color:#64748b;">'+esc(r.ItemName||'')+'</span>'
              + '<span style="margin-left:auto;">Total: <b>'+p+'</b></span>'
              + '<input id="'+key+'" type="number" min="0" value="'+p+'" style="width:84px;padding:6px;border:1px solid var(--line);border-radius:6px;font-weight:700;">'
              + '<button class="btn sm" style="background:#16a34a;color:#fff;font-weight:800;" onclick="retailerSaveEdit(\''+esc(r.ItemCode)+'\',\''+key+'\')">Save</button>'
              + '</div>'; }).join('')
        + '</div>';
    }catch(e){ panel.innerHTML=''; }
  }
  window.retailerSaveEdit = async function(code, key){
    const inp=document.getElementById(key); if(!inp) return;
    const q=Math.round(Number(inp.value)); if(!Number.isFinite(q)||q<0){ toast('Enter a valid number'); return; }
    try{
      const resp=await api('/api/store/retailer/audit-edit-qty',{method:'PUT',body:JSON.stringify({itemCode:code,qty:q})});
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('✓ Updated '+code+' to '+q);
      bjEnsureNeedsEditPanel(true);
      if(typeof refreshList==='function') refreshList();
    }catch(e){ toast('Edit failed: '+(e.message||e)); }
  };
  function bjEnsureInwardModeBar(){
    if(isStoreSide()) return;                        // auditors only
    const anchor = $('scanCard'); if(!anchor || !anchor.parentElement) return;
    if(document.getElementById('inwardModeBar')) return;
    const bar=document.createElement('div'); bar.id='inwardModeBar';
    bar.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px;';
    const label=document.createElement('span'); label.textContent='Capture to:'; label.style.cssText='font-weight:700;color:#334155;';
    const mk=(txt,mode)=>{ const b=document.createElement('button'); b.type='button'; b.textContent=txt; b.dataset.imode=mode;
      b.onclick=()=>{ inwardMode=mode; bjPaintInwardMode(); toast(mode==='final'?'🔒 Scans go straight to OVERALL':'📅 Scans go to Today'); }; return b; };
    bar.appendChild(label);
    bar.appendChild(mk('📅 Today','today'));
    bar.appendChild(mk('🔒 Overall','final'));
    anchor.parentElement.insertBefore(bar, anchor);
    /* date filter for the Inward list (auditors) */
    if(!document.getElementById('inDateBar')){
      const db=document.createElement('div'); db.id='inDateBar';
      db.style.cssText='display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px;font-weight:700;';
      db.innerHTML='📅 Dates: '
        + '<select id="inDateMode" style="padding:5px 8px;border-radius:6px;border:1px solid var(--line);"><option value="">All dates</option><option value="date">Specific date</option><option value="range">Date range</option></select>'
        + '<input id="inDateOne" type="date" style="padding:5px;border-radius:6px;border:1px solid var(--line);display:none;">'
        + '<input id="inDateFrom" type="date" style="padding:5px;border-radius:6px;border:1px solid var(--line);display:none;">'
        + '<input id="inDateTo" type="date" style="padding:5px;border-radius:6px;border:1px solid var(--line);display:none;">'
        + '<button id="inDateApply" class="btn sm" style="background:var(--brand);color:#fff;">Apply</button>'
        + '<button id="inDateClear" class="btn sm" style="background:#64748b;color:#fff;">Clear</button>';
      anchor.parentElement.insertBefore(db, anchor);
      const rerender=()=>{ if(typeof window.renderList==='function') window.renderList(); };
      setTimeout(()=>{
        const mode=$('inDateMode'),one=$('inDateOne'),from=$('inDateFrom'),to=$('inDateTo');
        mode.onchange=()=>{ one.style.display=mode.value==='date'?'':'none'; from.style.display=to.style.display=mode.value==='range'?'':'none'; };
        $('inDateApply').onclick=()=>{
          if(mode.value==='date'){ window._inFrom=window._inTo=one.value||''; }
          else if(mode.value==='range'){ window._inFrom=from.value||''; window._inTo=to.value||''; }
          else { window._inFrom=window._inTo=''; }
          rerender();
        };
        $('inDateClear').onclick=()=>{ mode.value=''; one.value=from.value=to.value=''; one.style.display=from.style.display=to.style.display='none'; window._inFrom=window._inTo=''; rerender(); };
      },0);
    }
    bjPaintInwardMode();
  }
  function bjPaintInwardMode(){
    const bar=document.getElementById('inwardModeBar'); if(!bar) return;
    bar.querySelectorAll('button[data-imode]').forEach(b=>{
      const on=b.dataset.imode===inwardMode;
      b.style.cssText='padding:8px 14px;border-radius:9px;font-weight:700;cursor:pointer;border:1px solid var(--line);'
        +(on?(inwardMode==='final'?'background:#7c3aed;color:#fff;':'background:var(--brand);color:#fff;'):'background:#fff;color:#334155;');
    });
  }
  /* When Inward is in Final mode, auto-add each saved inward scan to Overall by
     wrapping app.js's saveRow (which POSTs the scan first, so the row exists
     before we transfer it). */
  (function wrapSaveRowForFinal(){
    if(typeof window.saveRow !== 'function' || window._bjSaveRowWrapped) return;
    window._bjSaveRowWrapped = true;
    const _origSaveRow = window.saveRow;
    window.saveRow = async function(dir, model, qtyPerBox, boxes, status, thumb, photo, itemCode){
      const result = await _origSaveRow.apply(this, arguments);
      try{
        if(inwardMode==='final' && dir==='IN' && !isStoreSide()){   // Overall-mode inward capture → auto-add to Overall
          const code = itemCode || window._lastScanCode;
          if(code){
            const resp = await api('/api/store/retailer/audit-transfer?item='+encodeURIComponent(code), { method:'POST' });
            if(resp.ok) toast('🔒 Added '+code+' to Overall');
          }
        }
      }catch(e){ toast('Auto-final failed: '+(e.message||e)); }
      return result;
    };
  })();

  async function loadStoreAudit(){
    bjEnsureAuditModeBar();
    bjInjectAuditFilter('sa', loadStoreAudit, '/api/store/retailer/store-audit-excel', 'Store Audit');
    bjPaintModeTabs();
    const url = (saMode==='final')
      ? '/api/store/retailer/audit-final'+bjFilterQS('sa')     // Overall: all by default; date filter if applied
      : '/api/store/retailer/audit-today'+bjFilterQS('sa');   // Today: today by default; date filter if applied
    setHTML('storeAuditBody', '<tr><td colspan="10" class="empty">Loading…</td></tr>');
    try{
      const resp = await api(bjBust(url));
      if(!resp.ok){ let d=''; try{ d=(await resp.json()).detail||''; }catch(_){} throw new Error('HTTP '+resp.status+(d?(' — '+d):'')); }
      saRows = await resp.json();
      window._saSig = bjSaSig(saRows);
      renderStoreAudit();
      bjLoadPeople();
      bjLoadProgress();
      bjLoadSystemCount();
      bjStartTodayPoll();
    }catch(e){
      setHTML('storeAuditBody', '<tr><td colspan="10" class="empty">Could not load: '+esc(e.message)+'</td></tr>');
    }
  }
  /* live auto-refresh for Today's Auditing: re-fetch every few seconds and re-render
     ONLY when something changed (new capture, transfer, delete) — so new items appear
     without a manual refresh, and the list doesn't flicker when nothing changed. */
  function bjSaSig(rows){ return JSON.stringify((rows||[]).map(r=>[r.ItemCode, r.PhysicalQty, r.PendingQty, r.Transferred?1:0, r.Decision||'', r.CorrectedQty||''])); }
  function bjFmtDur(sec){ sec=Math.max(0,Math.round(Number(sec)||0)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
  let saPeopleData = [];
  async function bjLoadPeople(){
    try{
      const resp=await api(bjBust('/api/store/retailer/audit-people?mode='+saMode+bjFilterQS('sa').replace('?','&')));
      saPeopleData = resp.ok ? (await resp.json()||[]) : [];
    }catch(e){ saPeopleData=[]; }
    bjRenderDashboard();
  }
  /* Both counts shown together at the top-LEFT: "Physical items: N  System items: M".
     Physical = audited items (was the "N items" text); System = live RETAILER items in
     stock (NAV Item Ledger: distinct [Item No_] LIKE 'RETAILER%' with remaining qty > 0). */
  let saPhysCount = 0;
  let saSysCount  = null;
  function bjRenderSysCount(){
    const el = document.getElementById('storeAuditCount');
    if(!el) return;
    const sysTxt = (saSysCount==null) ? '…' : saSysCount;
    el.classList.add('sa-counts');
    el.innerHTML =
      '<span class="sa-count-pill sa-count-phys">Physical items <b>'+saPhysCount+'</b></span>'
      + '<span class="sa-count-pill sa-count-sys">System items <b>'+sysTxt+'</b></span>';
    /* let the header row wrap so these sit on their own line, flush left, on any width */
    const p = el.parentElement;
    if(p){ try{
      if(getComputedStyle(p).display.indexOf('flex') >= 0){ p.style.flexWrap='wrap'; p.style.justifyContent='flex-start'; }
      else { p.style.textAlign='left'; }
    }catch(e){} }
    const old = document.getElementById('storeAuditSysCount'); if(old && old!==el) old.remove();  // drop the earlier standalone pill
  }
  /* the date the audit view is scoped to → the system count is computed "as of" it,
     so it lines up with the physical audit for that day (not today's live stock). */
  function bjAuditAsOf(){
    const f = (typeof bjAuditFilter!=='undefined' && bjAuditFilter.sa) ? bjAuditFilter.sa : null;
    if(f && f.date) return f.date;      // specific day
    if(f && f.to)   return f.to;         // date range → end of range
    const d=new Date();                  // default: today
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  async function bjLoadSystemCount(){
    try{
      const r = await api('/api/store/retailer/audit-system-count?asOf='+encodeURIComponent(bjAuditAsOf()));
      if(r.ok){ const d=await r.json(); saSysCount = Number(d.count)||0; }
    }catch(e){ /* keep whatever we had */ }
    bjRenderSysCount();
  }
  /* live dashboard: per person → Matched / Exceed / Short (from row colours) + Time
     (first→last capture), with a Total row. Grouped by the item's capturer. */
  function bjRenderDashboard(){
    const el=document.getElementById('saDashboard'); if(!el) return;
    const byPerson={};
    (saRows||[]).forEach(r=>{
      const nm=((r.LastBy||'').toString().split('@')[0]).trim() || '—';
      const s=(r.SystemQty!=null?Math.round(r.SystemQty):null); const p=bjEffQty(r);
      const g = byPerson[nm] || (byPerson[nm]={matched:0,exceed:0,short:0});
      if(s==null) return; if(p===s) g.matched++; else if(p>s) g.exceed++; else g.short++;
    });
    const timeByName={}; (saPeopleData||[]).forEach(p=>{ timeByName[((p.name||'').split('@')[0]).trim()] = Number(p.seconds)||0; });
    const names=Object.keys(byPerson);
    if(!names.length){ el.innerHTML=''; return; }
    let tm=0,te=0,ts=0,tsec=0,tt=0;
    const body=names.map((nm,i)=>{
      const g=byPerson[nm]; const secs=timeByName[nm]||0; const tot=g.matched+g.exceed+g.short;
      tm+=g.matched; te+=g.exceed; ts+=g.short; tsec+=secs; tt+=tot;
      return '<tr>'
        + '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+(i+1)+'</td>'
        + '<td style="padding:5px 10px;border:1px solid var(--line);font-weight:700;">'+esc(nm)+'</td>'
        + '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+g.matched+'</td>'
        + '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+g.exceed+'</td>'
        + '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+g.short+'</td>'
        + '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;font-weight:800;">'+tot+'</td>'
        + '<td style="padding:5px 10px;border:1px solid var(--line);text-align:center;font-variant-numeric:tabular-nums;">'+bjFmtDur(secs)+'</td>'
        + '</tr>';
    }).join('');
    const th='padding:6px 8px;border:1px solid var(--line);font-weight:800;text-align:center;';
    el.innerHTML =
      '<div style="font-weight:800;margin:2px 0 6px;">📊 Live audit dashboard ('+(saMode==='final'?'Overall':'Today')+')</div>'
      + '<table style="border-collapse:collapse;font-size:13px;min-width:520px;">'
      + '<thead><tr>'
      +   '<th style="'+th+'">Sr.No.</th>'
      +   '<th style="'+th+'text-align:left;">Name</th>'
      +   '<th style="'+th+'background:#16a34a;color:#fff;">Matched</th>'
      +   '<th style="'+th+'background:#dc2626;color:#fff;">Exceed</th>'
      +   '<th style="'+th+'background:#facc15;color:#000;">Short</th>'
      +   '<th style="'+th+'background:#334155;color:#fff;">Total</th>'
      +   '<th style="'+th+'">Time</th>'
      + '</tr></thead><tbody>'
      + body
      + '<tr style="font-weight:800;background:#f1f5f9;">'
      +   '<td style="padding:5px 8px;border:1px solid var(--line);"></td>'
      +   '<td style="padding:5px 10px;border:1px solid var(--line);">Total</td>'
      +   '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+tm+'</td>'
      +   '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+te+'</td>'
      +   '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+ts+'</td>'
      +   '<td style="padding:5px 8px;border:1px solid var(--line);text-align:center;">'+tt+'</td>'
      +   '<td style="padding:5px 10px;border:1px solid var(--line);text-align:center;font-variant-numeric:tabular-nums;">'+bjFmtDur(tsec)+'</td>'
      + '</tr>'
      + '</tbody></table>';
  }
  let _saPollTimer = null;
  function bjStartTodayPoll(){
    if(_saPollTimer) return;
    _saPollTimer = setInterval(async ()=>{
      try{
        const view = $('view-storeaudit');
        if(!view || view.classList.contains('hidden')) return;   // only when Store Audit is open
        const url = (saMode==='final')
          ? '/api/store/retailer/audit-final'+bjFilterQS('sa')
          : '/api/store/retailer/audit-today'+bjFilterQS('sa');
        const resp = await api(bjBust(url));
        if(!resp.ok) return;
        const fresh = await resp.json();
        const sig = bjSaSig(fresh);
        if(sig !== window._saSig){ window._saSig = sig; saRows = fresh; renderStoreAudit(); bjLoadPeople(); bjLoadProgress(); }
      }catch(e){}
    }, 6000);
  }
  function renderStoreAudit(){
    let rows = saRows||[];
    const isToday = (saMode==='today');
    const R = bjComputeRole();
    const canDel = isToday && isStoreSide();          // delete inward: store/admin
    const canXfer = isToday && (R.isAuditor || R.isStore);   // transfer: auditor + store (NOT admin)
    const q = ($('saSearch').value||'').trim().toLowerCase();
    if(q) rows = rows.filter(r=>(r.ItemName||'').toLowerCase().includes(q)
        || (r.ItemCode||'').toLowerCase().includes(q)
        || (r.LastBy||'').toLowerCase().includes(q)
        || String(Math.round(r.PhysicalQty||0)).includes(q));
    /* repopulate the header "captured by" dropdown from the data (keep selection) */
    { const psel=document.getElementById('saPersonFilter');
      if(psel){ const cur=window._saPersonSel||'all';
        const people=[...new Set((saRows||[]).map(r=>((r.LastBy||'').split('@')[0]).trim()).filter(Boolean))].sort();
        psel.innerHTML='<option value="all">All</option>'+people.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
        psel.value = people.includes(cur)?cur:'all';
      } }
    const pf=window._saPersonSel||'all';
    const sset=window._saStatSet;   // multi-select colour statuses (empty = all)
    if(sset && sset.size) rows = rows.filter(r=>{ const s=(r.SystemQty!=null?Math.round(r.SystemQty):null); const p=bjEffQty(r);
      if(s==null) return false; const st=(p===s?'matched':(p>s?'exceed':'short')); return sset.has(st); });
    if(pf!=='all') rows = rows.filter(r=>((r.LastBy||'').split('@')[0]).trim()===pf);
    rows = bjSortRows(rows, 'saudit', bjTime('LastScan'));
    saPhysCount = rows.length;
    bjRenderSysCount();
    /* if a colour filter is hiding rows, say so — an adjusted item that turns green
       leaves a Short/Exceed filter, which otherwise looks like the row "vanished" */
    { const el=$('storeAuditEmpty');
      if(el && rows.length===0 && (saRows||[]).length>0){
        const bits=[];
        if(q) bits.push('the search "'+esc(q)+'"');
        if(window._saStatSet && window._saStatSet.size) bits.push('the Physical Qty filter');
        if(window._saPersonSel && window._saPersonSel!=='all') bits.push('the Captured By filter');
        el.innerHTML = bits.length
          ? ('No rows match '+bits.join(' + ')+'. Clear it to see all '+(saRows||[]).length+' items.')
          : 'No inward data yet.';
      } }
    bjRenderDashboard();
    $('storeAuditEmpty').classList.toggle('hidden', rows.length>0);
    { const _e=$('storeAuditBody'); if(_e) _e.innerHTML = rows.map((r,i)=>{
      const sys = (r.SystemQty!=null?Math.round(r.SystemQty):null);
      const phy = Math.round(r.PhysicalQty||0);
      const eff = bjEffQty(r);        // colour follows the verification on its own date
      let xferCell='';
      if(canXfer){
        xferCell = r.Transferred
          ? '<td><span class="badge ok" title="Already transferred to Overall">✓ Transferred</span></td>'
          : '<td><button class="btn sm" title="Add this item\u2019s today count to Overall" style="background:#7c3aed;color:#fff;font-weight:800;" onclick="retailerTransferToday(\''+esc(r.ItemCode)+'\')">⬆ Transfer</button></td>';
      }
      /* Verified column: only for short/exceed (not matched, not blank system) */
      let verCell='<td>—</td>';
      const dec=(r.Decision||'').toLowerCase();
      const adj=(r.CorrectedQty!=null);
      const mismatch=(sys!=null && phy!==sys);
      const adjBy=((r.CorrectedBy||'').split('@')[0])||'auditor';
      if(mismatch || adj){
        let badge='';
        if(dec==='yes')      badge='<span class="badge" style="background:#dcfce7;color:#15803d;font-weight:800;">Verified by Dutta Sir</span>';
        else if(dec==='no')  badge='<span class="badge" style="background:#fee2e2;color:#b91c1c;font-weight:800;">No by Dutta Sir</span>'
                                 + (adj ? ' <span class="badge" style="background:#dcfce7;color:#15803d;font-weight:800;">Adjusted by '+esc(adjBy)+'</span>' : '');
        else                 badge='<span class="badge" style="background:#f1f5f9;color:#475569;font-weight:700;">Pending with Dutta Sir</span>';

        if(!dec && R.isStore){
          /* not decided yet — the store chooses */
          verCell='<td><div style="display:flex;gap:5px;">'
            + '<button class="btn sm" style="background:#16a34a;color:#fff;font-weight:800;" onclick="retailerAuditVerify(\''+esc(r.ItemCode)+'\',\'yes\')">Yes</button>'
            + '<button class="btn sm" style="background:#dc2626;color:#fff;font-weight:800;" onclick="retailerAuditVerify(\''+esc(r.ItemCode)+'\',\'no\')">No</button>'
            + '</div></td>';
        }
        else if(dec && R.isStore){
          /* already decided — just the status, with Reset to change it */
          verCell='<td><div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">'
            + badge
            + '<button class="btn sm" style="background:#64748b;color:#fff;font-weight:800;" onclick="retailerAuditVerify(\''+esc(r.ItemCode)+'\',\'reset\')">↺ Reset</button>'
            + '</div></td>';
        }
        else if(R.isAuditor && dec==='no' && !adj){
          verCell='<td><div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">'
            + badge
            + '<input type="number" class="sa-eq" data-code="'+esc(r.ItemCode)+'" value="'+phy+'" style="width:62px;padding:4px;border:1px solid var(--line);border-radius:6px;">'
            + '<button class="btn sm" style="background:#0ea5e9;color:#fff;font-weight:800;" onclick="retailerEditQtyInline(this)">💾 Save</button>'
            + '</div></td>';
        }
        else verCell='<td>'+badge+'</td>';
      }
      return '<tr>'
        + '<td>'+(i+1)+'</td>'
        + '<td><b>'+esc(r.ItemCode||'—')+'</b></td>'
        + '<td>'+esc(r.ItemName||'—')+'</td>'
        + '<td class="num big" style="color:var(--brand);">'+(sys!=null?sys:'—')+'</td>'
        + '<td class="'+qtyClass(eff,sys)+' big">'+eff+(eff!==phy?(' <span style="color:#64748b;font-weight:600;font-size:11px;">(was '+phy+')</span>'):'')+'</td>'
        + verCell
        + bjBeforeCell(r, phy, sys)
        + bjAfterCell(r, phy, sys)
        + '<td>'+((r.VerifiedAt && !(r.CorrectedQty==null && sys!=null && phy===sys))?fmtDateTime(r.VerifiedAt):'—')+'</td>'
        + '<td>'+(r.LastScan?fmtDateTime(r.LastScan):'—')+'</td>'
        + '<td>'+esc(r.LastBy||'—')+'</td>'
        + '<td>'+photoCell(r.LastImage)+'</td>'
        + xferCell
        + (canDel ? '<td><button class="btn sm" title="Delete this item\u2019s inward audit" style="background:var(--red,#dc2626);color:#fff;font-weight:800;" onclick="retailerStoreAuditDelete(\''+esc(r.ItemCode)+'\')">✕</button></td>' : '')
        + '</tr>';
    }).join(''); }
    /* keep the dynamic Transfer / Delete headers in sync with the mode */
    { const tb=$('storeAuditBody'); const table=tb&&tb.closest?tb.closest('table'):null;
      const tr=table?table.querySelector('thead tr'):null;
      if(tr){
        tr.querySelectorAll('th[data-bjxfer],th[data-bjdel],th[data-bjver]').forEach(th=>th.remove());
        /* Verified header right after "Physical Qty" (5th column, index 4) */
        const ths=tr.querySelectorAll('th');
        const mk=(txt)=>{ const th=document.createElement('th'); th.setAttribute('data-bjver','1'); th.textContent=txt; return th; };
        const vth=mk('Verified'), bth=mk('Before Verification'), ath=mk('After Verification'), tth=mk('Verification Time');
        const anchor = (ths[4] && ths[4].nextSibling) ? ths[4].nextSibling : null;
        if(anchor){ tr.insertBefore(vth,anchor); tr.insertBefore(bth,anchor); tr.insertBefore(ath,anchor); tr.insertBefore(tth,anchor); }
        else { tr.appendChild(vth); tr.appendChild(bth); tr.appendChild(ath); tr.appendChild(tth); }
        if(canXfer){ const t=document.createElement('th'); t.setAttribute('data-bjxfer','1'); t.textContent='Transfer'; tr.appendChild(t); }
        if(canDel){ const d=document.createElement('th'); d.setAttribute('data-bjdel','1'); d.textContent='Delete'; tr.appendChild(d); }
        /* embed the filters INSIDE the Physical Qty + Captured By headers (Excel-style) */
        tr.querySelectorAll('th').forEach(th=>{
          const t=(th.textContent||'').trim().toLowerCase();
          if(t.indexOf('physical')===0 && !th.querySelector('.saqtyf')){
            const wrap=document.createElement('div'); wrap.className='saqtyf'; wrap.style.cssText='position:relative;margin-top:4px;font-weight:500;';
            wrap.innerHTML='<button type="button" id="saQtyBtn" class="btn sm" style="background:#fff;color:#0f172a;border:1px solid var(--line);width:100%;font-weight:700;">Filter ▾</button>'
              + '<div id="saQtyPanel" style="display:none;position:absolute;z-index:200;left:0;top:100%;margin-top:3px;background:#fff;border:1px solid #e2e8f0;border-radius:9px;box-shadow:0 8px 20px rgba(15,23,42,.16);padding:8px;min-width:150px;max-height:250px;overflow:auto;"></div>';
            th.appendChild(wrap);
            wrap.querySelector('#saQtyBtn').onclick=(e)=>{ e.stopPropagation();
              const p=document.getElementById('saQtyPanel');
              if(p && p.style.display==='block') bjCloseQtyPanel(); else bjOpenQtyPanel(); };
          }
          if(t.indexOf('captured')===0 && !th.querySelector('select')){
            const s=document.createElement('select'); s.id='saPersonFilter';
            s.style.cssText='display:block;margin-top:4px;padding:3px 6px;border-radius:6px;border:1px solid var(--line);font-weight:600;width:100%;';
            s.innerHTML='<option value="all">All</option>';
            s.value=window._saPersonSel||'all'; s.onchange=()=>{ window._saPersonSel=s.value; renderStoreAudit(); }; th.appendChild(s);
          }
        });
      } }
    bjRenderQtyPanel();
    bjEnsureTopScroller('storeAuditBody');
    bjWireSortHeader('storeAuditBody', 'capture date', 'saudit', renderStoreAudit);
  }
  /* a horizontal slider ABOVE the table, synced with it — so every column can be
     reached without scrolling to the bottom (desktop and mobile). */
  function bjEnsureTopScroller(bodyId){
    const tb=$(bodyId); const table=tb&&tb.closest?tb.closest('table'):null; if(!table) return;
    const wrap=table.parentElement; if(!wrap) return;
    wrap.style.overflowX='auto';
    let top=wrap.previousElementSibling;
    if(!top || !top.classList || !top.classList.contains('bj-topscroll')){
      top=document.createElement('div'); top.className='bj-topscroll';
      top.style.cssText='overflow-x:auto;overflow-y:hidden;height:14px;margin-bottom:4px;';
      const inner=document.createElement('div'); inner.style.height='1px'; top.appendChild(inner);
      wrap.parentElement.insertBefore(top, wrap);
      let lock=false;
      top.addEventListener('scroll',()=>{ if(lock) return; lock=true; wrap.scrollLeft=top.scrollLeft; lock=false; });
      wrap.addEventListener('scroll',()=>{ if(lock) return; lock=true; top.scrollLeft=wrap.scrollLeft; lock=false; });
    }
    top.firstChild.style.width = table.scrollWidth + 'px';
    top.style.display = (table.scrollWidth > wrap.clientWidth) ? '' : 'none';
  }
  function bjUpdateQtyBtn(){
    const b=document.getElementById('saQtyBtn'); const set=window._saStatSet;
    if(!b) return;
    if(set && set.size){ b.textContent='Filter ('+set.size+') ▾'; b.style.background='#fde68a'; b.style.color='#92400e'; b.style.borderColor='#f59e0b'; }
    else { b.textContent='All ▾'; b.style.background='#fff'; b.style.color='#0f172a'; b.style.borderColor='var(--line)'; }
  }
  /* Physical-Qty filter panel. Rendered FIXED to the viewport so it can never be
     clipped by the table's horizontal scroll (that was the "filter does nothing"
     bug on both desktop and mobile). */
  function bjRenderQtyPanel(){
    const panel=document.getElementById('saQtyPanel'); if(!panel) return;
    if(!window._saStatSet) window._saStatSet=new Set();
    const set=window._saStatSet;
    const opts=[['matched','🟢 Matched'],['exceed','🔴 Exceed'],['short','🟡 Short']];
    const allOn = (set.size===0);
    panel.innerHTML =
        '<label style="display:flex;align-items:center;gap:8px;padding:7px 4px;cursor:pointer;font-weight:800;border-bottom:1px solid #e2e8f0;margin-bottom:4px;">'
      +   '<input type="checkbox" id="saQtyAllCb"'+(allOn?' checked':'')+'> (All)</label>'
      + opts.map(o=>'<label style="display:flex;align-items:center;gap:8px;padding:7px 4px;cursor:pointer;font-weight:600;">'
      +   '<input type="checkbox" class="saqtycb" value="'+o[0]+'"'+(set.has(o[0])?' checked':'')+'> '+o[1]+'</label>').join('')
      + '<div style="display:flex;gap:6px;margin-top:6px;">'
      +   '<button type="button" id="saQtyClose" class="btn sm" style="background:var(--brand);color:#fff;flex:1;">Done</button></div>';

    panel.querySelectorAll('.saqtycb').forEach(cb=>{
      cb.onchange=()=>{ if(cb.checked) set.add(cb.value); else set.delete(cb.value); bjRenderQtyPanel(); renderStoreAudit(); };
    });
    const all=panel.querySelector('#saQtyAllCb');
    if(all) all.onchange=()=>{ set.clear(); bjRenderQtyPanel(); renderStoreAudit(); };
    const c=panel.querySelector('#saQtyClose'); if(c) c.onclick=()=>bjCloseQtyPanel();
    bjUpdateQtyBtn();
  }
  function bjOpenQtyPanel(){
    const panel=document.getElementById('saQtyPanel'), btn=document.getElementById('saQtyBtn');
    if(!panel||!btn) return;
    const r=btn.getBoundingClientRect();
    panel.style.position='fixed';
    panel.style.top  = Math.min(r.bottom+4, window.innerHeight-260)+'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth-190))+'px';
    panel.style.display='block';
    bjRenderQtyPanel();
  }
  function bjCloseQtyPanel(){ const p=document.getElementById('saQtyPanel'); if(p) p.style.display='none'; }
  if(!window._saQtyOutside){ window._saQtyOutside=true;
    document.addEventListener('click',(e)=>{
      const p=document.getElementById('saQtyPanel'), b=document.getElementById('saQtyBtn');
      if(p && p.style.display==='block' && !p.contains(e.target) && e.target!==b && !(b&&b.contains(e.target))) bjCloseQtyPanel();
    });
    window.addEventListener('resize', bjCloseQtyPanel);
  }
  /* Which quantity decides the colour on the date being viewed?
       - on the VERIFICATION date  -> the outcome of the verification
         (the adjusted qty, so a corrected item that now matches shows GREEN)
       - on the CAPTURE date       -> the original captured qty (the real discrepancy) */
  function bjEffQty(r){
    const phy = Math.round(r.PhysicalQty||0);
    /* Physical Qty is FROZEN on the capture date — it always shows what was counted.
       Only on the date the qty was ADJUSTED does it show the adjusted figure. */
    if(r.CorrectedOnDate && r.CorrectedQty!=null) return Math.round(Number(r.CorrectedQty));
    return phy;
  }
  /* BEFORE VERIFICATION — the discrepancy exactly as captured. Never changes. */
  function bjBeforeCell(r, phy, sys){
    if(sys==null) return '<td>—</td>';
    if(phy===sys) return '<td><span class="badge" style="background:#dcfce7;color:#15803d;font-weight:800;">Matched</span></td>';
    if(phy > sys) return '<td><span class="badge" style="background:#fee2e2;color:#b91c1c;font-weight:800;">Exceed by '+(phy-sys)+'</span></td>';
    return '<td><span class="badge" style="background:#fef9c3;color:#a16207;font-weight:800;">Short by '+(sys-phy)+'</span></td>';
  }
  /* AFTER VERIFICATION — the outcome.
       Yes        : the count stands  -> Exceed by X / Short by X / Matched
       No, no fix : Pending edit
       Adjusted   : judged on the adjusted qty -> Matched by N qty / Exceed by X qty */
  function bjAfterCell(r, phy, sys){
    const dec=(r.Decision||'').toLowerCase();
    const adj=(r.CorrectedQty!=null);
    const G='style="background:#dcfce7;color:#15803d;font-weight:800;"';
    const R_='style="background:#fee2e2;color:#b91c1c;font-weight:800;"';
    const Y='style="background:#fef9c3;color:#a16207;font-weight:800;"';
    if(sys==null || (!dec && !adj)) return '<td>—</td>';
    /* If the item NOW matches system and there is no active correction, nothing is
       outstanding — a stale Yes/No from when the count differed must not linger.
       (This is what made a Matched item wrongly read "Pending edit".) */
    if(!adj && phy===sys) return '<td>—</td>';
    if(adj){                                   /* judged on the ADJUSTED qty */
      const cq=Math.round(Number(r.CorrectedQty));
      if(cq===sys) return '<td><span class="badge" '+G+'>Matched by '+cq+' qty</span></td>';
      if(cq > sys) return '<td><span class="badge" '+R_+'>Exceed by '+(cq-sys)+' qty</span></td>';
      return '<td><span class="badge" '+Y+'>Short by '+(sys-cq)+' qty</span></td>';
    }
    if(dec==='yes'){                           /* count accepted -> same as Before */
      const note=' <span style="color:#64748b;font-weight:600;font-size:11px;">accepted</span>';
      if(phy===sys) return '<td><span class="badge" '+G+'>Matched</span></td>';
      if(phy > sys) return '<td><span class="badge" '+R_+'>Exceed by '+(phy-sys)+'</span>'+note+'</td>';
      return '<td><span class="badge" '+Y+'>Short by '+(sys-phy)+'</span>'+note+'</td>';
    }
    if(dec==='no') return '<td><span class="badge" '+R_+'>Pending edit</span></td>';
    return '<td>—</td>';
  }
  /* ── PROGRESS DASHBOARD: how the discrepancies were resolved, day by day ── */
  async function bjLoadProgress(){
    const el=document.getElementById('saProgress'); if(!el) return;
    if(saMode!=='today'){ el.innerHTML=''; return; }
    try{
      const resp=await api(bjBust('/api/store/retailer/audit-progress'+bjFilterQS('sa')));
      if(!resp.ok){ el.innerHTML=''; return; }
      const rows=await resp.json();
      if(!rows || rows.length<2){ el.innerHTML=''; return; }   // nothing resolved yet
      const bd='1px solid var(--line)';
      const th='padding:6px 10px;border:'+bd+';font-weight:800;text-align:center;';
      const td='padding:5px 10px;border:'+bd+';text-align:center;';
      const dstr=(d)=>{ try{ const p=String(d).split('-');
        return new Date(+p[0], +p[1]-1, +p[2]).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}); }catch(e){ return d; } };
      el.innerHTML =
        '<div style="font-weight:800;margin:2px 0 6px;">📈 Progress dashboard <span style="font-weight:600;color:#64748b;font-size:12px;">— running totals after each day\u2019s verification</span></div>'
        + '<table style="border-collapse:collapse;font-size:13px;min-width:620px;">'
        + '<thead><tr>'
        +   '<th style="'+th+'text-align:left;">Date</th>'
        +   '<th style="'+th+'background:#16a34a;color:#fff;">Matched</th>'
        +   '<th style="'+th+'background:#dc2626;color:#fff;">Exceed</th>'
        +   '<th style="'+th+'background:#facc15;color:#000;">Short</th>'
        +   '<th style="'+th+'background:#334155;color:#fff;">Total</th>'
        + '</tr></thead><tbody>'
        + rows.map(r=>{
            const label = r.isAuditDay ? (dstr(r.date)+' — as audited') : (dstr(r.date)+' — after verification');
            /* movement since the previous day; for exceed/short, DOWN is good */
            const mv=(n,goodDown)=>{ if(!n) return '';
              const up=n>0, good=goodDown?!up:up;
              return ' <span style="color:'+(good?'#15803d':'#b91c1c')+';font-weight:800;font-size:11px;">'+(up?'▲ +':'▼ ')+n+'</span>'; };
            return '<tr'+(r.isAuditDay?' style="background:#f8fafc;"':'')+'>'
              + '<td style="'+td+'text-align:left;font-weight:700;">'+esc(label)+'</td>'
              + '<td style="'+td+'font-weight:800;color:#15803d;">'+r.matched+mv(r.dMatched,false)+'</td>'
              + '<td style="'+td+'font-weight:700;color:#b91c1c;">'+r.exceed+mv(r.dExceed,true)+'</td>'
              + '<td style="'+td+'font-weight:700;color:#a16207;">'+r.short+mv(r.dShort,true)+'</td>'
              + '<td style="'+td+'">'+r.total+'</td>'
              + '</tr>';
          }).join('')
        + '</tbody></table>';
    }catch(e){ el.innerHTML=''; }
  }
  window.retailerAuditVerify = async function(code, decision){
    try{
      const resp=await api('/api/store/retailer/audit-verify',{method:'POST',body:JSON.stringify({itemCode:code,decision})});
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast(decision==='yes'?'✓ Verified by Dutta Sir':(decision==='no'?'✗ Marked — edit in inward':'↺ Reset'));
      loadStoreAudit();
    }catch(e){ toast('Failed: '+(e.message||e)); }
  };
  window.retailerEditQtyInline = async function(btn){
    const cell=btn.closest('td'); const inp=cell&&cell.querySelector('input.sa-eq'); if(!inp) return;
    const code=inp.getAttribute('data-code'); const q=Math.round(Number(inp.value));
    if(!Number.isFinite(q)||q<0){ toast('Enter a valid number'); return; }
    try{
      const resp=await api('/api/store/retailer/audit-edit-qty',{method:'PUT',body:JSON.stringify({itemCode:code,qty:q})});
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('✓ Qty updated to '+q); loadStoreAudit();
    }catch(e){ toast('Edit failed: '+(e.message||e)); }
  };
  window.retailerEditQty = async function(code, currentQty){
    const val=prompt('Edit physical qty for '+code+':', currentQty!=null?currentQty:'');
    if(val==null) return;
    const q=Math.round(Number(val)); if(!Number.isFinite(q)||q<0){ toast('Enter a valid number'); return; }
    try{
      const resp=await api('/api/store/retailer/audit-edit-qty',{method:'PUT',body:JSON.stringify({itemCode:code,qty:q})});
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      toast('✓ Qty updated to '+q);
      if(typeof loadStoreAudit==='function') loadStoreAudit();
      if(typeof refreshList==='function') refreshList(); else if(typeof window.loadInwardList==='function') window.loadInwardList();
    }catch(e){ toast('Edit failed: '+(e.message||e)); }
  };
  window.retailerTransferToday = async function(code){
    const what = code ? ('item '+code) : 'ALL of today\u2019s counted items';
    if(!confirm('Transfer '+what+' into Overall?\n\nToday\u2019s counts are ADDED on top of the existing Overall quantity. Already-transferred scans are skipped, so this won\u2019t double-count.')) return;
    try{
      const resp = await api('/api/store/retailer/audit-transfer'+(code?('?item='+encodeURIComponent(code)):''), { method:'POST' });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      const j = await resp.json().catch(()=>({}));
      toast('⬆ Transferred to Overall'+(j.scansMarked!=null?(' ('+j.scansMarked+' scans)'):''));
      loadStoreAudit();
    }catch(e){ toast('Transfer failed: '+(e.message||e)); }
  };
  window.retailerStoreAuditDelete = async function(code){
    if(!confirm('Delete TODAY\u2019s inward for item '+code+'?\nToday\u2019s count is removed, and only today\u2019s transferred amount is subtracted from Overall (earlier days stay).')) return;
    try{
      const resp = await api('/api/store/retailer/store-audit/'+encodeURIComponent(code), { method:'DELETE' });
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      const j = await resp.json().catch(()=>({}));
      toast('🗑 Deleted today'+(j.finalSubtracted?(' · Overall −'+Math.round(j.finalSubtracted)):''));
      loadStoreAudit();
    }catch(e){ toast('Delete failed: '+e.message); }
  };
  $('saSearch') && ($('saSearch').oninput = ()=>{ clearTimeout(window._saT); window._saT=setTimeout(renderStoreAudit,200); });


  /* ════════════════════════ SHIPMENT MODULE ════════════════════════ */
  let shRows = [];
  let shRenderedRows = [];    // filtered+sorted rows actually shown (index source for capture)
  let shActiveRow = null;
  let shPollTimer = null;

  async function loadShipment(){
    const delivery = bjComputeRole().isDelivery || bjIsShipAuditor();
    bjInjectViewFilter('sh', document.querySelector('#view-shipment .filterbar'),
      '🔍 Search invoice no or item code…', renderShipment, loadShipment);
    const head = $('shHead');
    head.innerHTML = '<th>#</th><th>Posting Date</th><th>Invoice No</th><th>Customer</th>'
      + '<th>Item Code</th><th>Item Name</th><th class="num">Qty</th>'
      + (delivery ? '<th>Action</th>' : '')
      + '<th>Capture Date &amp; Time</th>'
      + (delivery ? '<th>Reset</th>' : '')
      + '<th>Captured By</th><th>Photo</th>';
    setHTML('shipmentBody', '<tr><td colspan="12" class="empty">Loading…</td></tr>');
    try{
      const resp = await api('/api/store/retailer/shipment-list');
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      shRows = await resp.json();
      renderShipment();
    }catch(e){
      setHTML('shipmentBody', '<tr><td colspan="12" class="empty">Could not load: '+esc(e.message)+'</td></tr>');
    }
    /* store side: poll so the delivery photo appears live without manual refresh */
    if(!delivery){
      if(shPollTimer) clearInterval(shPollTimer);
      shPollTimer = setInterval(async ()=>{
        if($('view-shipment').classList.contains('hidden')){ clearInterval(shPollTimer); shPollTimer=null; return; }
        try{ const r=await api('/api/store/retailer/shipment-list'); if(r.ok){ shRows=await r.json(); renderShipment(); } }catch(e){}
      }, 5000);
    }
  }
  function renderShipment(){
    const delivery = bjComputeRole().isDelivery || bjIsShipAuditor();
    let rows = bjFilterRows(shRows||[], bjViewFilter.sh, 'PostingDate', ['InvoiceNo','ItemCode','ItemName','CustomerName']);
    rows = bjSortRows(rows, 'ship', bjTime('DeliveryAt'));
    shRenderedRows = rows;   // capture handler indexes into THIS (filtered+sorted)
    setText('shipmentCount', rows.length+' row'+(rows.length===1?'':'s'));
    $('shipmentEmpty').classList.toggle('hidden', rows.length>0);
    { const _e=$('shipmentBody'); if(_e) _e.innerHTML = rows.map((r,i)=>{
      const captured = Math.round(Number(r.CapturedQty)||0);
      const target   = Math.round(Number(r.Qty)||0);
      const completed = (target>0 && captured>=target);
      const action = delivery
        ? (completed ? '<span class="badge ok">✓ Done</span>'
                     : '<button class="btn cap sm" style="background:var(--brand);color:#fff;" onclick="retailerShipCapture('+i+')">📸 '
                        + (captured>0 ? ('Capture more ('+captured+'/'+target+')') : 'Ready to capture') + '</button>')
        : '';
      const resetCell = (captured>0)
        ? '<button class="btn sm" style="background:#64748b;color:#fff;" onclick="retailerDeliveryResetLine(\''+(r.ShipmentIds||'')+'\')">↺ Reset</button>'
        : '—';
      const photos = r.Photos ? r.Photos.split('|').filter(Boolean).map(p=>photoCell(p)).join(' ') : '—';
      return '<tr'+(completed?' class="row-verified"':'')+'>'
        + '<td>'+(i+1)+'</td>'
        + '<td>'+(r.PostingDate?new Date(r.PostingDate).toLocaleDateString():'—')+'</td>'
        + '<td><b>'+esc(r.InvoiceNo||'—')+'</b></td>'
        + '<td>'+esc(r.CustomerName||'—')+'</td>'
        + '<td><b>'+esc(r.ItemCode||'—')+'</b></td>'
        + '<td>'+esc(r.ItemName||'—')+'</td>'
        + '<td class="num big">'+captured+(target?(' / '+target):'')+'</td>'
        + (delivery ? '<td>'+action+'</td>' : '')
        + '<td>'+(r.DeliveryAt?fmtDateTime(r.DeliveryAt):'—')+'</td>'
        + (delivery ? '<td>'+resetCell+'</td>' : '')
        + '<td>'+esc(r.DeliveryBy||'—')+'</td>'
        + '<td style="white-space:nowrap;">'+photos+'</td>'
        + '</tr>';
    }).join(''); }
    bjWireSortHeader('shipmentBody', 'capture date', 'ship', renderShipment);
  }
  window.retailerDeliveryResetLine = async function(idsCsv){
    if(!confirm('Reset this delivery? All its captured boxes are removed.')) return;
    const ids = String(idsCsv||'').split(',').map(s=>parseInt(s,10)).filter(Boolean);
    try{ for(const id of ids){ const resp=await api('/api/store/retailer/shipment/'+id+'/reset',{method:'PUT'}); if(!resp.ok) throw new Error('HTTP '+resp.status); }
      toast('↺ Reset'); loadShipment();
    }catch(e){ toast('Reset failed: '+(e.message||e)); }
  };
  $('shSearch') && ($('shSearch').oninput = ()=>{ clearTimeout(window._shT); window._shT=setTimeout(renderShipment,200); });

  window.retailerShipCapture = function(idx){
    if(bjReadOnly()){ try{ toast('👁 Read-only login — you can view but not capture'); }catch(e){} return; }
    const row = (shRenderedRows||[])[idx] || shRows[idx]; if(!row) return;
    shActiveRow = row;
    const captured = Math.round(Number(row.CapturedQty)||0);
    const target   = Math.round(Number(row.Qty)||0);
    bjConfirmQty = Math.max(1, (target - captured) || 1);   // default box qty = remaining
    setText('shRowLabel', (row.ItemCode||'') + ' · ' + (row.ItemName||''));
    $('shScanCard').classList.remove('hidden');
    const nameOnly = bjIsNameOnly(row);
    setText('shCamHint', nameOnly
      ? ('No code needed for "'+(row.ItemName||'item')+'" — tap 📸 Capture (remaining '+Math.max(0,target-captured)+' of '+target+') · location stamped')
      : ('Scan item code '+row.ItemCode+' — remaining '+Math.max(0,target-captured)+' of '+target+' · location stamped'));
    startRetailerCamera('shVideo', nameOnly ? '' : row.ItemCode, async (scannedCode, photo, boxQty)=>{
      const stamped = await stampGps(photo);
      await submitShipment(row, scannedCode, stamped.image, stamped.gps, boxQty);
    });
    $('shScanCard').scrollIntoView({behavior:'smooth', block:'start'});
  };
  $('shCancel') && ($('shCancel').onclick = ()=>{ stopRetailerCamera(); $('shScanCard').classList.add('hidden'); shActiveRow=null; });
  $('shCapture') && ($('shCapture').onclick = ()=>{ retailerManualCapture(); });

  async function submitShipment(row, scannedCode, photo, gps, boxQty){
    try{
      const body = {
        pickoutId: row.PickoutId, itemCode: row.ItemCode, scannedCode: scannedCode,
        imageBase64: photo,
        qty: Math.max(1, Math.round(Number(boxQty)||1)),
        nameOnly: bjIsNameOnly(row),
        gpsLat: gps&&gps.lat, gpsLng: gps&&gps.lng, gpsAddress: gps&&gps.address
      };
      const resp = await api('/api/store/retailer/shipment', { method:'POST', body: JSON.stringify(body) });
      if(resp.status===409){ toast('❌ Code mismatch — scan the correct item ('+row.ItemCode+')'); return; }
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      await loadShipment();
      const fresh = (shRows||[]).find(x=>x.PickoutId===row.PickoutId);
      const cap = fresh?Math.round(Number(fresh.CapturedQty)||0):0;
      const tgt = Math.round(Number(row.Qty)||0);
      toast(tgt>0 && cap<tgt ? ('✓ Saved '+cap+'/'+tgt+' — capture the next box') : ('✓ Delivered '+cap+'/'+tgt));
      stopRetailerCamera();
      $('shScanCard').classList.add('hidden');
      shActiveRow=null;
    }catch(e){ toast('Save failed: '+e.message); }
  }


  /* ════════════════════════ ITEM AUDIT MODULE ════════════════════════ */
  let iaRows = [];
  async function loadItemAudit(){
    bjInjectAuditFilter('ia', loadItemAudit, '/api/store/retailer/item-audit-excel', 'Total Audit');
    setHTML('itemAuditBody', '<tr><td colspan="10" class="empty">Loading…</td></tr>');
    try{
      const resp = await api(bjBust('/api/store/retailer/item-audit'+bjFilterQS('ia')));
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      iaRows = await resp.json();
      renderItemAudit();
    }catch(e){
      setHTML('itemAuditBody', '<tr><td colspan="10" class="empty">Could not load: '+esc(e.message)+'</td></tr>');
    }
  }
  function renderItemAudit(){
    let rows = iaRows||[];
    const q = ($('iaSearch').value||'').trim().toLowerCase();
    if(q) rows = rows.filter(r=>(r.ItemName||'').toLowerCase().includes(q)||(r.ItemCode||'').toLowerCase().includes(q));
    if(bjSortState.iaPhys)      rows = bjSortRows(rows, 'iaPhys', bjTime('PhysicalAt'));
    else if(bjSortState.iaPick) rows = bjSortRows(rows, 'iaPick', bjTime('PickoutAt'));
    setText('itemAuditCount', rows.length+' item'+(rows.length===1?'':'s'));
    $('itemAuditEmpty').classList.toggle('hidden', rows.length>0);
    { const _e=$('itemAuditBody'); if(_e) _e.innerHTML = rows.map((r,i)=>{
      const sys = (r.SystemQty!=null?Math.round(r.SystemQty):null);
      const phy = Math.round(r.PhysicalQty||0);
      const po  = Math.round(r.PickoutQty||0);
      const total = phy - po;
      const st = (r.Status||'');
      const stBadge = st==='balanced' ? '<span class="badge ok">Balanced</span>'
        : st==='in stock' ? '<span class="badge ok">In stock</span>'
        : '<span class="badge bad">Pickout &gt; physical</span>';
      return '<tr>'
        + '<td>'+(i+1)+'</td>'
        + '<td><b>'+esc(r.ItemCode||'—')+'</b></td>'
        + '<td>'+esc(r.ItemName||'—')+'</td>'
        + '<td class="num big" style="color:var(--brand);">'+(sys!=null?sys:'—')+'</td>'
        + '<td class="'+qtyClass(phy,sys)+' big">'+phy+'</td>'
        + '<td>'+(r.PhysicalAt?fmtDateTime(r.PhysicalAt):'—')+'</td>'
        + '<td class="num big">'+po+'</td>'
        + '<td>'+(r.PickoutAt?fmtDateTime(r.PickoutAt):'—')+'</td>'
        + '<td class="num big"><b>'+total+'</b></td>'
        + '<td>'+stBadge+'</td>'
        + '</tr>';
    }).join(''); }
    bjWireItemAuditHeaders();
  }
  $('iaSearch') && ($('iaSearch').oninput = ()=>{ clearTimeout(window._iaT); window._iaT=setTimeout(renderItemAudit,200); });


  /* ════════════════════ SHARED CAMERA (per-row, code-matched) ════════════════════
     Reuses app.js's camera stream + grabFrame + codeOf + OCR engine, but runs a
     focused loop that only accepts a scan MATCHING the expected item code. */
  let bjStream=null, bjLoop=null, bjVideoId=null, bjExpected=null, bjOnMatch=null, bjBusy=false;
  let bjConfirmQty=null;   // when set (pickout), the confirm card shows a box-qty input defaulting to this
  let bjTorchOn=false, bjZoomVal=null, bjDigZoom=1;

  /* ── device-adaptive scanning (keeps weak phones from hanging) ──────────────
     Low-RAM / older phones (e.g. 4GB budget devices such as the Vivo Y28 5G)
     can't keep up with a heavy full-resolution OCR loop, so the main thread
     stalls and the UI "hangs" — and because frames stop being processed, reads
     also fail. We detect the device tier once and, on weaker hardware, scan a
     smaller frame at a slower cadence. OCR of an item code needs nowhere near
     full resolution, so this costs nothing in read quality on any phone. */
  let _bjLow=null;
  function bjIsLowEndDevice(){
    if(_bjLow!==null) return _bjLow;
    try{
      const mem  =(typeof navigator.deviceMemory==='number')       ? navigator.deviceMemory       : null; // GB (Chrome), capped at 8
      const cores=(typeof navigator.hardwareConcurrency==='number') ? navigator.hardwareConcurrency : null;
      _bjLow = ((mem!=null && mem<=4) || (cores!=null && cores<=4));
    }catch(e){ _bjLow=false; }
    return _bjLow;
  }
  function bjScanInterval(){ return bjIsLowEndDevice() ? 850 : 500; }   // ms between scan passes
  let _bjScanCv=null;   // ONE reused canvas for the scan loop → no per-frame allocation / GC churn
  /* grab a DOWNSCALED frame for OCR only. The saved photo is grabbed separately at
     full frame size (once, on a match), so proof-photo quality is unaffected. */
  function bjGrabScan(){
    const v=$(bjVideoId);
    if(!v || !v.videoWidth) return null;
    const maxW = bjIsLowEndDevice() ? 800 : 1000;
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth  * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const c = _bjScanCv || (_bjScanCv = document.createElement('canvas'));
    if(c.width!==w)  c.width  = w;
    if(c.height!==h) c.height = h;
    const ctx=c.getContext('2d');
    const z=bjDigZoom||1;
    if(z>1.01){
      const sw=v.videoWidth/z, sh=v.videoHeight/z;
      const sx=(v.videoWidth-sw)/2, sy=(v.videoHeight-sh)/2;
      ctx.drawImage(v, sx,sy,sw,sh, 0,0,w,h);
    } else {
      ctx.drawImage(v, 0,0,w,h);
    }
    return c;
  }

  async function startRetailerCamera(videoId, expectedCode, onMatch){
    bjVideoId = videoId; bjExpected = (expectedCode||'').toString().toUpperCase().replace(/\s+/g,'');
    bjOnMatch = onMatch; bjBusy=false;
    const v = $(videoId);
    try{
      if(bjStream) bjStream.getTracks().forEach(t=>t.stop());
      /* make sure app.js's Inward camera + scan loop are OFF first — two live
         back-camera streams starve each other (→ "could not read"). */
      try{ if(window.stopScan) window.stopScan(); }catch(e){}
      try{ const iv=$('video'); if(iv && iv.srcObject){ iv.srcObject.getTracks().forEach(t=>t.stop()); iv.srcObject=null; } }catch(e){}
      try{ const tb=document.getElementById('typeCodeBtn'); if(tb) tb.remove(); }catch(e){}
      /* Lighter capture than 1080p — 720p reads item codes just as well and is far
         easier on weak GPUs/decoders; low-end phones also drop to a lower frame rate. */
      const _low = bjIsLowEndDevice();
      bjStream = await navigator.mediaDevices.getUserMedia({
        video:{ facingMode:'environment',
                width:{ ideal: 1280 }, height:{ ideal: 720 },
                frameRate:{ ideal: _low ? 20 : 30 } }
      });
      v.srcObject = bjStream; await v.play();
      try{
        const tr=bjStream.getVideoTracks()[0]; const caps=tr.getCapabilities?tr.getCapabilities():{};
        if(caps.focusMode && caps.focusMode.includes('continuous')) await tr.applyConstraints({advanced:[{focusMode:'continuous'}]});
      }catch(e){}
      bjTorchOn=false; bjZoomVal=null; bjDigZoom=1; if(v){ v.style.transform=''; }
      injectBjControls();
      setBjFrame('scan');
      bjScanLoop();
    }catch(e){ toast('Camera blocked — allow camera permission'); }
  }
  function stopRetailerCamera(){
    if(typeof bjHideConfirm==='function') bjHideConfirm();
    if(bjLoop){ clearTimeout(bjLoop); bjLoop=null; }
    if(bjStream){ bjStream.getTracks().forEach(t=>t.stop()); bjStream=null; }
    const v = bjVideoId && $(bjVideoId); if(v) v.srcObject=null;
    if(_bjScanCv){ _bjScanCv.width=0; _bjScanCv.height=0; _bjScanCv=null; }   // free the scan buffer
  }
  /* grab a frame from the retailer video into a canvas → dataURL.
     When digital zoom is active, crop the centre so OCR + the saved photo match
     what the user sees on screen. */
  function bjGrab(){
    const v=$(bjVideoId);
    if(!v || !v.videoWidth) return null;
    const c=document.createElement('canvas');
    c.width=v.videoWidth; c.height=v.videoHeight;
    const ctx=c.getContext('2d');
    const z = bjDigZoom||1;
    if(z>1.01){
      const sw=v.videoWidth/z, sh=v.videoHeight/z;
      const sx=(v.videoWidth-sw)/2, sy=(v.videoHeight-sh)/2;
      ctx.drawImage(v, sx,sy,sw,sh, 0,0,c.width,c.height);
    } else {
      ctx.drawImage(v,0,0,c.width,c.height);
    }
    return c;
  }
  async function bjScanLoop(){
    if(bjBusy){ bjLoop=setTimeout(bjScanLoop, bjScanInterval()+150); return; }
    try{
      const canvas = bjGrabScan();            // downscaled + reused frame → light on weak phones
      if(canvas){
        const text = await bjOcr(canvas);
        const code = bjMatchExpected(text);   // flexible: finds the EXPECTED code in ANY label format
        if(code){
          bjBusy=true;                        // pause scanning while the card is up
          setBjFrame('green');
          const shot = bjGrab() || canvas;    // full frame just for the SAVED photo (once, on match)
          const photo = shot.toDataURL('image/jpeg',0.85);
          setBjHint('✓ Matched '+code+' — Save or retake?');
          bjShowConfirm(photo, code);         // card with Save / No (no auto-save)
          return;
        }else{
          const seen = window.codeOf ? window.codeOf(text||'') : null;
          if(seen){ setBjFrame('red'); setBjHint('Read '+seen+' — need '+bjExpected); }
          else { setBjFrame('scan'); }   // nothing read yet → neutral
        }
      }
    }catch(e){}
    bjLoop=setTimeout(bjScanLoop, bjScanInterval());
  }
  function setBjHint(t){
    const h = bjVideoId==='pkVideo' ? $('pkCamHint') : $('shCamHint');
    if(h) h.textContent=t;
  }

  /* ── capture confirm card ─────────────────────────────────────────────────
     On a match we DON'T auto-save. We freeze the photo and show a card:
       • Save → commit (bjOnMatch saves and closes the camera)
       • No   → discard and keep scanning the SAME invoice line */
  function bjHideConfirm(){ const e=document.getElementById('bjConfirmCard'); if(e) e.remove(); }
  function bjResumeScan(){
    bjHideConfirm();
    bjBusy=false;
    setBjFrame('scan');
    setBjHint('Scan the item code for this invoice line');
    if(bjLoop) clearTimeout(bjLoop);
    bjLoop = setTimeout(bjScanLoop, 300);
  }
  function bjShowConfirm(photo, code){
    bjHideConfirm();
    const wrap = bjWrap();
    const ov = document.createElement('div');
    ov.id = 'bjConfirmCard';
    ov.style.cssText = 'position:absolute;inset:0;z-index:25;background:rgba(15,23,42,0.93);'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:14px;';
    const img = document.createElement('img');
    img.src = photo;
    img.style.cssText = 'max-width:100%;max-height:58%;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
    ov.appendChild(img);
    const label = document.createElement('div');
    label.textContent = 'Save this photo for ' + (code||'') + '?';
    label.style.cssText = 'color:#fff;font-weight:700;font-size:16px;text-align:center;';
    let qtyInput = null;
    if(bjConfirmQty != null){
      const qwrap = document.createElement('div');
      qwrap.style.cssText='display:flex;align-items:center;gap:8px;color:#fff;font-weight:700;';
      qwrap.innerHTML = '<span>Qty in this box:</span>';
      qtyInput = document.createElement('input');
      qtyInput.type='number'; qtyInput.min='1'; qtyInput.value=String(bjConfirmQty);
      qtyInput.style.cssText='width:90px;padding:10px;border-radius:8px;border:none;font-size:18px;font-weight:800;text-align:center;';
      qwrap.appendChild(qtyInput);
      ov.appendChild(label); ov.appendChild(qwrap);
    } else {
      ov.appendChild(label);
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;';
    const yes = document.createElement('button');
    yes.textContent = '✓ Save';
    yes.style.cssText = 'background:#16a34a;color:#fff;border:none;border-radius:10px;padding:13px 26px;'
      + 'font-size:16px;font-weight:800;cursor:pointer;touch-action:manipulation;';
    const no = document.createElement('button');
    no.textContent = '✗ No, retake';
    no.style.cssText = 'background:#dc2626;color:#fff;border:none;border-radius:10px;padding:13px 26px;'
      + 'font-size:16px;font-weight:800;cursor:pointer;touch-action:manipulation;';
    yes.onclick = async ()=>{
      const q = qtyInput ? Math.max(1, parseInt(qtyInput.value,10)||1) : undefined;
      yes.disabled = true; no.disabled = true; yes.textContent = 'Saving…';
      bjHideConfirm();
      try{ if(bjOnMatch) await bjOnMatch(code, photo, q); }   // submitPickout/submitShipment save + close camera
      catch(e){ toast('Save failed: '+(e.message||e)); bjResumeScan(); }
    };
    no.onclick = ()=>{ bjResumeScan(); };   // stay on this invoice's camera
    row.appendChild(yes); row.appendChild(no);
    ov.appendChild(row);
    if(wrap){ if(getComputedStyle(wrap).position==='static') wrap.style.position='relative'; wrap.appendChild(ov); }
    else { document.body.appendChild(ov); }
  }


  /* ── flexible item-code matching ──────────────────────────────────────────
     We already know the EXPECTED code (the tapped invoice line), so we look for
     THAT code anywhere in the OCR text, in any label format:
       "ITEM CODE : 252080", "ITEM CODE :252080", "252080EE", "...252080..."
     Tolerant of common OCR confusions (O/0, I/L/1, S/5, B/8) and a letter suffix.
     Because it must equal the expected code, it never grabs wattage/MRP by mistake. */
  function bjNormDigits(s){
    return String(s||'').toUpperCase()
      .replace(/[OQ]/g,'0').replace(/[IL]/g,'1').replace(/S/g,'5').replace(/B/g,'8')
      .replace(/[^0-9]/g,'');
  }
  function bjCandidateCodes(text){
    const t = String(text||'').toUpperCase();
    const out = []; const re = /([0-9OQILSB]{4,12}[A-Z]{0,3})/g; let m;
    while((m = re.exec(t))){ out.push(m[1]); }
    return out;
  }
  function bjMatchExpected(text){
    const expD = bjNormDigits(bjExpected);
    if(!expD) return null;
    /* 1) label-anchored read (inward's codeOf), compared by digits */
    const c = window.codeOf ? window.codeOf(text||'') : null;
    if(c && bjNormDigits(c) === expD) return c;
    /* 2) scan every code-like token for the expected code (any format/position) */
    const cands = bjCandidateCodes(text);
    for(const cand of cands){ if(bjNormDigits(cand) === expD) return cand; }
    return null;
  }

  /* ── camera status light: green = matched, red = read-but-no-match ── */
  function bjWrap(){ const v=$(bjVideoId); return v ? v.parentElement : null; }
  function setBjFrame(state){
    const w = bjWrap(); if(!w) return;
    w.style.transition = 'box-shadow .15s ease';
    if(state==='green')    w.style.boxShadow = 'inset 0 0 0 5px #16a34a';
    else if(state==='red') w.style.boxShadow = 'inset 0 0 0 5px #dc2626';
    else                   w.style.boxShadow = 'inset 0 0 0 3px rgba(255,255,255,0.35)';
  }

  /* ── torch / zoom / refresh controls over the retailer camera (idempotent) ── */
  function bjCamBtn(label, title, css){
    const b=document.createElement('button');
    b.textContent=label; b.title=title; b.type='button';
    b.style.cssText='position:absolute;z-index:8;width:44px;height:44px;border:none;border-radius:50%;'
      +'background:rgba(255,255,255,0.92);color:#111;font-size:20px;font-weight:700;line-height:1;'
      +'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);touch-action:manipulation;'+css;
    return b;
  }
  function injectBjControls(){
    const w = bjWrap(); if(!w || w.dataset.bjCam) return;
    if(getComputedStyle(w).position === 'static') w.style.position = 'relative';
    w.dataset.bjCam='1';
    const torch   = bjCamBtn('🔦','Torch','top:12px;right:12px;');
    const refresh = bjCamBtn('🔄','Refresh camera','top:12px;right:64px;');
    const zin     = bjCamBtn('+','Zoom in','bottom:58px;right:12px;');
    const zout    = bjCamBtn('−','Zoom out','bottom:12px;right:12px;');
    torch.onclick   = (e)=>{ e.preventDefault(); bjToggleTorch(torch); };
    refresh.onclick = (e)=>{ e.preventDefault(); bjRefreshCam(); };
    zin.onclick     = (e)=>{ e.preventDefault(); bjZoomBy(+1); };
    zout.onclick    = (e)=>{ e.preventDefault(); bjZoomBy(-1); };
    w.appendChild(torch); w.appendChild(refresh); w.appendChild(zin); w.appendChild(zout);
  }
  async function bjToggleTorch(btn){
    const tr = bjStream && bjStream.getVideoTracks ? bjStream.getVideoTracks()[0] : null;
    const caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    if(!tr || !caps.torch){ toast('Torch not supported on this device'); return; }
    bjTorchOn = !bjTorchOn;
    try{
      await tr.applyConstraints({ advanced:[{ torch: bjTorchOn }] });
      if(btn) btn.style.background = bjTorchOn ? '#fde047' : 'rgba(255,255,255,0.92)';
    }catch(e){ toast('Torch failed'); }
  }
  async function bjZoomBy(dir){
    const tr = bjStream && bjStream.getVideoTracks ? bjStream.getVideoTracks()[0] : null;
    const caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    /* Prefer real optical/hardware zoom when the device exposes it… */
    if(tr && caps.zoom){
      const z = caps.zoom; const step = z.step || ((z.max - z.min)/10);
      if(bjZoomVal==null) bjZoomVal = (tr.getSettings && tr.getSettings().zoom) || z.min;
      bjZoomVal = Math.max(z.min, Math.min(z.max, bjZoomVal + dir*step));
      try{ await tr.applyConstraints({ advanced:[{ zoom: bjZoomVal }] }); }catch(e){}
      return;
    }
    /* …otherwise fall back to DIGITAL zoom: CSS-scale the video (and bjGrab crops
       the captured frame to match). Works on every device, incl. webcams. */
    const v=$(bjVideoId); if(!v) return;
    bjDigZoom = Math.max(1, Math.min(4, (bjDigZoom||1) + dir*0.25));
    v.style.transformOrigin='center center';
    v.style.transform = bjDigZoom>1.01 ? ('scale('+bjDigZoom+')') : '';
    const w=bjWrap(); if(w) w.style.overflow='hidden';
  }
  function bjRefreshCam(){
    const vid=bjVideoId, exp=bjExpected, on=bjOnMatch;
    stopRetailerCamera();
    startRetailerCamera(vid, exp, on);
    toast('🔄 Camera refreshed');
  }

  /* ── INWARD camera (app.js scanner): add the SAME +/- zoom buttons and a ✕ as
     Pickout/Shipment. Zoom drives app.js's own #zoomSlider, so it reuses app.js's
     working hardware/digital zoom + frame-crop. ✕ stops the stream and shows a
     Resume button. All guarded + idempotent so it never breaks the Inward flow. */
  function injectInwardControls(){
    const v = $('video'); if(!v) return;
    const wrap = v.parentElement; if(!wrap) return;
    if(wrap.dataset.bjInward) return;
    if(getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    wrap.dataset.bjInward = '1';
    const mk = (label,title,css)=>{
      const b=document.createElement('button'); b.textContent=label; b.title=title; b.type='button';
      b.style.cssText='position:absolute;z-index:8;width:44px;height:44px;border:none;border-radius:50%;'
        +'background:rgba(255,255,255,0.92);color:#111;font-size:20px;font-weight:700;line-height:1;'
        +'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);touch-action:manipulation;'+css;
      return b;
    };
    const zin  = mk('+','Zoom in','bottom:58px;right:12px;');
    const zout = mk('−','Zoom out','bottom:12px;right:12px;');
    const close= mk('✕','Close camera','top:12px;left:12px;');
    zin.onclick  =(e)=>{ e.preventDefault(); inwardZoom(+1); };
    zout.onclick =(e)=>{ e.preventDefault(); inwardZoom(-1); };
    close.onclick=(e)=>{ e.preventDefault(); inwardCloseCam(wrap); };
    wrap.appendChild(zin); wrap.appendChild(zout); wrap.appendChild(close);
  }
  function inwardZoom(dir){
    const s=$('zoomSlider');
    if(!s){ toast('Zoom not ready — point at a label first'); return; }
    const min=parseFloat(s.min)||1, max=parseFloat(s.max)||4, step=(parseFloat(s.step)||0.1);
    let val=parseFloat(s.value); if(isNaN(val)) val=min;
    val=Math.max(min, Math.min(max, val + dir*step*5));
    s.value=val;
    s.dispatchEvent(new Event('input', {bubbles:true}));   // run app.js's zoom handler
  }
  function inwardCloseCam(wrap){
    const v=$('video');
    if(v && v.srcObject){ try{ v.srcObject.getTracks().forEach(t=>t.stop()); }catch(e){} v.srcObject=null; }
    if(wrap.querySelector('.bjResumeCam')) return;
    const r=document.createElement('button'); r.className='bjResumeCam'; r.type='button';
    r.textContent='📷 Resume camera';
    r.style.cssText='position:absolute;z-index:9;left:50%;top:50%;transform:translate(-50%,-50%);'
      +'padding:12px 18px;border:none;border-radius:12px;background:var(--brand,#2563eb);color:#fff;'
      +'font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.5);';
    r.onclick=(e)=>{ e.preventDefault(); r.remove(); try{ if(typeof window.startCamera==='function') window.startCamera(); }catch(_){} };
    wrap.appendChild(r);
  }
  /* keep trying to decorate the Inward camera whenever it's visible (once),
     and hide app.js's small bottom zoom bar in favour of the prominent +/- here. */
  bjInjectFilterStyles();
  setInterval(()=>{ try{
    const v=$('video');
    if(v && v.offsetParent!==null){
      injectInwardControls();
      const zb=$('zoomBar'); if(zb) zb.classList.add('hidden');
      bjEnsureInwardModeBar();   // camera visible ⇒ Inward tab (window.view isn't reliable)
    }
  }catch(e){} }, 1200);

  /* OCR one canvas — reuse app.js ML Kit if present, else cloud via app.js helper */
  /* OCR read — mirrors the INWARD engine so Pickout/Shipment read just as well:
     try the raw frame first, and if no ITEM CODE is found, retry on the ENHANCED
     (sharpened + contrast-stretched) image — the same rescue Inward uses for
     glossy/blurry carton labels. Reads the ITEM CODE only; qty comes from the
     invoice line. The enhanced pass is demand-driven (only when the raw frame
     yields no code), so a clear label still costs a single OCR call. */
  /* Detect a GREEN-HIGHLIGHTER region and return a tight, upscaled crop of it
     (or null). Lets the auditor mark the ITEM CODE in green so we OCR just that
     area — ignoring MRP / voltage / model / dates — which is far more reliable,
     especially on codes printed straight onto brown carton. */
  function bjGreenCrop(srcCanvas){
    try{
      const w=srcCanvas.width, h=srcCanvas.height; if(!w||!h) return null;
      const sw=Math.min(480, w), sh=Math.max(1, Math.round(h*(sw/w)));
      const tmp=document.createElement('canvas'); tmp.width=sw; tmp.height=sh;
      const tctx=tmp.getContext('2d'); tctx.drawImage(srcCanvas,0,0,sw,sh);
      const img=tctx.getImageData(0,0,sw,sh).data;
      let minX=sw, minY=sh, maxX=0, maxY=0, count=0;
      for(let y=0;y<sh;y++){
        for(let x=0;x<sw;x++){
          const i=(y*sw+x)*4, r=img[i], g=img[i+1], b=img[i+2];
          /* bright, green-dominant pixel (highlighter ink) */
          if(g>90 && (g-r)>25 && (g-b)>25){
            count++;
            if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
          }
        }
      }
      const frac = count/(sw*sh);
      if(count<70 || frac<0.003 || frac>0.6) return null;   // no/too-little/too-much green
      const scale = w/sw;
      let bx=minX*scale, by=minY*scale, bw=(maxX-minX+1)*scale, bh=(maxY-minY+1)*scale;
      const padX=bw*0.16+12, padY=bh*0.45+12;               // codes are wide & short
      bx=Math.max(0,bx-padX); by=Math.max(0,by-padY);
      bw=Math.min(w-bx, bw+padX*2); bh=Math.min(h-by, bh+padY*2);
      if(bw<24||bh<12) return null;
      const up=Math.min(3, Math.max(1, 700/bw));            // upscale small crops for OCR
      const out=document.createElement('canvas');
      out.width=Math.round(bw*up); out.height=Math.round(bh*up);
      out.getContext('2d').drawImage(srcCanvas, bx,by,bw,bh, 0,0,out.width,out.height);
      return out;
    }catch(e){ return null; }
  }

  /* green-highlight FIRST (if present), else the full frame */
  async function bjOcr(canvas){
    const green = bjGreenCrop(canvas);
    if(green){
      const t = await bjOcrOne(green);
      if(t && window.codeOf && window.codeOf(t)) return t;   // got the code from the marked area
    }
    return await bjOcrOne(canvas);
  }

  async function bjOcrOne(canvas){
    const hasCode = (t)=> !!(t && window.codeOf && window.codeOf(t));
    let best = '';

    /* 1) ML Kit on-device (Capacitor / APK): raw, then enhanced.
       NOTE: window.mlkitPlugin() returns the PLUGIN object (or null) — it has no
       .avail flag, so the old `ml.avail` check was always false and Pickout fell
       back to cloud every time. Use the plugin directly, with a timeout so a
       wedged native call can't stall the scan loop. */
    try{
      const plugin = (typeof window.mlkitPlugin==='function' ? window.mlkitPlugin() : null)
        || (window.Capacitor && window.Capacitor.Plugins &&
            (window.Capacitor.Plugins.CapacitorPluginMlKitTextRecognition
             || window.Capacitor.Plugins.MlKitTextRecognition));
      if(plugin && plugin.detectText){
        const detect = (cv)=> Promise.race([
          plugin.detectText({ base64Image: cv.toDataURL('image/jpeg',0.85).split(',')[1] }),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('mlkit-timeout')), 2500))
        ]);
        const r = await detect(canvas);
        if(r && r.text!=null){ best = r.text; if(hasCode(best)) return best; }
        try{
          if(typeof enhanceForOcr==='function'){
            const enh = enhanceForOcr(canvas);
            if(enh){
              const re = await detect(enh);
              if(re && re.text!=null){ if(hasCode(re.text)) return re.text; if(!best) best = re.text; }
            }
          }
        }catch(e){}
      }
    }catch(e){}

    /* 2) Cloud OCR (browser / PWA): raw frame */
    try{
      if(window.cloudOcr){
        const r = await window.cloudOcr(canvas);
        if(r && r.text){ if(hasCode(r.text)) return r.text; if(!best) best = r.text; }
      }
    }catch(e){}

    /* 3) Cloud OCR rescue on the ENHANCED image (Inward's trick) */
    try{
      if(window.cloudOcr && typeof enhanceForOcr==='function'){
        const enh = enhanceForOcr(canvas);
        if(enh){
          const r2 = await window.cloudOcr(enh);
          if(r2 && r2.text){ if(hasCode(r2.text)) return r2.text; if(!best) best = r2.text; }
        }
      }
    }catch(e){}

    return best;
  }
  /* manual capture (Capture button): one-shot read. AUTO-READ ONLY — never asks
     the user to type. It succeeds ONLY if OCR reads a code AND that code matches
     this line's item code; otherwise it just shows a hint and does nothing.
     (The live bjScanLoop already auto-captures on a match, so this button is just
     a "try now" — point the camera at the label and it fires on its own.) */
  window.retailerManualCapture = async function(){
    if(bjReadOnly()){ try{ toast('👁 Read-only login — you can view but not capture'); }catch(e){} return; }
    if(!bjVideoId) return;
    if(bjBusy) return;                       // a confirm card is already up — don't stack
    const canvas = bjGrab(); if(!canvas){ toast('Camera not ready'); return; }
    /* name-only pickout line (no item code, e.g. "pipe") → capture directly, no match */
    if(!bjExpected){
      bjBusy=true; setBjFrame('green');
      const photo=canvas.toDataURL('image/jpeg',0.85);
      setBjHint('✓ Captured — Save or retake?');
      bjShowConfirm(photo, '');
      return;
    }
    const text = await bjOcr(canvas);
    /* flexible match: find the EXPECTED code anywhere in the label, any format */
    const code = bjMatchExpected(text);
    if(!code){
      const seen = window.codeOf ? window.codeOf(text||'') : null;
      if(seen){ setBjFrame('red'); toast('❌ Read '+seen+' — does not match '+bjExpected); }
      else { setBjHint('Could not read — keep the item code in view'); }   // in-camera hint only (no bottom toast)
      return;   // NO manual typing fallback (auto-read only)
    }
    bjBusy=true;
    setBjFrame('green');
    const photo=canvas.toDataURL('image/jpeg',0.85);
    setBjHint('✓ Matched '+code+' — Save or retake?');
    bjShowConfirm(photo, code);              // card with Save / No (no auto-save)
  };


  /* ════════════════════ GPS OVERLAY (burn lat/long/address onto photo) ════════════════════ */
  async function getGps(){
    return new Promise((resolve)=>{
      let done=false;
      const finish=(g)=>{ if(!done){ done=true; resolve(g); } };
      /* Capacitor Geolocation if available, else browser geolocation */
      try{
        if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation){
          window.Capacitor.Plugins.Geolocation.getCurrentPosition({enableHighAccuracy:true, timeout:8000})
            .then(p=>finish({lat:p.coords.latitude, lng:p.coords.longitude}))
            .catch(()=>finish(null));
          setTimeout(()=>finish(null), 9000);
          return;
        }
      }catch(e){}
      if(navigator.geolocation){
        navigator.geolocation.getCurrentPosition(
          p=>finish({lat:p.coords.latitude, lng:p.coords.longitude}),
          ()=>finish(null), {enableHighAccuracy:true, timeout:8000});
        setTimeout(()=>finish(null), 9000);
      }else finish(null);
    });
  }
  async function reverseGeocode(lat,lng){
    try{
      const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+lat+'&lon='+lng+'&zoom=18&addressdetails=1',
        { headers:{ 'Accept':'application/json' } });
      if(r.ok){ const j=await r.json(); return j.display_name || ''; }
    }catch(e){}
    return '';
  }
  /* draw the GPS panel (like GPS Map Camera) onto the bottom of the photo */
  async function stampGps(photoDataUrl){
    const gps = await getGps();
    let address = '';
    if(gps){ address = await reverseGeocode(gps.lat, gps.lng); if(gps) gps.address=address; }
    const img = new Image();
    await new Promise(res=>{ img.onload=res; img.src=photoDataUrl; });
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);

    /* overlay panel */
    const pad = Math.round(c.width*0.02);
    const lineH = Math.round(c.width*0.035);
    const fontBig = Math.round(c.width*0.040);
    const fontSm = Math.round(c.width*0.028);
    const lines = [];
    const now = new Date();
    const place = address ? address.split(',').slice(0,2).join(',') : (gps?('Lat '+gps.lat.toFixed(6)+'  Long '+gps.lng.toFixed(6)):'Location unavailable');
    lines.push({t: place, big:true});
    if(address) lines.push({t: address, big:false});
    if(gps) lines.push({t:'Lat '+gps.lat.toFixed(6)+'  Long '+gps.lng.toFixed(6), big:false});
    lines.push({t: now.toLocaleString(), big:false});

    const panelH = pad*2 + lines.reduce((h,l)=>h+(l.big?fontBig+6:lineH),0);
    ctx.fillStyle='rgba(0,0,0,0.55)';
    ctx.fillRect(0, c.height-panelH, c.width, panelH);
    let y = c.height - panelH + pad + fontBig;
    lines.forEach(l=>{
      ctx.fillStyle='#fff';
      ctx.font = (l.big?('bold '+fontBig):(''+fontSm))+'px Arial';
      /* wrap long address */
      const maxW = c.width - pad*2;
      let text = l.t;
      if(ctx.measureText(text).width > maxW){
        /* simple truncate with ellipsis per line */
        while(text.length>4 && ctx.measureText(text+'…').width>maxW) text=text.slice(0,-1);
        text += '…';
      }
      ctx.fillText(text, pad, y);
      y += (l.big?fontBig+6:lineH);
    });
    return { image: c.toDataURL('image/jpeg',0.9), gps: gps };
  }


  /* ───────────────────────── INIT ───────────────────────── */
  function retailerInit(){
    try{ applyRoleTabs(); }catch(e){ console.error('[retailer] applyRoleTabs failed:', e); }

    /* Re-wire ALL tabs through window.switchView (our wrapper). */
    try{
      const rewire = [
        ['tabIn','inward'],['tabOut','outward'],['tabTotal','total'],
        ['tabPickout','pickout'],['tabStoreAudit','storeaudit'],
        ['tabShipment','shipment'],['tabItemAudit','itemaudit']
      ];
      rewire.forEach(([id,view])=>{ const el=$(id); if(el) el.onclick=()=>{ try{ window.switchView(view); }catch(e){ console.error('[retailer] switchView '+view+' failed:', e); } }; });
    }catch(e){ console.error('[retailer] rewire failed:', e); }

    const R = bjComputeRole();

    /* Non-auditors don't use the inward camera — stop it. */
    if(!R.isAuditor){
      try{ if(window.stopScan) window.stopScan(); }catch(e){}
      try{
        const v=$('video');
        if(v && v.srcObject){ v.srcObject.getTracks().forEach(t=>t.stop()); v.srcObject=null; }
      }catch(e){}
    }

    /* Switch to the correct default module for this role. */
    const goDefault = ()=>{
      try{ applyRoleTabs(); }catch(e){}
      try{
        const def = window._retailerDefaultView || (R.isAuditor ? 'inward' : 'storeaudit');
        if(def !== 'inward'){ window.switchView(def); }
      }catch(e){ console.error('[retailer] goDefault switchView failed:', e); }
      try{ applyRoleTabs(); }catch(e){}
    };
    try{ goDefault(); }catch(e){ console.error('[retailer] goDefault failed:', e); }

    /* WATCHDOG: app.js runs its own async init (camera/db) and can re-touch the
       tab classNames AFTER we set them. Rather than guess the timing, we simply
       re-assert the correct tabs every 400ms for the first 6 seconds. This makes
       the tab visibility robust no matter what app.js does or when. */
    let ticks = 0;
    const watchdog = setInterval(()=>{
      try{ applyRoleTabs(); }catch(e){}
      ticks++;
      if(ticks >= 15) clearInterval(watchdog);   // ~6 seconds
    }, 400);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', retailerInit);
  else retailerInit();
  /* also run once more after full load (images/styles settled) */
  window.addEventListener('load', ()=>{ try{ bjComputeRole(); applyRoleTabs(); }catch(e){} });

})();
