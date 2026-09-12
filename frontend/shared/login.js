/* login.js */

const _pwInput  = document.getElementById('password');
const _pwBtn    = document.getElementById('togglePassword');
const _eyeIcon  = document.getElementById('eyeIcon');

const EYE_OPEN   = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const EYE_CLOSED = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';

if (_pwBtn && _pwInput && _eyeIcon) {
  _pwBtn.addEventListener('click', () => {
    const showing = _pwInput.type === 'password';
    _pwInput.type = showing ? 'text' : 'password';
    _pwBtn.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
    _eyeIcon.innerHTML = showing ? EYE_CLOSED : EYE_OPEN;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Offline-login bypass (v1.8 — 2026-06-03)
// (see history in repo; unchanged here)
// ════════════════════════════════════════════════════════════════════════════

const OFFLINE_CRED_KEY = 'nav_offline_cred';

async function hashCredential(password, username) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(username.toLowerCase()), iterations: 10000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function cacheOfflineCred(username, password, token, user) {
  try {
    const passHash = await hashCredential(password, username);
    localStorage.setItem(OFFLINE_CRED_KEY, JSON.stringify({
      username: username.toLowerCase(),
      passHash,
      token,
      user,
      cachedAt: Date.now(),
    }));
  } catch (e) {
    console.warn('[login] could not cache offline cred:', e.message);
  }
}

async function tryOfflineLogin(username, password) {
  const raw = localStorage.getItem(OFFLINE_CRED_KEY);
  if (!raw) return null;
  let cached;
  try { cached = JSON.parse(raw); } catch (_) { return null; }
  if (!cached || cached.username !== username.toLowerCase()) return null;
  const entered = await hashCredential(password, username);
  if (entered !== cached.passHash) return null;
  return cached;   // { username, passHash, token, user, cachedAt }
}

/* Decide where a role lands right after login. Retailer auditors, the delivery
   driver, and the store login all go straight to the Store module (they have
   no Sales access, so the company picker / sales dashboard would error). */
function landingForRole(role) {
  const r = (role || '').toLowerCase().trim();
  // HR, ANY FAE role, and the ENTIRE Product team (head + assistant) → Lens Home.
  // Matched by word (\bfae\b / \bproduct\b) so any current or future variant routes
  // here. Product + FAE have no Sales access and are locked to one company, so they
  // skip the company picker + Sales/AR dashboard. DC File stays reachable from the
  // sidebar / a home-page tile.
  if (r === 'hr' || r === 'hr head' || /\bfae\b/.test(r) || /\bproduct\b/.test(r)) {
    sessionStorage.setItem('nav_company', 'COMPANYA');
    return '/modules/hr/home.html';
  }
  if (r === 'warehouse') {
    sessionStorage.setItem('nav_company', 'COMPANYB');
    return '/modules/warehouse/home.html';
  }
  if (r === 'store electrical' || r === 'retailer auditor' || r === 'retailer delivery') {
    if (!sessionStorage.getItem('nav_company')) sessionStorage.setItem('nav_company', 'COMPANYA');
    return '/modules/store/home.html';
  }
  // sales / heads / admin / etc. → pick company first
  return './select-company.html';
}

document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const username   = document.getElementById('username').value.trim();
  const password   = document.getElementById('password').value.trim();
  const rememberMe = document.getElementById('rememberMe').checked;
  const loginBtn   = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');

  loginError.style.display = 'none';
  loginError.textContent   = '';
  loginBtn.disabled        = true;
  loginBtn.textContent     = 'Signing in...';

  try {
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      body: { username, password, rememberMe }
    });

    const storage = rememberMe ? localStorage : sessionStorage;

    clearAuth();
    storage.setItem('nav_token', data.token);
    storage.setItem('nav_user', JSON.stringify(data.user));
    localStorage.removeItem('nav_offline_session');  // back online — drop flag

    cacheOfflineCred(username, password, data.token, data.user);

    // Route by role (store/retailer/delivery → store home; HR/FAE → Lens;
    // warehouse → warehouse; everyone else → company picker).
    window.location.href = landingForRole(data.user.role);

  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const looksOffline = !navigator.onLine
      || msg.includes('failed to fetch')
      || msg.includes('networkerror')
      || msg.includes('load failed');

    if (looksOffline) {
      const cached = await tryOfflineLogin(username, password);
      if (cached) {
        clearAuth();
        localStorage.setItem('nav_token', cached.token);
        localStorage.setItem('nav_user',  JSON.stringify(cached.user));
        localStorage.setItem('nav_offline_session', '1');
        window.location.href = landingForRole(cached.user.role);
        return;
      }
      loginError.style.display = 'block';
      loginError.textContent   = 'Offline — and no cached credentials match this username/password. Please connect to network for first-time login.';
    } else {
      loginError.style.display = 'block';
      loginError.textContent   = err.message || 'Login failed';
    }
  } finally {
    loginBtn.disabled    = false;
    loginBtn.textContent = 'Sign in';
  }
});
