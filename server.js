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
// USER PROFILE — GET
// ─────────────────────────────────────────
app.get('/api/profile/:user_id', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('user_profiles')
      .select('*')
      .eq('id', req.params.user_id)
      .single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ─────────────────────────────────────────
// USER PROFILE — SAVE/UPDATE
// ─────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  const { user_id, full_name, phone, address_line1, address_line2, city, state, zip } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID required.' });
  try {
    const { data, error } = await getSupabase()
      .from('user_profiles')
      .upsert({ id: user_id, full_name, phone, address_line1, address_line2, city, state, zip, updated_at: new Date().toISOString() })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, profile: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save profile.' });
  }
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

    // Create initial profile
    if (data.user) {
      await getSupabase().from('user_profiles').upsert({
        id: data.user.id, full_name, phone: phone || null
      });
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
// BREAKS ADMIN — UPDATE
// ─────────────────────────────────────────
app.post('/api/breaks/admin/update', async (req, res) => {
  const { id, name, break_date, price, total_spots, filled_spots, is_active, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (break_date !== undefined) updates.break_date = break_date;
    if (price !== undefined) updates.price = price;
    if (total_spots !== undefined) updates.total_spots = total_spots;
    if (filled_spots !== undefined) updates.filled_spots = filled_spots;
    if (is_active !== undefined) updates.is_active = is_active;
    if (req.body.break_type !== undefined) updates.break_type = req.body.break_type;
    if (req.body.sport !== undefined) updates.sport = req.body.sport;
    const { data, error } = await getSupabase().from('breaks').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, break: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update break.' });
  }
});

// ─────────────────────────────────────────
// BREAKS ADMIN — GET ALL (including inactive)
// ─────────────────────────────────────────
app.get('/api/breaks/admin/all', async (req, res) => {
  const { admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { data, error } = await getSupabase().from('breaks').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load breaks.' });
  }
});

// ─────────────────────────────────────────
// SHOP ADMIN — GET ALL
// ─────────────────────────────────────────
app.get('/api/shop/admin/all', async (req, res) => {
  const { admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { data, error } = await getSupabase().from('shop_items').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shop items.' });
  }
});

// ─────────────────────────────────────────
// SHOP ADMIN — ADD ITEM
// ─────────────────────────────────────────
app.post('/api/shop/admin/add', async (req, res) => {
  const { title, category, condition, price, image_url, in_stock, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!title || !price) return res.status(400).json({ error: 'Title and price required.' });
  try {
    const quantity = req.body.quantity || 1;
    const { data, error } = await getSupabase().from('shop_items')
      .insert({ title, category: category || null, condition: condition || null, price, image_url: image_url || null, in_stock: in_stock !== false, quantity })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add item.' });
  }
});

// ─────────────────────────────────────────
// SHOP ADMIN — UPDATE ITEM
// ─────────────────────────────────────────
app.post('/api/shop/admin/update', async (req, res) => {
  const { id, title, category, condition, price, image_url, in_stock, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (category !== undefined) updates.category = category;
    if (condition !== undefined) updates.condition = condition;
    if (price !== undefined) updates.price = price;
    if (image_url !== undefined) updates.image_url = image_url;
    if (in_stock !== undefined) updates.in_stock = in_stock;
    if (req.body.quantity !== undefined) updates.quantity = req.body.quantity;
    const { data, error } = await getSupabase().from('shop_items').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item.' });
  }
});

// ─────────────────────────────────────────
// SHOP ADMIN — DELETE ITEM
// ─────────────────────────────────────────
app.delete('/api/shop/admin/delete/:id', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { error } = await getSupabase().from('shop_items').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item.' });
  }
});

// ─────────────────────────────────────────
// SHOP ADMIN — UPLOAD IMAGE (base64)
// ─────────────────────────────────────────
app.post('/api/shop/admin/upload-image', async (req, res) => {
  const { image_base64, filename, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!image_base64 || !filename) return res.status(400).json({ error: 'Image and filename required.' });
  try {
    const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const { data, error } = await getSupabase().storage
      .from('shop-images')
      .upload('items/' + Date.now() + '-' + filename, buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) return res.status(500).json({ error: error.message });
    const { data: urlData } = getSupabase().storage.from('shop-images').getPublicUrl(data.path);
    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: 'Image upload failed.' });
  }
});


// ─────────────────────────────────────────
// BREAK SLOTS — GET FOR A BREAK
// ─────────────────────────────────────────
app.get('/api/breaks/:id/slots', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('break_slots')
      .select('*')
      .eq('break_id', req.params.id)
      .order('slot_name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load slots.' });
  }
});

