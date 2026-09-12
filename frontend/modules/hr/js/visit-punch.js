// ============================================================================
// ONE App Lens — Visit Punch (v1.8)
//
// One-page flow:
//   1. (auto) Check for open punch on load → show Active Card OR In Form
//   2. Pick customer (NAV autocomplete via /api/sales/customers/suggest)
//   3. Capture selfie via shared camera modal (facingMode: 'user')
//   4. Capture premise photo via shared camera modal (facingMode: 'environment')
//   5. Tap PUNCH IN → grab GPS → POST /api/hr/visit-punch/in (multipart-ish:
//      base64 photos in JSON body, same pattern as attendance selfies)
//   6. Card flips to Active → running timer
//   7. Take exit premise photo → tap PUNCH OUT → POST /api/hr/visit-punch/out/:id
//   8. Card flips back to In Form for the next customer
//
// Offline:
//   • Failed POSTs (no network, 5xx) → enqueued in IndexedDB (`vpPunchQueue`)
//   • `online` event + page load + 30s timer all attempt to drain.
//   • UI shows queue count chip in the topbar.
//   • Photos kept as base64 in the queued payload — works because IndexedDB
//     handles strings of arbitrary length and survives reload.
// ============================================================================

(function () {
  const user = requireAuth();
  if (!user) return;

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    customer: null,        // { code, name, city, source }  source: 'plan' | 'search' | 'preset'
    photos: {
      'in-selfie':   null, // dataURI
      'in-premise':  null,
      'out-premise': null,
    },
    activeVisit: null,     // { VisitId, CustomerName, PunchInTime, PunchInSelfieUrl, PunchInPremisePhotoUrl, ... }
    visitPlanId: null,     // optional — set by chip tap or ?planId= query param
    capturing: {           // current camera modal session
      target: null,        // 'in-selfie' | 'in-premise' | 'out-premise'
      facingMode: 'environment',
      stream: null,
    },
    timerId: null,
    queueCount: 0,
    isOnline: navigator.onLine,
    selectedDate: todayISO(),   // YYYY-MM-DD — drives Planned chips + Visits list
    plannedRows: [],            // cached BN_VisitPlan rows for selectedDate
  };

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

  async function init() {
    if (typeof renderSidebar === 'function') renderSidebar('visit-punch');
    paintNet();

    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);

    // visitPlanId may arrive via ?planId= when launched from Visit Plan list
    const params = new URLSearchParams(location.search);
    const planId = parseInt(params.get('planId'));
    if (Number.isFinite(planId)) {
      state.visitPlanId = planId;
      // Pre-fill the customer from BN_VisitPlan if a row was passed
      const seedName = params.get('customer');
      const seedCode = params.get('code') || '';
      if (seedName) {
        state.customer = { code: seedCode, name: seedName, source: 'preset' };
        $('#vpCustomerInput').value = seedName;
        showCustomerConfirm();
      }
    }

    wireCustomerPicker();
    wireDatePicker();

    // Try to drain any queued items first — they might close the active visit.
    await drainQueue();
    await refreshOpenVisit();
    await refreshPlanned();
    await refreshToday();

    // Periodic drain + queue count refresh
    setInterval(() => { if (state.isOnline) drainQueue().catch(() => {}); }, 30000);
  }

  // ── Date picker ────────────────────────────────────────────────────────
  function wireDatePicker() {
    const inp = $('#vpDate');
    if (!inp) return;
    inp.value = state.selectedDate;
    paintDateHint();
    inp.addEventListener('change', () => {
      const v = inp.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      state.selectedDate = v;
      paintDateHint();
      refreshPlanned();
      refreshToday();
    });
  }
  window.vpJumpToToday = function () {
    state.selectedDate = todayISO();
    const inp = $('#vpDate');
    if (inp) inp.value = state.selectedDate;
    paintDateHint();
    refreshPlanned();
    refreshToday();
  };
  function paintDateHint() {
    const hint = $('#vpDateHint');
    const header = $('#vpTodayHeader');
    if (!hint || !header) return;
    const isToday = state.selectedDate === todayISO();
    if (isToday) {
      hint.textContent = '';
      hint.classList.remove('vp-date-readonly');
      header.textContent = 'Today';
    } else {
      const d = new Date(state.selectedDate);
      const past = d.getTime() < new Date(todayISO()).getTime();
      hint.textContent = past ? '📜 Read-only history — punching is for today only' : '⏭ Future date — punching is for today only';
      hint.classList.add('vp-date-readonly');
      header.textContent = 'Visits on ' + d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    }
    // Lock both Punch buttons when not on today
    $('#vpPunchInBtn').disabled = !isToday;
    if (!isToday) {
      $('#vpPunchInBtn').title = 'Punch only works for today — switch to today first.';
    } else {
      $('#vpPunchInBtn').title = '';
      updatePunchInBtn();   // re-evaluate based on customer + photos
    }
  }

  // ── shorthand ───────────────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }
  function show(sel) { const el = $(sel); if (el) el.hidden = false; }
  function hide(sel) { const el = $(sel); if (el) el.hidden = true; }
  function setText(sel, txt) { const el = $(sel); if (el) el.textContent = txt; }
  function toast(msg, kind) {
    const t = $('#vpToast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'vp-toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── Network status ──────────────────────────────────────────────────
  function paintNet() {
    const dot = $('#vpNetDot');
    const lbl = $('#vpNetLbl');
    if (state.isOnline) {
      dot.className = 'chip-dot online';
      lbl.textContent = 'Online';
    } else {
      dot.className = 'chip-dot offline';
      lbl.textContent = 'Offline';
    }
  }
  function onOnline()  { state.isOnline = true;  paintNet(); drainQueue().catch(() => {}); }
  function onOffline() { state.isOnline = false; paintNet(); }

  // ── localStorage cache for offline survival ─────────────────────────
  // /planned + /today don't change often, so we mirror the last successful
  // response per date. When the rep is offline (or signal drops mid-fetch),
  // the chips + visits list still render from cache instead of vanishing.
  //
  // CACHE_NS — bump whenever the API response shape changes so old client
  // caches get invalidated naturally (otherwise reps see stale schemas).
  // v2 (2026-06-04): added ContactPerson + ContactDetails to /planned + /today.
  const VP_CACHE_NS = 'vp_cache_v2_';
  function vpCacheGet(key) {
    try {
      const raw = localStorage.getItem(VP_CACHE_NS + key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  function vpCacheSet(key, value) {
    try { localStorage.setItem(VP_CACHE_NS + key, JSON.stringify(value)); } catch (_) {}
  }

  // ── Planned visits (quick-pick chips) ──────────────────────────────
  async function refreshPlanned() {
    const card = $('#vpPlannedCard');
    const list = $('#vpPlannedChips');
    if (!card || !list) return;

    const cacheKey = 'planned_' + state.selectedDate;
    let rows = null;
    let fromCache = false;
    try {
      const r = await apiRequest('/hr/visit-punch/planned?date=' + encodeURIComponent(state.selectedDate));
      rows = (r && r.planned) || [];
      vpCacheSet(cacheKey, rows);   // mirror fresh data for offline fallback
    } catch (e) {
      // Offline / server unreachable — fall back to last known cache for this date.
      const cached = vpCacheGet(cacheKey);
      if (cached) { rows = cached; fromCache = true; console.info('[visit-punch] planned: served from cache'); }
      else        { console.warn('[visit-punch] planned fetch failed + no cache:', e.message); }
    }

    if (rows == null) { card.hidden = true; return; }
    state.plannedRows = rows;
    $('#vpPlannedCount').textContent = rows.length;
    if (!rows.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    // Hint copy: actionable (today) / read-only (history) / offline-cached.
    const isToday = state.selectedDate === todayISO();
    $('#vpPlannedHint').textContent = fromCache
      ? '📡 Offline — showing last cached plan (will refresh when back online)'
      : (isToday
          ? 'Tap a customer to pre-fill — then take photos and punch in.'
          : 'History view — read-only.');
    list.innerHTML = rows.map(p => {
      const done = p.VisitDone === true || p.VisitDone === 1;
      const cls  = done ? 'vp-chip vp-chip-done' : 'vp-chip';
      const onclick = isToday && !done
        ? `onclick="vpPickFromPlan(${p.Id})"`
        : '';
      const badge = done ? '<span class="vp-chip-badge">✓ Done</span>' : '';
      return `
        <button type="button" class="${cls}" ${onclick} ${(!isToday || done) ? 'disabled' : ''} title="${esc(p.Location || p.CustomerName || '')}">
          <span class="vp-chip-name">${esc(p.CustomerName || '—')}</span>
          ${p.CustomerCode ? `<span class="vp-chip-code">${esc(p.CustomerCode)}</span>` : ''}
          ${badge}
        </button>
      `;
    }).join('');
  }

  // Chip click handler — pulls customer info from the cached planned rows
  // and pre-fills the form. Also sets state.visitPlanId so the backend
  // closes the corresponding BN_VisitPlan on Punch-In. Surfaces the planned
  // ContactPerson + ContactDetails so the rep sees who they're meeting (and
  // a head reviewing later can verify the visit was a real meeting).
  window.vpPickFromPlan = function (planId) {
    const row = state.plannedRows.find(p => Number(p.Id) === Number(planId));
    if (!row) return;
    state.visitPlanId = row.Id;
    state.customer = {
      code: row.CustomerCode || '',
      name: row.CustomerName || '',
      source: 'plan',
      contactPerson:  row.ContactPerson  || '',
      contactDetails: row.ContactDetails || '',
    };
    $('#vpCustomerInput').value = row.CustomerName || '';
    $('#vpCustomerList').hidden = true;
    showCustomerConfirm();
    updatePunchInBtn();
    // Visually mark the picked chip
    document.querySelectorAll('#vpPlannedChips .vp-chip').forEach(b => b.classList.remove('vp-chip-selected'));
    const btn = document.querySelector(`#vpPlannedChips button[onclick="vpPickFromPlan(${planId})"]`);
    if (btn) btn.classList.add('vp-chip-selected');
  };

  // ── Customer autocomplete (reuses /api/sales/customers/suggest) ─────
  function wireCustomerPicker() {
    const input = $('#vpCustomerInput');
    const list  = $('#vpCustomerList');
    let timer = null;
    let lastQ = '';

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q === lastQ) return;
      lastQ = q;
      clearTimeout(timer);
      if (q.length < 2) { list.hidden = true; list.innerHTML = ''; return; }
      timer = setTimeout(() => fetchSuggest(q).then(rows => paintSuggest(rows)), 240);
    });

    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 180));
    input.addEventListener('focus', () => {
      if (list.innerHTML.trim()) list.hidden = false;
    });
  }
  async function fetchSuggest(q) {
    try {
      // ?all=1 → bypass the salesperson-code scope so reps can punch at ANY
      // NAV customer, not just their own book. The backend accepts this only
      // on the /suggest endpoint (names + phones, no financials), so safe.
      const r = await apiRequest('/sales/customers/suggest?q=' + encodeURIComponent(q) + '&limit=20&all=1');
      return r && r.data ? r.data : [];
    } catch (e) {
      return [];
    }
  }
  function paintSuggest(rows) {
    const list = $('#vpCustomerList');
    if (!rows.length) {
      list.innerHTML = `<div class="vp-suggest-empty">No matches — type the exact prospect name to create a new customer geofence.</div>`;
      list.hidden = false;
      return;
    }
    list.innerHTML = rows.map(r => `
      <div class="vp-suggest-row" onclick="vpPickCustomer('${escAttr(r.CustomerCode || '')}','${escAttr(r.Name || '')}','${escAttr(r.City || '')}')">
        <div class="vp-suggest-name">${esc(r.Name || '—')}</div>
        <div class="vp-suggest-meta">${esc(r.CustomerCode || '')}${r.City ? ' · ' + esc(r.City) : ''}</div>
      </div>
    `).join('');
    list.hidden = false;
  }
  window.vpPickCustomer = function (code, name, city) {
    // Free-text pick from the NAV search dropdown — clears any previously
    // linked plan id since this is an ad-hoc/escape selection.
    state.customer = { code, name, city, source: 'search' };
    state.visitPlanId = null;
    $('#vpCustomerInput').value = name;
    $('#vpCustomerList').hidden = true;
    document.querySelectorAll('#vpPlannedChips .vp-chip').forEach(b => b.classList.remove('vp-chip-selected'));
    showCustomerConfirm();
    updatePunchInBtn();
  };
  window.vpClearCustomer = function () {
    state.customer = null;
    state.visitPlanId = null;
    $('#vpCustomerInput').value = '';
    hide('#vpCustomerConfirm');
    document.querySelectorAll('#vpPlannedChips .vp-chip').forEach(b => b.classList.remove('vp-chip-selected'));
    updatePunchInBtn();
  };
  function showCustomerConfirm() {
    setText('#vpCustomerName', state.customer.name);
    // Visible badge so the rep sees whether they picked from the planned list
    // (auto-linked to BN_VisitPlan) or did an ad-hoc free-text search.
    const src = (state.customer && state.customer.source) || 'search';
    const badge = $('#vpConfirmSource');
    if (badge) {
      if (src === 'plan')   badge.textContent = '(from today\'s plan)';
      else if (src === 'preset') badge.textContent = '(from Visit Plan link)';
      else                  badge.textContent = '(ad-hoc / not planned)';
    }
    // Planned ContactPerson + Phone — shown only when the chip carries them
    // (i.e., the plan row had them filled when the rep created the visit).
    const cp = state.customer.contactPerson;
    const cd = state.customer.contactDetails;
    const contactBox = $('#vpConfirmContact');
    if (contactBox) {
      if (cp || cd) {
        contactBox.hidden = false;
        setText('#vpConfirmContactName', cp || '—');
        const phoneEl = $('#vpConfirmContactPhone');
        if (phoneEl) {
          if (cd) {
            phoneEl.hidden = false;
            phoneEl.textContent = '📞 ' + cd;
            // tel: link works on mobile + desktop with calling apps installed
            const digitsOnly = String(cd).replace(/[^0-9+]/g, '');
            phoneEl.href = digitsOnly ? ('tel:' + digitsOnly) : '#';
          } else {
            phoneEl.hidden = true;
          }
        }
      } else {
        contactBox.hidden = true;
      }
    }
    show('#vpCustomerConfirm');
  }

  // ── Capacitor detection (native APK vs browser) ─────────────────────
  function isCapacitor() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  // Native Camera path — launches the system camera, returns a base64 data
  // URL. Falls back to the web modal if the plugin call throws (permission
  // denied, user cancelled, plugin missing on older APK build).
  async function capCapture(target, facingMode) {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
    if (!plugin) throw new Error('Capacitor Camera plugin not available');
    const result = await plugin.getPhoto({
      quality: 78,
      allowEditing: false,
      resultType: 'dataUrl',        // returns 'data:image/jpeg;base64,...'
      source: 'CAMERA',             // direct camera, no gallery picker
      saveToGallery: false,
      width: 1280,
      height: 1280,
      direction: (facingMode === 'user') ? 'FRONT' : 'REAR',
      promptLabelHeader: target === 'in-selfie' ? 'Selfie' : 'Premise Photo',
      promptLabelPhoto:  'From Camera',
      promptLabelPicture: 'From Camera',
      correctOrientation: true,
    });
    if (!result || !result.dataUrl) throw new Error('Camera returned no image');
    return result.dataUrl;
  }

  // ── Camera entry point — branches Capacitor vs web ──────────────────
  window.vpStartCapture = async function (target, facingMode) {
    state.capturing.target = target;
    state.capturing.facingMode = facingMode || 'environment';

    // Native Capacitor — system camera, far better UX than getUserMedia in webview.
    if (isCapacitor()) {
      try {
        const dataUri = await capCapture(target, state.capturing.facingMode);
        state.photos[target] = dataUri;
        paintPhoto(target, dataUri);
        updatePunchInBtn();
        updatePunchOutBtn();
        return;
      } catch (e) {
        // User cancelled? Plugin returns a thrown error with msg "User cancelled photos app"
        // or similar. Don't toast that. Surface only real errors.
        const m = (e && e.message || '').toLowerCase();
        if (m.includes('cancel')) return;
        // Fall through to web modal as a graceful fallback.
        console.warn('[visit-punch] native camera failed, falling back to web modal:', e.message);
      }
    }

    // Web path — open the in-page modal with getUserMedia.
    $('#vpCamLabel').textContent = target === 'in-selfie' ? 'Smile! Centre your face in frame.' : 'Frame the customer signage / entrance.';
    $('#vpCamSpinner').textContent = 'Starting camera…';
    $('#vpCamSpinner').hidden = false;
    $('#vpCamShoot').disabled = true;
    $('#vpCamModal').hidden = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#vpCamSpinner').textContent = 'This browser does not support camera capture. Try Chrome / Edge / a phone.';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.capturing.facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      // Sanity-check that we actually got video tracks (an empty stream gives
      // a black video and silent UI failures).
      const tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
      if (!tracks.length) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Camera returned no video stream (is another app using it?)');
      }
      state.capturing.stream = stream;
      const v = $('#vpCamVideo');
      v.srcObject = stream;
      try { await v.play(); } catch (e) { console.warn('[visit-punch] video.play() failed:', e.message); }
      // Wait for the first real frame before enabling the shoot button so a tap
      // can't fire while videoWidth is still 0.
      const enableShoot = () => {
        $('#vpCamSpinner').hidden = true;
        $('#vpCamShoot').disabled = false;
      };
      if (v.readyState >= 2 && v.videoWidth > 0) {
        enableShoot();
      } else {
        const onReady = () => { v.removeEventListener('loadeddata', onReady); enableShoot(); };
        v.addEventListener('loadeddata', onReady);
        // Belt-and-braces: if loadeddata never fires (some Android webviews),
        // poll videoWidth and enable as soon as it's non-zero.
        let waited = 0;
        const poll = setInterval(() => {
          waited += 250;
          if (v.videoWidth > 0) { clearInterval(poll); enableShoot(); }
          else if (waited >= 5000) { clearInterval(poll); /* give up; user can Cancel */ }
        }, 250);
      }
    } catch (err) {
      // Make the error LOUD — don't rely on a fading toast. Replace the
      // spinner text with a persistent message and let the user tap Cancel.
      const msg = (err && (err.message || err.name)) || 'Unknown error';
      const friendly = msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied')
        ? 'Camera permission denied. Allow access in your browser address bar, then try again.'
        : msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('notreadable') || msg.toLowerCase().includes('device')
        ? 'No camera available (or another app is using it). Close other apps that use the camera, then try again.'
        : 'Camera failed to start: ' + msg;
      $('#vpCamSpinner').textContent = friendly;
      $('#vpCamSpinner').hidden = false;
      toast(friendly, 'error');
      // Modal stays open with a clear message + Cancel button works.
    }
  };

  // Escape closes the camera modal as a safety net in case Cancel is hard to
  // find (some Android dimensions push the button off-screen).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#vpCamModal').hidden) {
      closeCameraModal();
    }
  });
  window.vpDoCapture = function () {
    const v = $('#vpCamVideo');
    if (!v.videoWidth) return;
    const c = $('#vpCanvas');
    // Cap output at 1280px on the long side → keeps photos ~200-800 KB.
    const maxDim = 1280;
    const ratio  = v.videoWidth / v.videoHeight;
    let w, h;
    if (ratio >= 1) { w = Math.min(v.videoWidth, maxDim); h = Math.round(w / ratio); }
    else            { h = Math.min(v.videoHeight, maxDim); w = Math.round(h * ratio); }
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    const dataUri = c.toDataURL('image/jpeg', 0.78);
    state.photos[state.capturing.target] = dataUri;
    paintPhoto(state.capturing.target, dataUri);
    closeCameraModal();
    updatePunchInBtn();
    updatePunchOutBtn();
  };
  window.vpCancelCapture = closeCameraModal;
  window.vpFlipCamera = async function () {
    state.capturing.facingMode = (state.capturing.facingMode === 'environment') ? 'user' : 'environment';
    if (state.capturing.stream) state.capturing.stream.getTracks().forEach(t => t.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.capturing.facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      state.capturing.stream = stream;
      $('#vpCamVideo').srcObject = stream;
    } catch (err) {
      toast('Flip failed: ' + err.message, 'error');
    }
  };
  function closeCameraModal() {
    if (state.capturing.stream) {
      state.capturing.stream.getTracks().forEach(t => t.stop());
      state.capturing.stream = null;
    }
    $('#vpCamModal').hidden = true;
  }
  function paintPhoto(target, dataUri) {
    const slotMap = {
      'in-selfie':   { slot: '#vpInSelfieSlot',   img: '#vpInSelfiePreview' },
      'in-premise':  { slot: '#vpInPremiseSlot',  img: '#vpInPremisePreview' },
      'out-premise': { slot: '#vpOutPremiseSlot', img: '#vpOutPremisePreview' },
    };
    const m = slotMap[target];
    if (!m) return;
    $(m.img).src = dataUri;
    $(m.img).hidden = false;
    $(m.slot).classList.add('has-photo');
  }

  // ── Button enablement ──────────────────────────────────────────────
  function updatePunchInBtn() {
    const ready =
      state.customer &&
      state.photos['in-selfie'] &&
      state.photos['in-premise'];
    $('#vpPunchInBtn').disabled = !ready;
  }
  function updatePunchOutBtn() {
    $('#vpPunchOutBtn').disabled = !state.photos['out-premise'];
  }

  // ── GPS ────────────────────────────────────────────────────────────
  function getGPS(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(
        pos => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
        err => reject(new Error('GPS: ' + err.message)),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
      );
    });
  }

  // ── PUNCH IN ───────────────────────────────────────────────────────
  window.vpPunchIn = async function () {
    const btn = $('#vpPunchInBtn');
    btn.disabled = true;
    hide('#vpInError');
    btn.textContent = '⏳ Locating…';
    let gps;
    try {
      gps = await getGPS();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '▶ PUNCH IN';
      showInErr('Could not get GPS: ' + e.message);
      return;
    }
    btn.textContent = '⏳ Punching In…';
    const payload = {
      customerCode: state.customer.code || null,
      customerName: state.customer.name,
      lat: gps.lat,
      lng: gps.lng,
      accuracy: gps.accuracy,
      selfieData: state.photos['in-selfie'],
      premisePhotoData: state.photos['in-premise'],
      visitPlanId: state.visitPlanId || null,
    };
    try {
      const r = await postWithQueue('/hr/visit-punch/in', payload, 'in');
      const accStr = gps && gps.accuracy ? ' · 📍 ±' + Math.round(gps.accuracy) + 'm' : '';
      if (r === 'queued') {
        toast('No signal — queued' + accStr + '. Will sync when online.', 'success');
        btn.textContent = '⏳ Queued — sync pending';
        // Move on as if it succeeded — reset form and rely on later drain to show active card.
        resetInForm();
        updateQueueChip();
        return;
      }
      if (r && r.ok) {
        toast('Punched in ✓' + accStr, 'success');
        await refreshOpenVisit();
        await refreshPlanned();
        await refreshToday();
      } else {
        showInErr((r && r.message) || 'Punch-In failed.');
      }
    } catch (e) {
      showInErr('Punch-In failed: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ PUNCH IN';
    }
  };
  function showInErr(msg) {
    const el = $('#vpInError'); el.textContent = msg; el.hidden = false;
  }

  // ── PUNCH OUT ──────────────────────────────────────────────────────
  window.vpPunchOut = async function () {
    if (!state.activeVisit) return;
    const btn = $('#vpPunchOutBtn');
    btn.disabled = true;
    hide('#vpOutError');
    btn.textContent = '⏳ Locating…';
    let gps;
    try {
      gps = await getGPS();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '✓ PUNCH OUT';
      showOutErr('Could not get GPS: ' + e.message);
      return;
    }
    btn.textContent = '⏳ Punching Out…';
    const payload = {
      lat: gps.lat,
      lng: gps.lng,
      accuracy: gps.accuracy,
      premisePhotoData: state.photos['out-premise'],
    };
    try {
      const r = await postWithQueue('/hr/visit-punch/out/' + state.activeVisit.VisitId, payload, 'out');
      const accStr = gps && gps.accuracy ? ' · 📍 ±' + Math.round(gps.accuracy) + 'm' : '';
      if (r === 'queued') {
        toast('No signal — punch-out queued' + accStr + '.', 'success');
        btn.textContent = '⏳ Queued';
        updateQueueChip();
        return;
      }
      if (r && r.ok) {
        toast('Punched out ✓' + accStr, 'success');
        state.activeVisit = null;
        // The visit cycle is complete — clear the plan link + customer so the
        // NEXT punch starts blank. Without this, a beat rep doing 15-25 punches
        // a day would carry the previous outlet's plan into the next punch-in
        // (resetInForm preserves state when visitPlanId is still set).
        state.visitPlanId = null;
        state.customer = null;
        stopTimer();
        state.photos['out-premise'] = null;
        hide('#vpActiveCard');
        show('#vpInForm');
        resetInForm();
        await refreshPlanned();
        await refreshToday();
      } else {
        showOutErr((r && r.message) || 'Punch-Out failed.');
      }
    } catch (e) {
      showOutErr('Punch-Out failed: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ PUNCH OUT';
    }
  };
  function showOutErr(msg) {
    const el = $('#vpOutError'); el.textContent = msg; el.hidden = false;
  }

  // ── Active visit display ───────────────────────────────────────────
  async function refreshOpenVisit() {
    try {
      const r = await apiRequest('/hr/visit-punch/open');
      const open = r && r.open;
      if (open) {
        state.activeVisit = open;
        $('#vpActiveCustomer').textContent = open.CustomerName || 'Customer';
        $('#vpActiveSince').textContent = 'Since ' + fmtTime(open.PunchInTime);
        if (open.PunchInSelfieUrl)        $('#vpActiveSelfie').src = open.PunchInSelfieUrl;
        if (open.PunchInPremisePhotoUrl)  $('#vpActivePremise').src = open.PunchInPremisePhotoUrl;
        // Meeting contact — from BN_VisitPlan via the LEFT JOIN on /open.
        // Stays visible the whole time the rep is on-site so they can recall
        // who they're meeting + tap-to-call from inside the active card.
        const cp = open.ContactPerson;
        const cd = open.ContactDetails;
        const contactBox = $('#vpActiveContact');
        if (contactBox) {
          if (cp || cd) {
            contactBox.hidden = false;
            setText('#vpActiveContactName', cp || '—');
            const phoneEl = $('#vpActiveContactPhone');
            if (phoneEl) {
              if (cd) {
                phoneEl.hidden = false;
                phoneEl.textContent = '📞 ' + cd;
                const digitsOnly = String(cd).replace(/[^0-9+]/g, '');
                phoneEl.href = digitsOnly ? ('tel:' + digitsOnly) : '#';
              } else {
                phoneEl.hidden = true;
              }
            }
          } else {
            contactBox.hidden = true;
          }
        }
        // GPS pill — clickable link that opens the Punch-In coords in Google
        // Maps (same pattern as attendance Sign-In/Sign-Out events). Hidden
        // when lat/lng missing (e.g., offline-queued items that lacked GPS).
        const gpsPill = $('#vpActiveGps');
        if (gpsPill) {
          const hasGps = open.PunchInLat != null && open.PunchInLng != null;
          gpsPill.hidden = !hasGps;
          if (hasGps) {
            const lat = Number(open.PunchInLat).toFixed(6);
            const lng = Number(open.PunchInLng).toFixed(6);
            gpsPill.href  = 'https://www.google.com/maps?q=' + lat + ',' + lng;
            gpsPill.title = 'Open ' + lat + ', ' + lng + ' in Google Maps';
          }
        }
        show('#vpActiveCard');
        hide('#vpInForm');
        startTimer(new Date(open.PunchInTime));
        // Reset out photo for the new punch-out session
        state.photos['out-premise'] = null;
        $('#vpOutPremisePreview').hidden = true;
        $('#vpOutPremiseSlot').classList.remove('has-photo');
        updatePunchOutBtn();
      } else {
        state.activeVisit = null;
        stopTimer();
        hide('#vpActiveCard');
        show('#vpInForm');
      }
    } catch (e) {
      // Silent — likely offline. UI keeps last state.
    }
  }
  function startTimer(since) {
    stopTimer();
    state.timerId = setInterval(() => {
      const elapsed = Math.max(0, (Date.now() - since.getTime()) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
      const hh = Math.floor(elapsed / 3600);
      $('#vpActiveTimer').textContent = hh > 0
        ? `${hh}:${mm}:${ss}`
        : `${mm}:${ss}`;
    }, 1000);
  }
  function stopTimer() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    setText('#vpActiveTimer', '00:00');
  }

  // ── Today's list ──────────────────────────────────────────────────
  async function refreshToday() {
    const list = $('#vpTodayList');
    if (!list) return;
    const cacheKey = 'today_' + state.selectedDate;
    let rows = null;
    let fromCache = false;
    try {
      const r = await apiRequest('/hr/visit-punch/today?date=' + encodeURIComponent(state.selectedDate));
      rows = (r && r.visits) || [];
      vpCacheSet(cacheKey, rows);
    } catch (e) {
      const cached = vpCacheGet(cacheKey);
      if (cached) { rows = cached; fromCache = true; }
      else        { return; /* no data + no cache → just leave the existing render */ }
    }
    try {
      $('#vpTodayCount').textContent = rows.length;
      if (!rows.length) {
        list.innerHTML = `<div class="vp-empty">${fromCache ? '📡 Offline — no cached visits on this date.' : 'No visits punched yet today.'}</div>`;
        return;
      }
      // Admin/head monitor view: the list spans multiple employees, so show whose
      // punch each row is. For a rep looking at their own list, EmployeeName == self
      // → skip the redundant name line.
      const meName = (typeof getUser === 'function' && getUser() && getUser().name) || '';
      list.innerHTML = rows.map(v => {
        const empLine = (v.EmployeeName && v.EmployeeName !== meName)
          ? `<div class="vp-today-emp" style="font-weight:600;color:var(--brand,#6d28d9);margin-bottom:2px;">🧑 ${esc(v.EmployeeName)}${v.EmployeeRole ? ' · ' + esc(v.EmployeeRole) : ''}</div>`
          : '';
        const open = !!v.PunchInTime && !v.PunchOutTime;
        const done = !!v.PunchOutTime;
        const cls  = open ? 'open' : (done ? 'done' : '');
        const status = open
          ? 'OPEN — punch out to close'
          : (done
              ? `Done · ${v.DurationMin != null ? v.DurationMin + ' min' : ''}`
              : 'Auto-detected (no punch)');
        const tin  = v.PunchInTime  ? fmtTime(v.PunchInTime)  : '—';
        const tout = v.PunchOutTime ? fmtTime(v.PunchOutTime) : '—';
        // 📍 In / Out chips — each is a clickable Google Maps link to that
        // specific punch's coords. Same pattern as attendance event map links.
        const gpsIn  = v.PunchInLat  != null && v.PunchInLng  != null;
        const gpsOut = v.PunchOutLat != null && v.PunchOutLng != null;
        let gpsChip = '';
        if (gpsIn) {
          const lat = Number(v.PunchInLat).toFixed(6);
          const lng = Number(v.PunchInLng).toFixed(6);
          gpsChip += ` <a class="vp-today-gps" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="Open Punch-In location (${lat}, ${lng}) in Google Maps">📍 In</a>`;
        }
        if (gpsOut) {
          const lat = Number(v.PunchOutLat).toFixed(6);
          const lng = Number(v.PunchOutLng).toFixed(6);
          gpsChip += ` <a class="vp-today-gps" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="Open Punch-Out location (${lat}, ${lng}) in Google Maps">📍 Out</a>`;
        }
        // Meeting-with line — surfaces the planned contact joined from
        // BN_VisitPlan. Helps the rep recall who they met + lets a head spot
        // visits with no recorded contact (legacy rows pre-mandatory rule).
        let contactRow = '';
        if (v.ContactPerson || v.ContactDetails) {
          const cpEsc = v.ContactPerson ? esc(v.ContactPerson) : '—';
          const cdEsc = v.ContactDetails ? esc(v.ContactDetails) : '';
          const phoneDigits = cdEsc ? cdEsc.replace(/[^0-9+]/g, '') : '';
          const phoneHtml = cdEsc
            ? ` · <a class="vp-today-phone" href="tel:${phoneDigits}">📞 ${cdEsc}</a>`
            : '';
          contactRow = `<div class="vp-today-contact">👤 ${cpEsc}${phoneHtml}</div>`;
        }
        return `
          <div class="vp-today-row ${cls}">
            ${empLine}
            <div class="vp-today-customer">${esc(v.CustomerName || '—')}${gpsChip}</div>
            <div class="vp-today-time">${tin}${v.PunchOutTime ? ' → ' + tout : ''}</div>
            <div class="vp-today-status ${cls}">${status}</div>
            ${contactRow}
          </div>
        `;
      }).join('');
    } catch (e) { /* silent */ }
  }

  // ══════════════════════════════════════════════════════════════════
  // IndexedDB punch queue — offline-tolerant POST wrapper
  // ══════════════════════════════════════════════════════════════════
  const DB_NAME = 'oneapp-vp-queue';
  const DB_VER  = 1;
  const STORE   = 'punches';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function dbAdd(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(item).onsuccess = (e) => resolve(e.target.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbList() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id).onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dbCount() {
    const items = await dbList();
    return items.length;
  }

  // POST with offline-queue fallback.
  // Returns:
  //   - the parsed response when the request succeeds
  //   - the literal string 'queued' if the request couldn't go through and the
  //     payload was stored in IndexedDB
  //   - throws on server-side 4xx (validation errors) so the UI can surface them
  async function postWithQueue(path, payload, kind) {
    if (state.isOnline) {
      try {
        return await apiRequest(path, { method: 'POST', body: payload });
      } catch (e) {
        // apiRequest throws on !res.ok. We only queue on NETWORK errors, not
        // on server-side validation (4xx). Heuristic: if it's a TypeError /
        // "Failed to fetch" then it's a network problem and we queue. For
        // explicit HTTP errors, re-throw.
        const msg = (e.message || '').toLowerCase();
        const isNetwork = msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed');
        if (!isNetwork) throw e;
      }
    }
    // Offline OR network error → enqueue
    await dbAdd({ path, payload, kind, createdAt: Date.now(), attempts: 0 });
    return 'queued';
  }

  // Queue drainer. Uses raw fetch (NOT apiRequest) so we can detect 401 and
  // surface a re-login banner instead of letting apiRequest auto-redirect to
  // the login page and lose the queued items.
  async function drainOne(item) {
    const token = getToken();
    const company = sessionStorage.getItem('nav_company') || 'COMPANYA';
    const url = '/api' + item.path + (item.path.includes('?') ? '&' : '?') + 'company=' + encodeURIComponent(company);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Company':    company,
        ...(token ? { 'Authorization': token } : {}),
      },
      body: JSON.stringify(item.payload),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, ok: res.ok, data };
  }

  async function drainQueue() {
    let items;
    try { items = await dbList(); } catch (e) { return; }
    let drained = 0;
    let authBlocked = false;
    for (const item of items) {
      if (!state.isOnline) break;
      try {
        const r = await drainOne(item);
        if (r.ok && r.data && r.data.ok) {
          await dbDelete(item.id);
          drained++;
        } else if (r.status === 401 || r.status === 403) {
          // Auth expired. Keep items in the queue — DO NOT drop. Show banner.
          authBlocked = true;
          break;
        } else if (r.status >= 400 && r.status < 500) {
          // Other 4xx (validation, 409 already open) → drop to avoid a loop.
          // Photos are lost but a loop would be worse.
          console.warn('[visit-punch] dropping queued item, server rejected:', r.status, (r.data && r.data.message) || '');
          await dbDelete(item.id);
        } else {
          // 5xx → try again next tick; stop draining for now.
          break;
        }
      } catch (e) {
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
          // Still offline — stop draining; try again later.
          state.isOnline = false;
          paintNet();
          break;
        }
        // Unknown error — stop draining; don't drop the item.
        console.error('[visit-punch] drain unknown error, will retry:', e.message);
        break;
      }
    }
    state.queueCount = await dbCount();
    updateQueueChip();
    paintAuthBanner(authBlocked, state.queueCount);
    if (drained > 0) {
      toast(drained + ' queued punch' + (drained > 1 ? 'es' : '') + ' synced ✓', 'success');
      await refreshOpenVisit();
      await refreshToday();
    }
  }

  // Persistent banner shown when the queue can't drain because the cached
  // JWT is rejected (401/403). Clicking the banner sends the rep to the
  // login page; once they re-authenticate online, the queue drains on the
  // next page load (init() always calls drainQueue first).
  function paintAuthBanner(blocked, queueCount) {
    let banner = document.getElementById('vpAuthBanner');
    if (!blocked || queueCount === 0) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'vpAuthBanner';
      banner.className = 'vp-auth-banner';
      banner.innerHTML = `
        <div>
          <strong>${queueCount} queued punch${queueCount > 1 ? 'es' : ''} need re-login.</strong>
          Your session expired while offline. Sign in once and the queue will sync automatically.
        </div>
        <button type="button" onclick="window.location.href='/index.html'">Re-login</button>
      `;
      const shell = document.querySelector('.vp-shell');
      if (shell) shell.insertBefore(banner, shell.firstChild);
    } else {
      // Update the count if the banner already exists
      const strong = banner.querySelector('strong');
      if (strong) strong.textContent = `${queueCount} queued punch${queueCount > 1 ? 'es' : ''} need re-login.`;
    }
  }
  async function updateQueueChip() {
    try {
      const n = await dbCount();
      state.queueCount = n;
      const chip = $('#vpQueueChip');
      if (n > 0) {
        chip.hidden = false;
        $('#vpQueueCount').textContent = n;
      } else {
        chip.hidden = true;
      }
    } catch (_) {}
  }

  // ── Reset In form for the next visit ──────────────────────────────
  function resetInForm() {
    // Keep customer cleared too — different visit, different customer
    if (!state.visitPlanId) state.customer = null;
    state.photos['in-selfie']  = null;
    state.photos['in-premise'] = null;
    if (!state.visitPlanId) {
      $('#vpCustomerInput').value = '';
      hide('#vpCustomerConfirm');
    }
    $('#vpInSelfiePreview').hidden = true;
    $('#vpInPremisePreview').hidden = true;
    $('#vpInSelfieSlot').classList.remove('has-photo');
    $('#vpInPremiseSlot').classList.remove('has-photo');
    hide('#vpInError');
    updatePunchInBtn();
  }

  // ── helpers ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '\\"');
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
})();
