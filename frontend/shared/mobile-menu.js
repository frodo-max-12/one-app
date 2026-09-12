/* mobile-menu.js */
function initMobileMenu() {
  /* desktop — skip */
  if (window.innerWidth > 768) return;

  var aside = document.getElementById('sidebar');
  if (!aside) return;

  /* already initialized */
  if (document.getElementById('mmBtn')) return;

  /* hamburger button */
  var btn = document.createElement('button');
  btn.id = 'mmBtn';
  btn.innerHTML = '&#9776;';
  btn.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px',
    'z-index:999999', 'width:42px', 'height:42px',
    'font-size:22px', 'line-height:42px', 'text-align:center',
    'background:#13161e', 'color:#e8eaf2',
    'border:1px solid #353b52', 'border-radius:10px',
    'cursor:pointer', 'padding:0'
  ].join(';');
  document.body.appendChild(btn);

  /* overlay */
  var ov = document.createElement('div');
  ov.id = 'mmOv';
  ov.style.cssText = [
    'display:none', 'position:fixed',
    'top:0', 'left:0', 'width:100%', 'height:100%',
    'background:rgba(0,0,0,0.6)', 'z-index:99998'
  ].join(';');
  document.body.appendChild(ov);

  /* position sidebar off screen */
  aside.style.position   = 'fixed';
  aside.style.top        = '0';
  aside.style.left       = '-260px';
  aside.style.width      = '240px';
  aside.style.height     = '100vh';
  aside.style.zIndex     = '99999';
  aside.style.overflowY  = 'auto';
  aside.style.transition = 'left 0.25s ease';
  aside.style.background = '#13161e';
  aside.style.borderRight = '1px solid #2a2f40';

  /* make inner .sidebar div visible */
  var inner = aside.querySelector('.sidebar');
  if (inner) {
    inner.style.display        = 'flex';
    inner.style.flexDirection  = 'column';
    inner.style.width          = '240px';
    inner.style.minWidth       = '240px';
    inner.style.height         = '100%';
  }

  /* open */
  btn.onclick = function () {
    aside.style.left       = '0px';
    ov.style.display       = 'block';
    document.body.style.overflow = 'hidden';
  };

  /* close */
  function close() {
    aside.style.left       = '-260px';
    ov.style.display       = 'none';
    document.body.style.overflow = '';
  }

  ov.onclick = close;

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.nav-item') ||
        t.closest('.switch-company-btn') ||
        t.closest('.logout-btn')) {
      close();
    }
  });
}