// ─────────────────────────────────────────
// BREAK SLOTS — CLAIM A SLOT
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/claim', async (req, res) => {
  const { slot_ids, buyer_name, user_id } = req.body;
  if (!slot_ids || !slot_ids.length) return res.status(400).json({ error: 'No slots selected.' });
  try {
    const supabase = getSupabase();
    // Check slots are still available
    const { data: slots, error: fetchErr } = await supabase
      .from('break_slots').select('*').in('id', slot_ids);
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    const taken = slots.filter(function(s) { return s.is_taken; });
    if (taken.length) return res.status(409).json({ error: 'Some slots already taken: ' + taken.map(function(s){return s.slot_name;}).join(', ') });
    // Claim them
    const { error: updateErr } = await supabase
      .from('break_slots')
      .update({ is_taken: true, buyer_name: buyer_name || null, user_id: user_id || null })
      .in('id', slot_ids);
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    // Update filled_spots on break
    const { data: breakData } = await supabase.from('breaks').select('filled_spots').eq('id', req.params.id).single();
    if (breakData) {
      await supabase.from('breaks').update({ filled_spots: (breakData.filled_spots || 0) + slot_ids.length }).eq('id', req.params.id);
    }
    res.json({ success: true, claimed: slot_ids.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim slots.' });
  }
});

// ─────────────────────────────────────────
// BREAK SLOTS — ADMIN CREATE SLOTS FOR A BREAK
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/setup', async (req, res) => {
  const { slots, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!slots || !slots.length) return res.status(400).json({ error: 'No slots provided.' });
  try {
    const supabase = getSupabase();
    // Delete existing slots first
    await supabase.from('break_slots').delete().eq('break_id', req.params.id);
    // Insert new slots
    const inserts = slots.map(function(s) {
      return { break_id: req.params.id, slot_name: s.name, slot_type: s.type, is_taken: false, price: s.price || 0 };
    });
    const { error } = await supabase.from('break_slots').insert(inserts);
    if (error) return res.status(500).json({ error: error.message });
    // Update total_spots on break
    await supabase.from('breaks').update({ total_spots: slots.length, filled_spots: 0 }).eq('id', req.params.id);
    res.json({ success: true, slots_created: slots.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to setup slots.' });
  }
});


// ─────────────────────────────────────────
// BREAK SLOTS — ADMIN ASSIGN RANDOM TEAMS
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/assign-random', async (req, res) => {
  const { sport, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  
  const MLB_TEAMS = ['Angels','Astros','Athletics','Blue Jays','Braves','Brewers','Cardinals','Cubs','Diamondbacks','Dodgers','Giants','Guardians','Mariners','Marlins','Mets','Nationals','Orioles','Padres','Phillies','Pirates','Rangers','Rays','Red Sox','Reds','Rockies','Royals','Tigers','Twins','White Sox','Yankees'];
  const NFL_TEAMS = ['49ers','Bears','Bengals','Bills','Broncos','Browns','Buccaneers','Cardinals','Chargers','Chiefs','Colts','Cowboys','Dolphins','Eagles','Falcons','Giants','Jaguars','Jets','Lions','Packers','Panthers','Patriots','Raiders','Rams','Ravens','Saints','Seahawks','Steelers','Texans','Titans','Vikings','Washington'];
  const NBA_TEAMS = ['76ers','Bucks','Bulls','Cavaliers','Celtics','Clippers','Grizzlies','Hawks','Heat','Hornets','Jazz','Kings','Knicks','Lakers','Magic','Mavericks','Nets','Nuggets','Pacers','Pelicans','Pistons','Raptors','Rockets','Spurs','Suns','Thunder','Timberwolves','Trail Blazers','Warriors','Wizards'];
  
  const teamList = sport === 'baseball' ? MLB_TEAMS : sport === 'football' ? NFL_TEAMS : NBA_TEAMS;

  try {
    const supabase = getSupabase();
    
    // Get all slots for this break
    const { data: slots, error: fetchErr } = await supabase
      .from('break_slots')
      .select('*')
      .eq('break_id', req.params.id)
      .order('created_at', { ascending: true });
    
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!slots || !slots.length) return res.status(400).json({ error: 'No slots found for this break.' });

    // Shuffle the team list
    const numSlots = slots.length;
    const teams = [...teamList].sort(() => Math.random() - 0.5).slice(0, numSlots);

    // Assign a team to each slot
    const updates = slots.map(function(slot, i) {
      return supabase
        .from('break_slots')
        .update({ slot_name: teams[i] || 'Team ' + (i + 1) })
        .eq('id', slot.id);
    });

    await Promise.all(updates);

    // Return the assignments
    const assignments = slots.map(function(slot, i) {
      return { spot: slot.slot_name, team: teams[i], buyer: slot.buyer_name };
    });

    res.json({ success: true, assignments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign teams.' });
  }
});

