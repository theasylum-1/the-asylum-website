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
  const inputEl = document.getElementById('psa-lookup-input') || document.querySelector('.psa-lookup .input-row input');
  const input = inputEl ? inputEl.value.trim() : '';
  if (!input) { showToast('Please enter your email or submission ID.', 'error'); return; }

  showToast('Looking up your submission...', 'info');

  try {
    const res = await fetch(API + '/api/psa/lookup?q=' + encodeURIComponent(input));
    const data = await res.json();

    const resultsEl = document.getElementById('psa-results');

    if (!data.length) {
      if (resultsEl) resultsEl.innerHTML = '<p style="color:var(--muted);font-size:14px;padding:1rem 0;">No submissions found for that ID. Please check and try again.</p>';
      showToast('No submissions found.', 'error');
      return;
    }

    let html = '<div class="section-label" style="margin-top:1.5rem;">Your Submissions</div><table class="submissions-table"><thead><tr><th>Card</th><th>Submitted</th><th>Sub ID</th><th>Status</th><th>Grade</th></tr></thead><tbody>';
    data.forEach(function (s) {
      html += '<tr><td>' + s.card_name + '</td><td>' + (s.submitted_date || '—') + '</td><td>#' + s.submission_ref + '</td>';
      html += '<td><span class="status-badge ' + s.status + '">' + s.status + '</span></td>';
      html += '<td>' + (s.grade || '—') + '</td></tr>';
    });
    html += '</tbody></table>';
    if (resultsEl) resultsEl.innerHTML = html;
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
      return { name: b.name, date: b.break_date, price: '$' + b.price, spots: b.total_spots, filled: b.filled_spots, id: b.id, break_type: b.break_type || 'standard', sport: b.sport || '' };
    });
    liveBreaks.ab = abData.map(function (b) {
      return { name: b.name, date: b.break_date, price: '$' + b.price, spots: b.total_spots, filled: b.filled_spots, id: b.id, break_type: b.break_type || 'standard', sport: b.sport || '' };
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

// ─────────────────────────────────────────
// MANUAL PAYMENT MODALS (Venmo/CashApp/Zelle)
// ─────────────────────────────────────────
function openPayModal(type) {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById(type + '-modal').classList.add('open');
}

function closePayModal(type) {
  document.getElementById(type + '-modal').classList.remove('open');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(function() {
    showToast('Copied to clipboard!', 'success');
  }).catch(function() {
    showToast('Copy failed — please copy manually.', 'error');
  });
}

// ─────────────────────────────────────────
// STRIPE PAYMENT
// ─────────────────────────────────────────
async function initiateStripePayment() {
  var amount = window.currentOrderAmount || 0;
  var itemName = window.currentOrderItem || 'The Asylum Order';

  if (!amount) {
    showToast('No amount set for this order.', 'error');
    return;
  }

  showToast('Loading secure payment...', 'info');

  try {
    const res = await fetch(API + '/api/stripe/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, item_name: itemName, order_type: 'shop' })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Payment setup failed.', 'error'); return; }

    // Load Stripe.js and show payment form
    if (!window.Stripe) {
      var script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.onload = function() { showStripeForm(data.clientSecret, data.publishableKey, amount, itemName); };
      document.head.appendChild(script);
    } else {
      showStripeForm(data.clientSecret, data.publishableKey, amount, itemName);
    }
  } catch (err) {
    showToast('Payment setup failed. Please try again.', 'error');
  }
}

function showStripeForm(clientSecret, publishableKey, amount, itemName) {
  var existing = document.getElementById('stripe-payment-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'stripe-payment-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:400;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = '<div style="background:#111;border:1px solid #2a2a2a;border-top:2px solid #e74c3c;padding:2.5rem;width:100%;max-width:440px;position:relative;">' +
    '<button onclick="document.getElementById(\'stripe-payment-overlay\').remove()" style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:#888;font-size:24px;cursor:pointer;">&#215;</button>' +
    '<h2 style="font-family:\'Bebas Neue\',sans-serif;font-size:32px;letter-spacing:3px;color:#e8e0d8;margin-bottom:0.25rem;">Secure Payment</h2>' +
    '<p style="font-size:13px;color:#888;margin-bottom:1.5rem;font-family:\'Barlow Condensed\',sans-serif;letter-spacing:2px;text-transform:uppercase;">' + itemName + ' — $' + amount + '</p>' +
    '<div id="stripe-card-element" style="background:#1f1f1f;border:1px solid #2a2a2a;padding:14px;margin-bottom:1rem;"></div>' +
    '<div id="stripe-error" style="color:#e74c3c;font-size:13px;margin-bottom:1rem;"></div>' +
    '<button id="stripe-submit-btn" onclick="confirmStripePayment(\'' + clientSecret + '\')" style="width:100%;background:#c0392b;color:#fff;border:none;padding:14px;font-family:\'Barlow Condensed\',sans-serif;font-size:14px;font-weight:700;letter-spacing:3px;text-transform:uppercase;cursor:pointer;">Pay $' + amount + '</button>' +
    '</div>';
  document.body.appendChild(overlay);

  var stripe = window.Stripe(publishableKey);
  var elements = stripe.elements();
  var card = elements.create('card', {
    style: { base: { color: '#e8e0d8', fontFamily: 'Barlow, sans-serif', fontSize: '15px', '::placeholder': { color: '#555' } }, invalid: { color: '#e74c3c' } }
  });
  card.mount('#stripe-card-element');
  window._stripeCard = card;
  window._stripe = stripe;
}

async function confirmStripePayment(clientSecret) {
  var btn = document.getElementById('stripe-submit-btn');
  btn.textContent = 'Processing...';
  btn.disabled = true;

  var result = await window._stripe.confirmCardPayment(clientSecret, {
    payment_method: { card: window._stripeCard }
  });

  if (result.error) {
    document.getElementById('stripe-error').textContent = result.error.message;
    btn.textContent = 'Try Again';
    btn.disabled = false;
  } else {
    document.getElementById('stripe-payment-overlay').remove();
    document.getElementById('modal-overlay').classList.remove('open');
    showToast('Payment successful! Thank you!', 'success');
  }
}

// ─────────────────────────────────────────
// PAYPAL PAYMENT
// ─────────────────────────────────────────
async function initiatePayPalPayment() {
  var amount = window.currentOrderAmount || 0;
  var itemName = window.currentOrderItem || 'The Asylum Order';

  if (!amount) { showToast('No amount set for this order.', 'error'); return; }

  showToast('Setting up PayPal...', 'info');

  try {
    const res = await fetch(API + '/api/paypal/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, item_name: itemName })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'PayPal setup failed.', 'error'); return; }

    // Redirect to PayPal
    window.open('https://www.paypal.com/checkoutnow?token=' + data.orderID, '_blank');
    showToast('PayPal opened in a new tab. Complete your payment there.', 'info');
  } catch (err) {
    showToast('PayPal setup failed. Please try again.', 'error');
  }
}

// ─────────────────────────────────────────
// SET ORDER DETAILS (called when user clicks Buy Now or Enter break)
// ─────────────────────────────────────────
function setOrderAndCheckout(amount, itemName) {
  window.currentOrderAmount = amount;
  window.currentOrderItem = itemName;
  openModal('checkout');
}

// ─────────────────────────────────────────
// BREAK SLOT PICKER
// ─────────────────────────────────────────
var ENERGY_COLORS = {
  'Fire': '#e74c3c', 'Water': '#3498db', 'Grass': '#27ae60',
  'Lightning': '#f1c40f', 'Psychic': '#9b59b6', 'Fighting': '#e67e22',
  'Darkness': '#2c3e50', 'Metal': '#95a5a6'
};

async function openBreakSlotPicker(breakId, breakName, price, breakType, sport) {
  window.currentOrderAmount = parseFloat((price + '').replace('$', '')) || 0;
  window.currentOrderItem = breakName;
  window.currentBreakId = breakId;
  window.currentBreakType = breakType;

  // Remove existing picker
  var existing = document.getElementById('slot-picker-overlay');
  if (existing) existing.remove();

  // Show loading overlay
  var overlay = document.createElement('div');
  overlay.id = 'slot-picker-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:300;display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:2rem;';
  overlay.innerHTML = '<div style="color:var(--muted);font-family:'Barlow Condensed',sans-serif;letter-spacing:3px;text-transform:uppercase;font-size:13px;">Loading slots...</div>';
  document.body.appendChild(overlay);

  try {
    var res = await fetch('/api/breaks/' + breakId + '/slots');
    var slots = await res.json();

    var selectedSlots = [];
    var isRandom = breakType === 'random_team';
    var isEnergy = breakType === 'energy';

    var title = isEnergy ? 'Pick Your Energy' : isRandom ? 'Buy a Spot' : 'Pick Your Team';
    var subtitle = isEnergy ? 'Select one or more energy types — $' + price + ' per slot' :
                   isRandom ? 'Random teams assigned after sellout — $' + price + ' per spot' :
                   'Select one or more teams — $' + price + ' per slot';

    var sportLabel = sport === 'baseball' ? 'MLB' : sport === 'football' ? 'NFL' : sport === 'basketball' ? 'NBA' : '';

    var html = '<div style="background:var(--deep);border:1px solid var(--border);border-top:2px solid var(--red);padding:2rem;width:100%;max-width:700px;position:relative;">';
    html += '<button onclick="document.getElementById('slot-picker-overlay').remove()" style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--muted);font-size:24px;cursor:pointer;line-height:1;">&#215;</button>';
    html += '<h2 style="font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:4px;color:var(--text);margin-bottom:0.25rem;">' + title + '</h2>';
    html += '<p style="font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:0.25rem;">' + breakName + '</p>';
    if (sportLabel) html += '<span style="font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:3px 10px;border:1px solid var(--border);color:var(--muted);display:inline-block;margin-bottom:1rem;">' + sportLabel + '</span>';
    html += '<p style="font-size:13px;color:#888;margin-bottom:1.5rem;">' + subtitle + '</p>';

    var available = slots.filter(function(s){return !s.is_taken;}).length;
    html += '<div style="font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;">' + available + ' of ' + slots.length + ' slots available</div>';

    if (isRandom) {
      // Random — just show spots grid
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;margin-bottom:1.5rem;">';
      slots.forEach(function(s) {
        if (s.is_taken) {
          html += '<div style="background:#2a0a0a;border:1px solid #4a1a1a;padding:0.75rem;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:12px;color:var(--red-bright);letter-spacing:1px;">TAKEN</div>';
        } else {
          html += '<div id="slot-' + s.id + '" onclick="toggleSlot('' + s.id + '','' + s.slot_name + '')" style="background:var(--card);border:1px solid var(--border);padding:0.75rem;text-align:center;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;transition:background 0.15s;">' + s.slot_name + '</div>';
        }
      });
      html += '</div>';
    } else if (isEnergy) {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:1.5rem;">';
      slots.forEach(function(s) {
        var color = ENERGY_COLORS[s.slot_name] || '#888';
        if (s.is_taken) {
          html += '<div style="background:#1a1a1a;border:1px solid #2a2a2a;padding:1rem;text-align:center;opacity:0.4;">';
          html += '<div style="font-size:20px;margin-bottom:4px;">&#9711;</div>';
          html += '<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;color:#555;">' + s.slot_name + '</div>';
          html += '<div style="font-size:10px;color:#444;margin-top:4px;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px;">TAKEN</div></div>';
        } else {
          html += '<div id="slot-' + s.id + '" onclick="toggleSlot('' + s.id + '','' + s.slot_name + '')" style="background:var(--card);border:2px solid ' + color + '33;padding:1rem;text-align:center;cursor:pointer;transition:background 0.15s,border-color 0.15s;">';
          html += '<div style="width:32px;height:32px;border-radius:50%;background:' + color + ';margin:0 auto 8px;"></div>';
          html += '<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;color:var(--text);">' + s.slot_name + '</div></div>';
        }
      });
      html += '</div>';
    } else {
      // Pick your team
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:1.5rem;">';
      slots.forEach(function(s) {
        if (s.is_taken) {
          html += '<div style="background:#2a0a0a;border:1px solid #4a1a1a;padding:0.75rem;text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:12px;color:var(--red-bright);letter-spacing:1px;opacity:0.6;">' + s.slot_name + '<br><span style="font-size:10px;">TAKEN</span></div>';
        } else {
          html += '<div id="slot-' + s.id + '" onclick="toggleSlot('' + s.id + '','' + s.slot_name + '')" style="background:var(--card);border:1px solid var(--border);padding:0.75rem;text-align:center;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;transition:background 0.15s,border-color 0.15s;">' + s.slot_name + '</div>';
        }
      });
      html += '</div>';
    }

    html += '<div id="slot-summary" style="background:var(--surface);border:1px solid var(--border);padding:1rem;margin-bottom:1rem;display:none;">';
    html += '<div style="font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-bottom:0.5rem;">Your Selection</div>';
    html += '<div id="slot-summary-items" style="font-size:14px;color:var(--text);margin-bottom:0.5rem;"></div>';
    html += '<div id="slot-summary-total" style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:var(--red-bright);letter-spacing:2px;"></div>';
    html += '</div>';

    html += '<button id="slot-checkout-btn" onclick="proceedToBreakCheckout()" style="width:100%;background:var(--red);color:#fff;border:none;padding:14px;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:3px;text-transform:uppercase;cursor:pointer;opacity:0.5;pointer-events:none;">Select slots to continue</button>';
    html += '</div>';

    overlay.innerHTML = html;

    // Store slots data and selected state
    window.breakSlotsData = slots;
    window.selectedSlotIds = [];
    window.slotPrice = parseFloat((price + '').replace('$', '')) || 0;

  } catch(e) {
    overlay.innerHTML = '<div style="color:var(--red-bright);font-family:'Barlow Condensed',sans-serif;letter-spacing:2px;">Failed to load slots. Please try again.</div>';
  }
}

function toggleSlot(slotId, slotName) {
  var el = document.getElementById('slot-' + slotId);
  if (!el) return;
  var idx = window.selectedSlotIds.indexOf(slotId);
  if (idx === -1) {
    window.selectedSlotIds.push(slotId);
    el.style.background = 'var(--red-glow)';
    el.style.borderColor = 'var(--red-bright)';
    el.style.color = '#fff';
  } else {
    window.selectedSlotIds.splice(idx, 1);
    el.style.background = 'var(--card)';
    el.style.borderColor = window.currentBreakType === 'energy' ? (ENERGY_COLORS[slotName] || '#888') + '33' : 'var(--border)';
    el.style.color = 'var(--text)';
  }
  updateSlotSummary();
}

function updateSlotSummary() {
  var selected = window.selectedSlotIds;
  var summary = document.getElementById('slot-summary');
  var items = document.getElementById('slot-summary-items');
  var total = document.getElementById('slot-summary-total');
  var btn = document.getElementById('slot-checkout-btn');
  
  if (!selected.length) {
    summary.style.display = 'none';
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
    btn.textContent = 'Select slots to continue';
    return;
  }

  var names = selected.map(function(id) {
    var s = window.breakSlotsData.find(function(x){return x.id===id;});
    return s ? s.slot_name : id;
  });
  var totalAmount = selected.length * window.slotPrice;
  window.currentOrderAmount = totalAmount;

  summary.style.display = 'block';
  items.textContent = names.join(', ');
  total.textContent = '$' + totalAmount.toFixed(2);
  btn.style.opacity = '1';
  btn.style.pointerEvents = 'auto';
  btn.textContent = 'Continue to Payment — $' + totalAmount.toFixed(2);
}

function proceedToBreakCheckout() {
  if (!window.selectedSlotIds.length) return;
  document.getElementById('slot-picker-overlay').remove();
  openModal('checkout');
}

// Override setOrderAndCheckout for breaks to use slot picker
var _originalSetOrder = window.setOrderAndCheckout;
window.openBreakEntry = function(breakId, breakName, price, breakType, sport) {
  // If no break type (old break), just use regular checkout
  if (!breakType || breakType === 'standard') {
    window.currentOrderAmount = parseFloat((price + '').replace('$', '')) || 0;
    window.currentOrderItem = breakName;
    openModal('checkout');
  } else {
    openBreakSlotPicker(breakId, breakName, price, breakType, sport);
  }
};
