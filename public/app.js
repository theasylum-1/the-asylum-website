// ─────────────────────────────────────────
// THE ASYLUM — app.js
// Handles all backend connections
// ─────────────────────────────────────────

const API = '';  // same origin — Vercel serves both

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let currentUser = null;
let currentSession = null;

// ─────────────────────────────────────────
// INIT — runs when page loads
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  checkSession();
  loadBreaks();
});

// ─────────────────────────────────────────
// SESSION CHECK
// ─────────────────────────────────────────
function checkSession() {
  const session = localStorage.getItem('asylum_session');
  const user = localStorage.getItem('asylum_user');
  if (session && user) {
    currentSession = JSON.parse(session);
    currentUser = JSON.parse(user);
    updateNavForLoggedInUser();
  }
}

function updateNavForLoggedInUser() {
  const signupBtn = document.querySelector('.nav-btn');
  if (signupBtn && currentUser) {
    signupBtn.textContent = currentUser.user_metadata?.full_name?.split(' ')[0] || 'Account';
    signupBtn.onclick = function () { showPage('account'); };
  }
}

// ─────────────────────────────────────────
// AUTH — SIGN UP
// ─────────────────────────────────────────
async function submitSignup() {
  const name = document.querySelector('#modal-signup-content input[type="text"]').value.trim();
  const email = document.querySelector('#modal-signup-content input[type="email"]').value.trim();
  const password = document.querySelectorAll('#modal-signup-content input[type="password"]')[0].value;
  const confirm = document.querySelectorAll('#modal-signup-content input[type="password"]')[1].value;
  const smsChecked = document.getElementById('sms-optin-signup').checked;
  const phone = document.getElementById('phone-input-signup').value.trim();

  if (!name || !email || !password) { showToast('Please fill in all fields.', 'error'); return; }
  if (password !== confirm) { showToast('Passwords do not match.', 'error'); return; }
  if (password.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
  if (smsChecked && !phone) { showToast('Please enter your phone number to join the text list.', 'error'); return; }

  showToast('Creating your account...', 'info');

  try {
    const res = await fetch(API + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, full_name: name, phone, sms_optin: smsChecked })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Signup failed.', 'error'); return; }

    showToast('Account created! Please check your email to confirm.', 'success');
    document.getElementById('modal-overlay').classList.remove('open');

    if (smsChecked && phone) {
      await fetch(API + '/api/sms-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name, source: 'signup' })
      });
      showToast('Coupon code ASYLUM10 is on its way to your phone!', 'success');
    }
  } catch (err) {
    showToast('Something went wrong. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────
// AUTH — SIGN IN
// ─────────────────────────────────────────
async function submitSignin() {
  const email = document.querySelector('#modal-login-content input[type="email"]').value.trim();
  const password = document.querySelector('#modal-login-content input[type="password"]').value;

  if (!email || !password) { showToast('Please enter your email and password.', 'error'); return; }

  showToast('Signing in...', 'info');

  try {
    const res = await fetch(API + '/api/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Sign in failed.', 'error'); return; }

    currentUser = data.user;
    currentSession = data.session;
    localStorage.setItem('asylum_session', JSON.stringify(data.session));
    localStorage.setItem('asylum_user', JSON.stringify(data.user));

    document.getElementById('modal-overlay').classList.remove('open');
    updateNavForLoggedInUser();
    showToast('Welcome back ' + (data.user.user_metadata?.full_name?.split(' ')[0] || '') + '!', 'success');
    showPage('account');
  } catch (err) {
    showToast('Something went wrong. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────
// AUTH — SIGN OUT
// ─────────────────────────────────────────
function signOut() {
  currentUser = null;
  currentSession = null;
  localStorage.removeItem('asylum_session');
  localStorage.removeItem('asylum_user');
  const signupBtn = document.querySelector('.nav-btn');
  if (signupBtn) {
    signupBtn.textContent = 'Sign Up';
    signupBtn.onclick = function () { openModal('signup'); };
  }
  showPage('home');
  showToast('You have been signed out.', 'info');
}

// ─────────────────────────────────────────
// ACCOUNT PAGE
// ─────────────────────────────────────────
function renderAccountPage() {
  const page = document.getElementById('page-account');
  if (!page) return;

  if (!currentUser) {
    page.innerHTML = `
      <div class="page-header"><div class="page-header-text"><h1>MY ACCOUNT</h1><div class="red-bar"></div></div></div>
      <div style="text-align:center;padding:4rem 2rem;">
        <p style="color:var(--muted);margin-bottom:1.5rem;">You need to be signed in to view your account.</p>
        <button class="btn-primary" onclick="openModal('login')">Sign In</button>
      </div>`;
    return;
  }

  const name = currentUser.user_metadata?.full_name || 'Member';
  const email = currentUser.email;

  page.innerHTML = `
    <div class="page-header"><div class="page-header-text"><h1>MY ACCOUNT</h1><p>Welcome back, ${name.split(' ')[0]}</p><div class="red-bar"></div></div></div>
    <div style="max-width:800px;margin:2rem auto;padding:0 2rem;">
      <div style="background:var(--card);border:1px solid var(--border);padding:1.5rem;margin-bottom:1.5rem;">
        <div class="section-label">Account Info</div>
        <p style="font-size:15px;margin-bottom:0.5rem;"><strong style="color:var(--muted);font-family:'Barlow Condensed',sans-serif;letter-spacing:2px;font-size:12px;text-transform:uppercase;">Name</strong><br>${name}</p>
        <p style="font-size:15px;margin-top:1rem;"><strong style="color:var(--muted);font-family:'Barlow Condensed',sans-serif;letter-spacing:2px;font-size:12px;text-transform:uppercase;">Email</strong><br>${email}</p>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);padding:1.5rem;margin-bottom:1.5rem;">
        <div class="section-label">My PSA Submissions</div>
        <div id="account-psa-list"><p style="color:var(--muted);font-size:14px;">Loading submissions...</p></div>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);padding:1.5rem;margin-bottom:1.5rem;">
        <div class="section-label">My Orders</div>
        <div id="account-orders-list"><p style="color:var(--muted);font-size:14px;">Loading orders...</p></div>
      </div>
      <button class="btn-outline" onclick="signOut()" style="width:100%;padding:12px;">Sign Out</button>
    </div>`;

  loadAccountPSA();
}

async function loadAccountPSA() {
  if (!currentUser) return;
  try {
    const res = await fetch(API + '/api/psa/' + currentUser.id, {
      headers: { 'Authorization': 'Bearer ' + currentSession?.access_token }
    });
    const data = await res.json();
    const el = document.getElementById('account-psa-list');
    if (!el) return;
    if (!data.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:14px;">No submissions yet. Contact us to get started.</p>';
      return;
    }
    let html = '<table class="submissions-table"><thead><tr><th>Card</th><th>Submitted</th><th>Sub ID</th><th>Status</th><th>Grade</th></tr></thead><tbody>';
    data.forEach(function (s) {
      html += '<tr><td>' + s.card_name + '</td><td>' + (s.submitted_date || '—') + '</td><td>#' + s.submission_ref + '</td>';
      html += '<td><span class="status-badge ' + s.status + '">' + s.status + '</span></td>';
      html += '<td>' + (s.grade || '—') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (err) {
    document.getElementById('account-psa-list').innerHTML = '<p style="color:var(--muted);font-size:14px;">Could not load submissions.</p>';
  }
}

// ─────────────────────────────────────────
// PSA TRACKER — public lookup
// ─────────────────────────────────────────
async function lookupPSA() {
  const input = document.querySelector('.psa-lookup .input-row input').value.trim();
  if (!input) { showToast('Please enter your email or submission ID.', 'error'); return; }

  showToast('Looking up your submission...', 'info');

  try {
    const res = await fetch(API + '/api/psa/lookup?q=' + encodeURIComponent(input));
    const data = await res.json();

    const tableWrap = document.querySelector('.psa-section');
    const existingTable = tableWrap.querySelector('.submissions-table');
    const existingLabel = tableWrap.querySelector('.section-label');
    if (existingTable) existingTable.parentElement.removeChild(existingTable);
    if (existingLabel) existingLabel.parentElement.removeChild(existingLabel);

    if (!data.length) {
      showToast('No submissions found for that email or ID.', 'error');
      return;
    }

    let html = '<div class="section-label">Your Submissions</div><table class="submissions-table"><thead><tr><th>Card</th><th>Submitted</th><th>Sub ID</th><th>Status</th><th>Grade</th></tr></thead><tbody>';
    data.forEach(function (s) {
      html += '<tr><td>' + s.card_name + '</td><td>' + (s.submitted_date || '—') + '</td><td>#' + s.submission_ref + '</td>';
      html += '<td><span class="status-badge ' + s.status + '">' + s.status + '</span></td>';
      html += '<td>' + (s.grade || '—') + '</td></tr>';
    });
    html += '</tbody></table>';
    tableWrap.insertAdjacentHTML('beforeend', html);
    showToast('Submissions loaded!', 'success');
  } catch (err) {
    showToast('Lookup failed. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────
// BREAKS — load from Supabase
// ─────────────────────────────────────────
let liveBreaks = { hsa: [], ab: [] };

async function loadBreaks() {
  try {
    const [hsaRes, abRes] = await Promise.all([
      fetch(API + '/api/breaks?brand=hsa'),
      fetch(API + '/api/breaks?brand=ab')
    ]);
    const hsaData = await hsaRes.json();
    const abData = await abRes.json();

    liveBreaks.hsa = hsaData.map(function (b) {
      return { name: b.name, date: b.break_date, price: '$' + b.price, spots: b.total_spots, filled: b.filled_spots, id: b.id };
    });
    liveBreaks.ab = abData.map(function (b) {
      return { name: b.name, date: b.break_date, price: '$' + b.price, spots: b.total_spots, filled: b.filled_spots, id: b.id };
    });

    // Override the hardcoded breaks with live data
    if (typeof breaks !== 'undefined') {
      breaks.hsa = liveBreaks.hsa;
      breaks.ab = liveBreaks.ab;
    }

    if (document.getElementById('page-breaks').classList.contains('active')) {
      renderBreaks();
    }
  } catch (err) {
    console.log('Could not load live breaks, using defaults.');
  }
}

// ─────────────────────────────────────────
// BREAKS — admin add (password protected)
// ─────────────────────────────────────────
async function addBreak() {
  const name = document.getElementById('new-break-name').value.trim();
  const date = document.getElementById('new-break-date').value.trim();
  const price = document.getElementById('new-break-price').value.trim();
  const spots = parseInt(document.getElementById('new-break-spots').value) || 0;
  const brand = document.getElementById('new-break-brand').value;
  const adminKey = document.getElementById('admin-key-input') ? document.getElementById('admin-key-input').value.trim() : '';

  if (!name || !date || !price || !spots) { showToast('Please fill in all fields.', 'error'); return; }
  if (!adminKey) { showToast('Admin key required.', 'error'); return; }

  try {
    const res = await fetch(API + '/api/breaks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand, name, break_date: date,
        price: parseFloat(price.replace('$', '')),
        total_spots: spots, admin_key: adminKey
      })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to add break.', 'error'); return; }

    showToast('Break added!', 'success');
    await loadBreaks();
    renderBreaks();
    document.getElementById('new-break-name').value = '';
    document.getElementById('new-break-date').value = '';
    document.getElementById('new-break-price').value = '';
    document.getElementById('new-break-spots').value = '';
    document.getElementById('admin-panel').classList.remove('open');
  } catch (err) {
    showToast('Failed to add break. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────
// CONTACT FORM
// ─────────────────────────────────────────
async function submitContact() {
  const subject = document.getElementById('contact-subject').value;
  const name = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const message = document.getElementById('contact-message').value.trim();

  if (!subject) { showToast('Please select a topic.', 'error'); return; }
  if (!name || !email || !message) { showToast('Please fill in all fields.', 'error'); return; }

  showToast('Sending your message...', 'info');

  try {
    const res = await fetch(API + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, subject, message })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to send.', 'error'); return; }

    // Also send via mailto as backup
    const mailtoSubject = encodeURIComponent('[The Asylum] ' + subject + ' — from ' + name);
    const mailtoBody = encodeURIComponent('Topic: ' + subject + '\nName: ' + name + '\nEmail: ' + email + '\n\n' + message);
    window.location.href = 'mailto:theasylumbranding@gmail.com?subject=' + mailtoSubject + '&body=' + mailtoBody;

    document.getElementById('contact-success').classList.add('show');
  } catch (err) {
    showToast('Something went wrong. Please try again.', 'error');
  }
}

function resetContact() {
  document.getElementById('contact-success').classList.remove('show');
  ['contact-subject', 'contact-name', 'contact-email', 'contact-message'].forEach(function (id) {
    document.getElementById(id).value = '';
  });
}

// ─────────────────────────────────────────
// SMS SIGNUP
// ─────────────────────────────────────────
async function submitSmsSignup(context) {
  var name = '', phone = '';
  if (context === 'standalone') {
    name = document.getElementById('sms-name').value.trim();
    phone = document.getElementById('sms-phone').value.trim();
  } else {
    phone = document.getElementById('phone-input-' + context).value.trim();
  }
  if (!phone) { showToast('Please enter your phone number.', 'error'); return; }

  try {
    await fetch(API + '/api/sms-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name, source: context })
    });
  } catch (err) {
    console.log('SMS subscribe error:', err);
  }

  if (context === 'standalone') {
    document.getElementById('sms-standalone-form').style.display = 'none';
    document.getElementById('sms-success-standalone').classList.add('show');
  } else {
    document.getElementById('sms-success-' + context).classList.add('show');
  }
}

// ─────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────
function showToast(message, type) {
  type = type || 'info';
  var existing = document.getElementById('asylum-toast');
  if (existing) existing.remove();

  var colors = { success: '#2d4a2d', error: '#4a1a1a', info: '#1a1a2a' };
  var borders = { success: '#4caf50', error: '#e74c3c', info: '#5b9cf6' };

  var toast = document.createElement('div');
  toast.id = 'asylum-toast';
  toast.style.cssText = 'position:fixed;bottom:2rem;right:2rem;background:' + colors[type] + ';border:1px solid ' + borders[type] + ';color:#fff;padding:1rem 1.5rem;font-family:"Barlow Condensed",sans-serif;font-size:14px;letter-spacing:1px;z-index:9999;max-width:320px;line-height:1.4;';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function () { if (toast.parentElement) toast.remove(); }, 4000);
}

// ─────────────────────────────────────────
// OVERRIDE showPage to handle account page
// ─────────────────────────────────────────
var _originalShowPage = window.showPage;
window.showPage = function (id) {
  if (_originalShowPage) _originalShowPage(id);
  if (id === 'account') renderAccountPage();
  if (id === 'breaks') loadBreaks();
};
