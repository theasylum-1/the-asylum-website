require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Lazy-initialize Stripe so a missing key doesn't crash the whole server
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// Lazy-initialize Supabase
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) throw new Error('Supabase env vars not set');
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _supabase;
}

app.use(cors());

// Serve static files
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root route explicitly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Raw body needed for Stripe webhooks
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'The Asylum server is running',
    env: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      supabase: !!process.env.SUPABASE_URL,
      paypal: !!process.env.PAYPAL_CLIENT_ID,
      admin: !!process.env.ADMIN_KEY,
    }
  });
});

// ─────────────────────────────────────────
// AUTH — SIGN UP
// ─────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, full_name, phone, sms_optin } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Name, email and password are required.' });
  }
  try {
    const { data, error } = await getSupabase().auth.signUp({
      email,
      password,
      options: { data: { full_name, phone, sms_optin: sms_optin || false } }
    });
    if (error) return res.status(400).json({ error: error.message });

    // If they opted into SMS, add to sms_subscribers table
    if (sms_optin && phone) {
      await getSupabase().from('sms_subscribers').insert({ phone, name: full_name, source: 'signup' });
    }

    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ─────────────────────────────────────────
// AUTH — SIGN IN
// ─────────────────────────────────────────
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid email or password.' });
    res.json({ success: true, session: data.session, user: data.user });
  } catch (err) {
    res.status(500).json({ error: 'Sign in failed. Please try again.' });
  }
});

// ─────────────────────────────────────────
// BREAKS — GET ALL (public)
// ─────────────────────────────────────────
app.get('/api/breaks', async (req, res) => {
  const { brand } = req.query;
  try {
    let query = getSupabase().from('breaks').select('*').eq('is_active', true).order('created_at', { ascending: true });
    if (brand) query = query.eq('brand', brand);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load breaks.' });
  }
});

// ─────────────────────────────────────────
// BREAKS — ADD NEW (admin only)
// ─────────────────────────────────────────
app.post('/api/breaks', async (req, res) => {
  const { brand, name, break_date, price, total_spots, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }
  try {
    const { data, error } = await getSupabase().from('breaks').insert({
      brand, name, break_date, price, total_spots, filled_spots: 0, is_active: true
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, break: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create break.' });
  }
});

// ─────────────────────────────────────────
// BREAKS — DELETE (admin only)
// ─────────────────────────────────────────
app.delete('/api/breaks/:id', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }
  try {
    const { error } = await getSupabase().from('breaks').update({ is_active: false }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete break.' });
  }
});

// ─────────────────────────────────────────
// SHOP — GET ITEMS (public)
// ─────────────────────────────────────────
app.get('/api/shop', async (req, res) => {
  try {
    const { data, error } = await getSupabase().from('shop_items').select('*').eq('in_stock', true).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shop items.' });
  }
});

// ─────────────────────────────────────────
// STRIPE — CREATE PAYMENT INTENT
// ─────────────────────────────────────────
app.post('/api/stripe/create-payment-intent', async (req, res) => {
  const { amount, item_name, item_id, order_type } = req.body;
  if (!amount || amount < 1) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  try {
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: 'usd',
      metadata: { item_name, item_id, order_type }
    });
    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment. Please try again.' });
  }
});

// ─────────────────────────────────────────
// PAYPAL — CREATE ORDER
// ─────────────────────────────────────────
app.post('/api/paypal/create-order', async (req, res) => {
  const { amount, item_name } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required.' });

  try {
    // Get PayPal access token
    const authRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
        ).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    const authData = await authRes.json();

    // Create order
    const orderRes = await fetch('https://api-m.paypal.com/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authData.access_token
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: amount.toFixed(2) },
          description: item_name
        }]
      })
    });
    const order = await orderRes.json();
    res.json({ orderID: order.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create PayPal order.' });
  }
});

// ─────────────────────────────────────────
// PAYPAL — CAPTURE ORDER
// ─────────────────────────────────────────
app.post('/api/paypal/capture-order', async (req, res) => {
  const { orderID } = req.body;
  try {
    const authRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
        ).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    const authData = await authRes.json();

    const captureRes = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authData.access_token
      }
    });
    const capture = await captureRes.json();
    res.json({ success: true, capture });
  } catch (err) {
    res.status(500).json({ error: 'Failed to capture PayPal payment.' });
  }
});

// ─────────────────────────────────────────
// STRIPE WEBHOOK — record completed orders
// ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = require('stripe')(process.env.STRIPE_SECRET_KEY).webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await getSupabase().from('orders').insert({
      order_type: pi.metadata.order_type || 'shop',
      item_id: pi.metadata.item_id || null,
      amount: pi.amount / 100,
      payment_method: 'stripe',
      payment_status: 'paid',
      notes: pi.metadata.item_name || ''
    });
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────
// PSA SUBMISSIONS — GET (requires auth)
// ─────────────────────────────────────────
app.get('/api/psa/:user_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('psa_submissions')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('submitted_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions.' });
  }
});

// ─────────────────────────────────────────
// SMS SUBSCRIBE
// ─────────────────────────────────────────
app.post('/api/sms-subscribe', async (req, res) => {
  const { phone, name, source } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required.' });
  try {
    // Save to Supabase
    await getSupabase().from('sms_subscribers').insert({ phone, name: name || '', source: source || 'website' });

    // Send to Zapier webhook → Zapier adds contact to Textedly + triggers welcome text
    await fetch('https://hooks.zapier.com/hooks/catch/27059353/unemqks/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name: name || '', source: source || 'website', coupon: 'ASYLUM10' })
    });

    res.json({ success: true, coupon: 'ASYLUM10' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
  }
});

// ─────────────────────────────────────────
// CONTACT FORM
// ─────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    // Save to Supabase for your records
    await getSupabase().from('contact_messages').insert({ name, email, subject, message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`The Asylum server running on port ${PORT}`);
});