// ─────────────────────────────────────────
// BREAK SLOTS — ADMIN RESET A SLOT
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/reset', async (req, res) => {
  const { slot_id, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const supabase = getSupabase();
    await supabase.from('break_slots').update({ is_taken: false, buyer_name: null, user_id: null }).eq('id', slot_id);
    const { data: breakData } = await supabase.from('breaks').select('filled_spots').eq('id', req.params.id).single();
    if (breakData && breakData.filled_spots > 0) {
      await supabase.from('breaks').update({ filled_spots: breakData.filled_spots - 1 }).eq('id', req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset slot.' });
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
    const breakType = req.body.break_type || 'energy';
    const sport = req.body.sport || null;
    const { data, error } = await getSupabase().from('breaks').insert({
      brand, name, break_date, price, total_spots, filled_spots: 0, is_active: true,
      break_type: breakType, sport: sport
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
// PSA ADMIN — LOOKUP USER BY EMAIL
// ─────────────────────────────────────────
app.get('/api/admin/user-by-email', async (req, res) => {
  const { email, admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const adminSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data, error } = await adminSupabase.auth.admin.listUsers();
    if (error) return res.status(500).json({ error: error.message });
    const user = data.users.find(function(u) { return u.email === email; });
    if (!user) return res.json({ found: false });
    res.json({ found: true, user_id: user.id, email: user.email, name: user.user_metadata?.full_name });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// ─────────────────────────────────────────
// PSA ADMIN — ADD SUBMISSION
// ─────────────────────────────────────────
app.post('/api/psa/admin/add', async (req, res) => {
  const { submission_ref, card_name, submitted_date, status, grade, notes, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!submission_ref || !card_name) return res.status(400).json({ error: 'Submission ref and card name required.' });
  try {
    const { data, error } = await getSupabase()
      .from('psa_submissions')
      .insert({ submission_ref, card_name, submitted_date: submitted_date || null, status: status || 'received', grade: grade || null, notes: notes || null, user_id: req.body.user_id || null })
      .select().single();
    if (error) return res.status(500).json({ error: error.message, details: error.details, hint: error.hint });
    res.json({ success: true, submission: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add submission.', details: err.message });
  }
});

// ─────────────────────────────────────────
// PSA ADMIN — UPDATE STATUS
// ─────────────────────────────────────────
app.post('/api/psa/admin/update', async (req, res) => {
  const { submission_ref, status, grade, notes, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!submission_ref || !status) return res.status(400).json({ error: 'Submission ref and status required.' });
  try {
    const { data, error } = await getSupabase()
      .from('psa_submissions')
      .update({ status, grade: grade || null, notes: notes || null, updated_at: new Date().toISOString() })
      .eq('submission_ref', submission_ref)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, submission: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update submission.' });
  }
});

// ─────────────────────────────────────────
// PSA ADMIN — GET ALL SUBMISSIONS
// ─────────────────────────────────────────
app.get('/api/psa/admin/all', async (req, res) => {
  const { admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { data, error } = await getSupabase()
      .from('psa_submissions')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions.' });
  }
});

// ─────────────────────────────────────────
// PSA ADMIN — DELETE SUBMISSION
// ─────────────────────────────────────────
app.delete('/api/psa/admin/delete/:ref', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { error } = await getSupabase()
      .from('psa_submissions')
      .delete()
      .eq('submission_ref', req.params.ref);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete submission.' });
  }
});

// ─────────────────────────────────────────
// PSA SUBMISSIONS — PUBLIC LOOKUP by email or ref
// ─────────────────────────────────────────
app.get('/api/psa/lookup', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required.' });
  try {
    const supabase = getSupabase();
    console.log('PSA lookup query:', q);
    const { data, error } = await supabase
      .from('psa_submissions')
      .select('*')
      .ilike('submission_ref', '%' + q + '%')
      .order('submitted_date', { ascending: false });
    console.log('PSA lookup result:', JSON.stringify(data), 'error:', error);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

// ─────────────────────────────────────────
// PSA SUBMISSIONS — GET (requires auth)
// ─────────────────────────────────────────
app.get('/api/psa/:user_id', async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('psa_submissions')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('submitted_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
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

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
        },
        body: JSON.stringify({
          from: 'The Asylum Website <onboarding@resend.dev>',
          to: ['theasylumbranding@gmail.com'],
          reply_to: email,
          subject: '[The Asylum] ' + subject + ' — from ' + name,
          html: '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">' +
            '<h2 style="color:#c0392b;">New Message — The Asylum Website</h2>' +
            '<table style="width:100%;border-collapse:collapse;">' +
            '<tr><td style="padding:8px;color:#888;width:100px;">Topic</td><td style="padding:8px;font-weight:bold;">' + subject + '</td></tr>' +
            '<tr><td style="padding:8px;color:#888;">From</td><td style="padding:8px;">' + name + '</td></tr>' +
            '<tr><td style="padding:8px;color:#888;">Email</td><td style="padding:8px;"><a href="mailto:' + email + '">' + email + '</a></td></tr>' +
            '</table>' +
            '<div style="background:#f5f5f5;padding:1.5rem;margin-top:1rem;border-left:4px solid #c0392b;">' +
            '<p style="margin:0;white-space:pre-wrap;">' + message + '</p>' +
            '</div>' +
            '<p style="color:#888;font-size:12px;margin-top:1rem;">Sent from the-asylum-website.vercel.app — reply directly to this email to respond to ' + name + '</p>' +
            '</div>'
        })
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`The Asylum server running on port ${PORT}`);
  });
}

module.exports = app;
