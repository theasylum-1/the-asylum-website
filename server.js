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

// Public portfolio share page — no auth required
app.get('/vault/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vault-share.html'));
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
    const { createClient } = require('@supabase/supabase-js');
    const adminDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await adminDb
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
    const { createClient } = require('@supabase/supabase-js');
    const adminDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await adminDb
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

      // Send welcome email
      if (process.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
            },
            body: JSON.stringify({
              from: 'The Asylum <onboarding@resend.dev>',
              to: [email],
              reply_to: 'theasylumbranding@gmail.com',
              subject: 'Welcome to The Asylum Collective',
              html: `
                <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#e8e0d8;padding:2rem;border-top:3px solid #e74c3c;">
                  <img src="https://theasylumcollective.com/images/img_001.png" alt="The Asylum" style="height:60px;margin-bottom:1.5rem;">
                  <h1 style="font-size:32px;letter-spacing:4px;margin-bottom:0.5rem;color:#e8e0d8;">WELCOME TO<br>THE ASYLUM</h1>
                  <p style="color:#888;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-bottom:2rem;">Hey ${full_name || 'collector'}, you're officially in.</p>

                  <div style="background:#1f1f1f;border:1px solid #2a2a2a;border-left:3px solid #e74c3c;padding:1.5rem;margin-bottom:1.5rem;">
                    <p style="font-size:14px;color:#e8e0d8;line-height:1.7;margin-bottom:1rem;">
                      You now have access to everything The Asylum has to offer — breaks, the shop, PSA submission tracking, The Vault collection tracker, and more.
                    </p>
                    <p style="font-size:14px;color:#e8e0d8;line-height:1.7;">
                      As a welcome gift, use code below for <strong style="color:#e74c3c;">10% off</strong> your first order:
                    </p>
                  </div>

                  <div style="background:#1a0a0a;border:2px dashed #e74c3c;padding:1.5rem;text-align:center;margin-bottom:1.5rem;">
                    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#888;margin-bottom:0.5rem;">Your Welcome Coupon</div>
                    <div style="font-family:monospace;font-size:32px;font-weight:900;color:#e74c3c;letter-spacing:6px;">ASYLUM10</div>
                    <div style="font-size:12px;color:#666;margin-top:0.5rem;">10% off anything in the shop or breaks</div>
                  </div>

                  <div style="display:grid;margin-bottom:1.5rem;">
                    <a href="https://theasylumcollective.com/#breaks" style="display:block;background:#e74c3c;color:#fff;text-align:center;padding:14px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">View Upcoming Breaks</a>
                    <a href="https://theasylumcollective.com/collection.html" style="display:block;background:#1f1f1f;border:1px solid #2a2a2a;color:#e8e0d8;text-align:center;padding:14px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Open The Vault</a>
                  </div>

                  <p style="font-size:13px;color:#888;line-height:1.7;margin-bottom:1.5rem;">
                    Join our Discord community to stay up to date with break schedules, drops, and giveaways.
                    <a href="https://discord.gg/vVJjMYTc9b" style="color:#e74c3c;">Join the Discord →</a>
                  </p>

                  <div style="border-top:1px solid #2a2a2a;padding-top:1rem;font-size:11px;color:#444;letter-spacing:2px;text-transform:uppercase;">
                    The Asylum Collective · theasylumcollective.com<br>
                    <a href="mailto:theasylumbranding@gmail.com" style="color:#555;">theasylumbranding@gmail.com</a>
                  </div>
                </div>
              `
            })
          });
        } catch(emailErr) {
          console.error('Welcome email failed:', emailErr.message);
        }
      }
    }

    res.json({ success: true, user: data.user });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});


// ─────────────────────────────────────────
// AUTH — REQUEST PASSWORD RESET
// ─────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://theasylumcollective.com/#reset'
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reset email.' });
  }
});

// ─────────────────────────────────────────
// AUTH — UPDATE PASSWORD (after reset)
// ─────────────────────────────────────────
app.post('/api/auth/update-password', async (req, res) => {
  const { access_token, new_password } = req.body;
  if (!access_token || !new_password) return res.status(400).json({ error: 'Token and password required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: 'Bearer ' + access_token } }
    });
    const { error } = await supabase.auth.updateUser({ password: new_password });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password.' });
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
// ADMIN — LIST ALL USERS (for dropdowns)
// ─────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  const { admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const adminSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data, error } = await adminSupabase.auth.admin.listUsers();
    if (error) return res.status(500).json({ error: error.message });
    const users = (data.users || []).map(function(u) {
      return {
        user_id: u.id,
        id: u.id,
        email: u.email,
        name: u.user_metadata && u.user_metadata.full_name ? u.user_metadata.full_name : null
      };
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list users.' });
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
    if (req.body.description !== undefined) updates.description = req.body.description;
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
  const { slot_ids, buyer_name, user_id, payment_method, status } = req.body;
  if (!slot_ids || !slot_ids.length) return res.status(400).json({ error: 'No slots selected.' });
  try {
    const supabase = getSupabase();
    // Check slots are still available
    const { data: slots, error: fetchErr } = await supabase
      .from('break_slots').select('*').in('id', slot_ids);
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    const taken = slots.filter(function(s) { return s.is_taken || s.status === 'taken' || s.status === 'pending' || s.status === 'payment_sent'; });
    if (taken.length) return res.status(409).json({ error: 'Some slots are no longer available: ' + taken.map(function(s){return s.slot_name;}).join(', ') });

    // Determine final status
    const slotStatus = status || 'taken';
    const isTaken = slotStatus === 'taken';

    const { error: updateErr } = await supabase
      .from('break_slots')
      .update({
        is_taken: isTaken,
        status: slotStatus,
        buyer_name: buyer_name || null,
        user_id: user_id || null,
        pending_buyer: buyer_name || null,
        pending_at: new Date().toISOString()
      })
      .in('id', slot_ids);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Update filled_spots on break only if fully taken
    if (isTaken) {
      const { data: breakData } = await supabase.from('breaks').select('filled_spots').eq('id', req.params.id).single();
      if (breakData) {
        await supabase.from('breaks').update({ filled_spots: (breakData.filled_spots || 0) + slot_ids.length }).eq('id', req.params.id);
      }
    }
    res.json({ success: true, claimed: slot_ids.length, status: slotStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim slots.' });
  }
});

// ─────────────────────────────────────────
// BREAK SLOTS — CONFIRM PAYMENT (mark taken)
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/confirm-payment', async (req, res) => {
  const { slot_ids, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('break_slots')
      .update({ is_taken: true, status: 'taken' })
      .in('id', slot_ids);
    if (error) return res.status(500).json({ error: error.message });
    // Update filled_spots
    const { data: breakData } = await supabase.from('breaks').select('filled_spots').eq('id', req.params.id).single();
    if (breakData) {
      await supabase.from('breaks').update({ filled_spots: (breakData.filled_spots || 0) + slot_ids.length }).eq('id', req.params.id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to confirm payment.' }); }
});

// ─────────────────────────────────────────
// BREAK SLOTS — RELEASE PENDING SLOT (admin)
// ─────────────────────────────────────────
app.post('/api/breaks/:id/slots/release', async (req, res) => {
  const { slot_id, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const supabase = getSupabase();
    await supabase.from('break_slots')
      .update({ is_taken: false, status: 'available', buyer_name: null, user_id: null, pending_buyer: null, pending_at: null })
      .eq('id', slot_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to release slot.' }); }
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
    const description = req.body.description || null;
    const { data, error } = await getSupabase().from('breaks').insert({
      brand, name, break_date, price, total_spots, filled_spots: 0, is_active: true,
      break_type: breakType, sport: sport, description: description
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
    const { customer_email, customer_name } = req.body;
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      receipt_email: customer_email || null,
      metadata: { item_name, item_id, order_type, customer_email: customer_email || '', customer_name: customer_name || '' }
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

    // Send confirmation email
    const payer = capture.payer;
    const unit = capture.purchase_units && capture.purchase_units[0];
    if (payer && payer.email_address) {
      await sendOrderConfirmation({
        to: payer.email_address,
        name: payer.name ? payer.name.given_name : '',
        item: unit ? unit.description : 'Order',
        amount: unit ? unit.amount.value : 0,
        paymentMethod: 'PayPal',
        orderId: orderID
      });
    }

    res.json({ success: true, capture });
  } catch (err) {
    res.status(500).json({ error: 'Failed to capture PayPal payment.' });
  }
});


// ─────────────────────────────────────────
// SEND ORDER CONFIRMATION EMAIL
// ─────────────────────────────────────────
async function sendOrderConfirmation({ to, name, item, amount, paymentMethod, orderId }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'The Asylum <onboarding@resend.dev>',
        to: [to],
        reply_to: 'theasylumbranding@gmail.com',
        subject: 'Order Confirmed — The Asylum',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#e8e0d8;padding:2rem;border-top:3px solid #e74c3c;">
            <img src="https://theasylumcollective.com/images/img_001.png" alt="The Asylum" style="height:60px;margin-bottom:1.5rem;">
            <h1 style="font-size:28px;letter-spacing:3px;margin-bottom:0.5rem;color:#e8e0d8;">ORDER CONFIRMED</h1>
            <p style="color:#888;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-bottom:2rem;">Thanks for your order, ${name || 'valued customer'}!</p>
            <div style="background:#1f1f1f;border:1px solid #2a2a2a;border-left:3px solid #e74c3c;padding:1.25rem;margin-bottom:1.5rem;">
              <table style="width:100%;border-collapse:collapse;">
                <tr><td style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:6px 0;">Item</td><td style="color:#e8e0d8;font-size:14px;text-align:right;padding:6px 0;">${item}</td></tr>
                <tr><td style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:6px 0;">Amount</td><td style="color:#e74c3c;font-size:18px;font-weight:700;text-align:right;padding:6px 0;">$${parseFloat(amount).toFixed(2)}</td></tr>
                <tr><td style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:6px 0;">Payment</td><td style="color:#e8e0d8;font-size:14px;text-align:right;padding:6px 0;">${paymentMethod}</td></tr>
                ${orderId ? `<tr><td style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase;padding:6px 0;">Order ID</td><td style="color:#555;font-size:12px;text-align:right;padding:6px 0;">${orderId}</td></tr>` : ''}
              </table>
            </div>
            <p style="font-size:13px;color:#888;line-height:1.7;margin-bottom:1.5rem;">
              We'll be in touch with shipping details. If you have any questions reach us at 
              <a href="mailto:theasylumbranding@gmail.com" style="color:#e74c3c;">theasylumbranding@gmail.com</a> 
              or on Discord.
            </p>
            <div style="border-top:1px solid #2a2a2a;padding-top:1rem;font-size:11px;color:#444;letter-spacing:2px;text-transform:uppercase;">
              The Asylum · High St Asylum · Asylum Breaks
            </div>
          </div>
        `
      })
    });
  } catch (err) {
    console.error('Order confirmation email failed:', err.message);
  }
}

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
    // Send confirmation email if we have customer email
    if (pi.receipt_email || pi.metadata.customer_email) {
      await sendOrderConfirmation({
        to: pi.receipt_email || pi.metadata.customer_email,
        name: pi.metadata.customer_name || '',
        item: pi.metadata.item_name || 'Order',
        amount: pi.amount / 100,
        paymentMethod: 'Credit/Debit Card',
        orderId: pi.id
      });
    }
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
// COLLECTION — GET ALL ITEMS
// ─────────────────────────────────────────
app.get('/api/collection/:user_id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db
      .from('collection_items')
      .select('*')
      .eq('user_id', req.params.user_id)
      .eq('is_sold', false)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load collection.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — GET SOLD ITEMS
// ─────────────────────────────────────────
app.get('/api/collection/:user_id/sold', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db
      .from('collection_items')
      .select('*')
      .eq('user_id', req.params.user_id)
      .eq('is_sold', true)
      .order('sold_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sold items.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — ADD ITEM
// ─────────────────────────────────────────
app.post('/api/collection', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const item = {
      user_id,
      category: req.body.category,
      player_character: req.body.player_character || null,
      card_title: req.body.card_title || null,
      brand: req.body.brand || null,
      set_name: req.body.set_name || null,
      year: req.body.year || null,
      card_number: req.body.card_number || null,
      parallel: req.body.parallel || null,
      grade_company: req.body.grade_company || null,
      grade: req.body.grade || null,
      product_name: req.body.product_name || null,
      box_type: req.body.box_type || null,
      quantity: parseInt(req.body.quantity) || 1,
      purchase_price: parseFloat(req.body.purchase_price) || 0,
      estimated_value: parseFloat(req.body.estimated_value) || 0,
      value_updated_at: req.body.estimated_value ? new Date().toISOString() : null,
      notes: req.body.notes || null,
      is_sold: false,
    };
    const { data, error } = await db.from('collection_items').insert(item).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add item.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — UPDATE ITEM
// ─────────────────────────────────────────
app.put('/api/collection/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (updates.estimated_value !== undefined) updates.value_updated_at = new Date().toISOString();
    delete updates.user_id;
    const { data, error } = await db.from('collection_items').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — DELETE ITEM
// ─────────────────────────────────────────
app.delete('/api/collection/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { error } = await db.from('collection_items').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — MARK AS SOLD
// ─────────────────────────────────────────
app.post('/api/collection/:id/sell', async (req, res) => {
  const { sold_price, sold_date } = req.body;
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('collection_items')
      .update({ is_sold: true, sold_price: parseFloat(sold_price) || 0, sold_date: sold_date || new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as sold.' });
  }
});

// ─────────────────────────────────────────
// COLLECTION — EXPORT CSV
// ─────────────────────────────────────────
app.get('/api/collection/:user_id/export', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('collection_items').select('*').eq('user_id', req.params.user_id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const headers = ['Category','Player/Character','Card Title','Brand','Set','Year','Card #','Parallel','Grade Co.','Grade','Product Name','Box Type','Qty','Purchase Price','Est. Value','Gain/Loss','Notes','Status','Sold Price','Sold Date'];
    const rows = (data || []).map(function(i) {
      const gl = ((i.estimated_value || 0) - (i.purchase_price || 0)) * (i.quantity || 1);
      return [
        i.category, i.player_character, i.card_title, i.brand, i.set_name, i.year, i.card_number, i.parallel,
        i.grade_company, i.grade, i.product_name, i.box_type, i.quantity, i.purchase_price, i.estimated_value,
        gl.toFixed(2), i.notes, i.is_sold ? 'Sold' : 'In Collection', i.sold_price, i.sold_date
      ].map(function(v) { return '"' + (v || '').toString().replace(/"/g, '""') + '"'; }).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="collection.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed.' });
  }
});


// ─────────────────────────────────────────
// COUPONS — VALIDATE
// ─────────────────────────────────────────
app.post('/api/coupons/validate', async (req, res) => {
  const { code, amount } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('coupons').select('*').eq('code', code.toUpperCase().trim()).eq('is_active', true).single();
    if (error || !data) return res.status(404).json({ error: 'Invalid or expired coupon code.' });
    if (data.expires_at && new Date(data.expires_at) < new Date()) return res.status(400).json({ error: 'This coupon has expired.' });
    if (data.usage_limit && data.usage_count >= data.usage_limit) return res.status(400).json({ error: 'This coupon has reached its usage limit.' });
    const originalAmount = parseFloat(amount) || 0;
    const discount = data.type === 'percent' ? (originalAmount * data.value / 100) : data.value;
    const finalAmount = Math.max(0, originalAmount - discount).toFixed(2);
    res.json({ valid: true, code: data.code, type: data.type, value: data.value, discount: parseFloat(discount.toFixed(2)), final_amount: parseFloat(finalAmount), coupon_id: data.id });
  } catch (err) { res.status(500).json({ error: 'Failed to validate coupon.' }); }
});

// ─────────────────────────────────────────
// COUPONS — ADMIN GET ALL
// ─────────────────────────────────────────
app.get('/api/coupons/admin/all', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ─────────────────────────────────────────
// COUPONS — ADMIN ADD
// ─────────────────────────────────────────
app.post('/api/coupons/admin/add', async (req, res) => {
  const { code, type, value, usage_limit, expires_at, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!code || !type || !value) return res.status(400).json({ error: 'Code, type and value required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('coupons').insert({ code: code.toUpperCase().trim(), type, value: parseFloat(value), usage_limit: usage_limit || null, expires_at: expires_at || null }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, coupon: data });
  } catch (err) { res.status(500).json({ error: 'Failed to create coupon.' }); }
});

// ─────────────────────────────────────────
// COUPONS — ADMIN TOGGLE ACTIVE
// ─────────────────────────────────────────
app.post('/api/coupons/admin/toggle', async (req, res) => {
  const { id, is_active, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    await db.from('coupons').update({ is_active }).eq('id', id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ─────────────────────────────────────────
// COUPONS — ADMIN DELETE
// ─────────────────────────────────────────
app.delete('/api/coupons/admin/delete/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    await db.from('coupons').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ─────────────────────────────────────────
// HOBBY NEWS — RSS AGGREGATOR
// ─────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const feeds = [
    { url: 'https://www.pokebeach.com/feed', label: 'Pokemon TCG' },
    { url: 'https://www.sportscollectorsdaily.com/feed/', label: 'Sports Cards' },
    { url: 'https://blog.psacard.com/feed/', label: 'PSA' },
    { url: 'https://bleedingcool.com/games/card-games/feed/', label: 'Card Games' },
    { url: 'https://www.beckett.com/news/feed/', label: 'Beckett' },
    { url: 'https://sportscardinvestor.com/feed/', label: 'Sports Card Investor' },
    { url: 'https://www.cardboardconnection.com/feed', label: 'Cardboard Connection' },
  ];

  async function parseFeed(url, label) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timeout);
      const xml = await res.text();

      const items = [];
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
        const item = match[1];
        const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
        const link = (item.match(/<link>(.*?)<\/link>/) || item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/))?.[1] || '';
        const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
        const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || '';
        const cleanDesc = desc.replace(/<[^>]+>/g, '').slice(0, 150).trim();
        if (title && link) items.push({ title: title.trim(), link: link.trim(), pubDate, description: cleanDesc, source: label });
      }
      return items;
    } catch (e) {
      return [];
    }
  }

  try {
    const results = await Promise.all(feeds.map(f => parseFeed(f.url, f.label)));
    let all = results.flat();
    // Sort by date, most recent first
    all.sort(function(a, b) {
      return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
    });
    // Limit to 30 items
    all = all.slice(0, 30);
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load news.' });
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
          subject: '[The Asylum] ' + subject + ' from ' + name,
          html: '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">' +
            '<h2 style="color:#c0392b;">New Message from The Asylum Website</h2>' +
            '<table style="width:100%;border-collapse:collapse;">' +
            '<tr><td style="padding:8px;color:#888;width:100px;">Topic</td><td style="padding:8px;font-weight:bold;">' + subject + '</td></tr>' +
            '<tr><td style="padding:8px;color:#888;">From</td><td style="padding:8px;">' + name + '</td></tr>' +
            '<tr><td style="padding:8px;color:#888;">Email</td><td style="padding:8px;"><a href="mailto:' + email + '">' + email + '</a></td></tr>' +
            '</table>' +
            '<div style="background:#f5f5f5;padding:1.5rem;margin-top:1rem;border-left:4px solid #c0392b;">' +
            '<p style="margin:0;white-space:pre-wrap;">' + message + '</p>' +
            '</div>' +
            '<p style="color:#888;font-size:12px;margin-top:1rem;">Sent from theasylumcollective.com</p>' +
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
// SHIPMENTS — GET ALL FOR USER
// ─────────────────────────────────────────
app.get('/api/shipments/:user_id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db
      .from('shipments')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shipments.' });
  }
});

// ─────────────────────────────────────────
// SHIPMENTS — ADD (member self-add)
// ─────────────────────────────────────────
app.post('/api/shipments', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'User ID required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const item = {
      user_id,
      description: req.body.description || null,
      tracking_number: req.body.tracking_number || null,
      carrier: req.body.carrier || 'other',
      direction: req.body.direction || 'incoming',
      status: req.body.status || 'shipped',
      notes: req.body.notes || null,
    };
    const { data, error } = await db.from('shipments').insert(item).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, shipment: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add shipment.' });
  }
});

// ─────────────────────────────────────────
// SHIPMENTS — ADMIN ADD (assign to any member)
// ─────────────────────────────────────────
app.post('/api/shipments/admin/add', async (req, res) => {
  const { admin_key, user_id } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  if (!user_id) return res.status(400).json({ error: 'User ID required.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const item = {
      user_id,
      description: req.body.description || null,
      tracking_number: req.body.tracking_number || null,
      carrier: req.body.carrier || 'other',
      direction: 'outgoing',
      status: 'shipped',
      notes: req.body.notes || null,
    };
    const { data, error } = await db.from('shipments').insert(item).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, shipment: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add shipment.' });
  }
});

// ─────────────────────────────────────────
// SHIPMENTS — ADMIN GET ALL (all users)
// ─────────────────────────────────────────
app.get('/api/shipments/admin/all', async (req, res) => {
  const { admin_key } = req.query;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db
      .from('shipments')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shipments.' });
  }
});

// ─────────────────────────────────────────
// SHIPMENTS — UPDATE
// ─────────────────────────────────────────
app.put('/api/shipments/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.user_id;
    const { data, error } = await db.from('shipments').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, shipment: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update shipment.' });
  }
});

// ─────────────────────────────────────────
// SHIPMENTS — DELETE
// ─────────────────────────────────────────
app.delete('/api/shipments/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { error } = await db.from('shipments').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete shipment.' });
  }
});

// ─────────────────────────────────────────
// CARRIER TRACKING — OAuth Token Cache
// ─────────────────────────────────────────
const tokenCache = {};

async function getUSPSToken() {
  if (tokenCache.usps && tokenCache.usps.expiresAt > Date.now()) return tokenCache.usps.token;
  const res = await fetch('https://apis.usps.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.USPS_CLIENT_ID, client_secret: process.env.USPS_CLIENT_SECRET, grant_type: 'client_credentials' })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('USPS auth failed: ' + JSON.stringify(data));
  tokenCache.usps = { token: data.access_token, expiresAt: Date.now() + (parseInt(data.expires_in || '3600') - 300) * 1000 };
  return data.access_token;
}

async function getUPSToken() {
  if (tokenCache.ups && tokenCache.ups.expiresAt > Date.now()) return tokenCache.ups.token;
  const creds = Buffer.from(process.env.UPS_CLIENT_ID + ':' + process.env.UPS_CLIENT_SECRET).toString('base64');
  const res = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + creds },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('UPS auth failed: ' + JSON.stringify(data));
  tokenCache.ups = { token: data.access_token, expiresAt: Date.now() + (parseInt(data.expires_in || '14399') - 300) * 1000 };
  return data.access_token;
}

async function getFedExToken() {
  if (tokenCache.fedex && tokenCache.fedex.expiresAt > Date.now()) return tokenCache.fedex.token;
  const res = await fetch('https://apis.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=' + encodeURIComponent(process.env.FEDEX_CLIENT_ID) + '&client_secret=' + encodeURIComponent(process.env.FEDEX_CLIENT_SECRET)
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('FedEx auth failed: ' + JSON.stringify(data));
  tokenCache.fedex = { token: data.access_token, expiresAt: Date.now() + (parseInt(data.expires_in || '3600') - 300) * 1000 };
  return data.access_token;
}

// ─────────────────────────────────────────
// CARRIER TRACKING — Fetch tracking from each carrier
// ─────────────────────────────────────────
async function trackUSPS(trackingNumber) {
  const token = await getUSPSToken();
  const res = await fetch('https://apis.usps.com/tracking/v3/tracking/' + encodeURIComponent(trackingNumber) + '?expand=DETAIL', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'USPS tracking failed: ' + JSON.stringify(data).substring(0, 500));

  const cat = (data.statusCategory || '').toLowerCase();
  const statusText = (data.status || '').toUpperCase();

  let status = 'label_created';
  if (cat === 'pre-shipment' || cat === 'pre shipment') {
    status = 'label_created';
  } else if (cat === 'accepted' || statusText.includes('USPS IN POSSESSION') || statusText.includes('ACCEPTED') || statusText.includes('PICKED UP')) {
    status = 'in_transit';
  } else if (cat === 'in transit' || cat === 'in-transit' || statusText.includes('IN TRANSIT') || statusText.includes('DEPARTED') || statusText.includes('ARRIVED') || statusText.includes('PROCESSED') || statusText.includes('FORWARDED') || statusText.includes('CUSTOMS')) {
    status = 'in_transit';
  } else if (cat === 'out for delivery' || statusText.includes('OUT FOR DELIVERY')) {
    status = 'out_for_delivery';
  } else if (cat === 'delivered' || statusText.includes('DELIVERED')) {
    status = 'delivered';
  } else if (cat === 'alert' || cat === 'return to sender' || statusText.includes('NOTICE') || statusText.includes('RETURN') || statusText.includes('UNDELIVERABLE') || statusText.includes('REFUSED') || statusText.includes('HELD')) {
    status = 'exception';
  }

  const events = (data.trackingEvents || []).slice(0, 10).map(e => ({
    date: e.eventTimestamp || null,
    description: e.eventType || '',
    city: e.eventCity || '',
    state: e.eventState || '',
  }));

  return { status, events, raw_status: data.status || '' };
}

async function trackUPS(trackingNumber) {
  const token = await getUPSToken();
  const res = await fetch('https://onlinetools.ups.com/api/track/v1/details/' + trackingNumber, {
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'transId': Date.now().toString(), 'transactionSrc': 'asylum' }
  });
  const data = await res.json();

  const shipment = data?.trackResponse?.shipment?.[0];
  const pkg = shipment?.package?.[0];
  if (!shipment && !pkg) throw new Error('UPS tracking returned no data: ' + JSON.stringify(data).substring(0, 500));

  const activities = pkg?.activity || shipment?.activity || [];
  const latestActivity = activities[0];
  const latestStatus = latestActivity?.status || {};
  const statusType = (latestStatus.type || '').toUpperCase();
  const statusDesc = (latestStatus.description || '').toUpperCase();

  const currentStatus = pkg?.currentStatus || {};
  const csType = (currentStatus.type || '').toUpperCase();
  const csDesc = (currentStatus.description || '').toUpperCase();

  const allDesc = statusDesc + ' ' + csDesc;
  const allType = statusType + ' ' + csType;

  let status = 'label_created';
  if (allType.includes('M') || allType.includes('P') || allDesc.includes('LABEL CREATED') || allDesc.includes('MANIFEST') || allDesc.includes('PICKUP SCAN') || allDesc.includes('ORDER PROCESSED') || allDesc.includes('SHIPPER CREATED')) {
    status = 'label_created';
  }
  if (allType.includes('I') || allDesc.includes('IN TRANSIT') || allDesc.includes('ON THE WAY') || allDesc.includes('DEPARTED') || allDesc.includes('ARRIVED') || allDesc.includes('ORIGIN SCAN') || allDesc.includes('PROCESSING') || allDesc.includes('DESTINATION SCAN')) {
    status = 'in_transit';
  }
  if (allDesc.includes('OUT FOR DELIVERY') || allDesc.includes('LOADED ON DELIVERY VEHICLE') || allDesc.includes('ON VEHICLE FOR DELIVERY')) {
    status = 'out_for_delivery';
  }
  if (allType.includes('D') || allDesc.includes('DELIVERED')) {
    status = 'delivered';
  }
  if (allType.includes('X') || allDesc.includes('EXCEPTION') || allDesc.includes('RETURNED') || allDesc.includes('UNDELIVERABLE')) {
    status = 'exception';
  }

  const events = activities.slice(0, 10).map(a => ({
    date: a.date && a.time ? a.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + 'T' + a.time.replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3') : a.date || null,
    description: a.status?.description || '',
    city: a.location?.address?.city || '',
    state: a.location?.address?.stateProvince || '',
  }));

  return { status, events, raw_status: latestStatus.description || currentStatus.description || '' };
}

async function trackFedEx(trackingNumber) {
  const token = await getFedExToken();
  const res = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: trackingNumber } }] })
  });
  const data = await res.json();
  const result = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!result) throw new Error('FedEx tracking returned no data: ' + JSON.stringify(data).substring(0, 500));
  if (result.error) throw new Error(result.error.message || 'FedEx tracking error');

  const fdxCode = (result.latestStatusDetail?.code || '').toUpperCase();
  const fdxDesc = (result.latestStatusDetail?.description || '').toUpperCase();

  let status = 'label_created';

  if (fdxCode === 'OC' || fdxCode === 'PX' || fdxDesc.includes('LABEL') || fdxDesc.includes('SHIPMENT INFORMATION') || fdxDesc.includes('CREATED') || fdxDesc.includes('INITIATED')) {
    status = 'label_created';
  }
  if (fdxCode === 'IT' || fdxCode === 'DP' || fdxCode === 'AR' || fdxCode === 'PU' || fdxCode === 'AF' || fdxCode === 'CC' || fdxCode === 'CD' || fdxCode === 'HL' || fdxCode === 'SP' || fdxCode === 'TR' ||
      fdxDesc.includes('IN TRANSIT') || fdxDesc.includes('PICKED UP') || fdxDesc.includes('ARRIVED') || fdxDesc.includes('DEPARTED') || fdxDesc.includes('AT FEDEX') || fdxDesc.includes('ON FEDEX') || fdxDesc.includes('CLEARANCE') || fdxDesc.includes('PROCESSING')) {
    status = 'in_transit';
  }
  if (fdxCode === 'OD' || fdxDesc.includes('ON VEHICLE FOR DELIVERY') || fdxDesc.includes('OUT FOR DELIVERY') || fdxDesc.includes('ON FEDEX VEHICLE')) {
    status = 'out_for_delivery';
  }
  if (fdxCode === 'DL' || fdxDesc.includes('DELIVERED')) {
    status = 'delivered';
  }
  if (fdxCode === 'DE' || fdxCode === 'SE' || fdxCode === 'CA' || fdxCode === 'RS' || fdxDesc.includes('EXCEPTION') || fdxDesc.includes('DELAY') || fdxDesc.includes('RETURN') || fdxDesc.includes('UNDELIVERABLE') || fdxDesc.includes('REFUSED')) {
    status = 'exception';
  }

  const events = (result.scanEvents || []).slice(0, 10).map(e => ({
    date: e.date || null,
    description: e.eventDescription || '',
    city: e.scanLocation?.city || '',
    state: e.scanLocation?.stateOrProvinceCode || '',
  }));

  return { status, events, raw_status: result.latestStatusDetail?.description || '' };
}

// ─────────────────────────────────────────
// CARRIER TRACKING — Route to correct carrier
// ─────────────────────────────────────────
async function trackPackage(carrier, trackingNumber) {
  switch (carrier) {
    case 'usps':
      throw new Error('USPS_MANUAL');
    case 'ups':
      if (!process.env.UPS_CLIENT_ID) throw new Error('UPS credentials not configured');
      return await trackUPS(trackingNumber);
    case 'fedex':
      if (!process.env.FEDEX_CLIENT_ID) throw new Error('FedEx credentials not configured');
      return await trackFedEx(trackingNumber);
    default:
      throw new Error('Carrier "' + carrier + '" does not support auto-tracking');
  }
}

// ─────────────────────────────────────────
// TRACK SINGLE SHIPMENT
// ─────────────────────────────────────────
app.get('/api/shipments/:id/track', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

    const { data: shipment, error: fetchErr } = await db.from('shipments').select('*').eq('id', req.params.id).single();
    if (fetchErr || !shipment) return res.status(404).json({ error: 'Shipment not found.' });
    if (!shipment.tracking_number) return res.status(400).json({ error: 'No tracking number.' });

    const result = await trackPackage(shipment.carrier, shipment.tracking_number);

    const { data: updated, error: updateErr } = await db.from('shipments')
      .update({
        status: result.status,
        tracking_details: JSON.stringify(result.events),
        last_tracked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, shipment: updated, tracking: result });
  } catch (err) {
    console.error('Tracking error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DEBUG — View raw carrier response (temporary)
// ─────────────────────────────────────────
app.get('/api/shipments/:id/track-debug', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data: shipment } = await db.from('shipments').select('*').eq('id', req.params.id).single();
    if (!shipment) return res.status(404).json({ error: 'Not found' });

    let rawResponse = {};
    if (shipment.carrier === 'ups') {
      const token = await getUPSToken();
      const r = await fetch('https://onlinetools.ups.com/api/track/v1/details/' + shipment.tracking_number, {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'transId': Date.now().toString(), 'transactionSrc': 'asylum' }
      });
      rawResponse = await r.json();
    } else if (shipment.carrier === 'fedex') {
      const token = await getFedExToken();
      const r = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: shipment.tracking_number } }] })
      });
      rawResponse = await r.json();
    } else if (shipment.carrier === 'usps') {
      const token = await getUSPSToken();
      const r = await fetch('https://apis.usps.com/tracking/v3/tracking/' + encodeURIComponent(shipment.tracking_number) + '?expand=DETAIL', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      rawResponse = await r.json();
    }
    res.json({ carrier: shipment.carrier, tracking_number: shipment.tracking_number, rawResponse });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// REFRESH ALL ACTIVE SHIPMENTS FOR USER
// ─────────────────────────────────────────
app.post('/api/shipments/refresh/:user_id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

    const { data: shipments, error } = await db.from('shipments')
      .select('*')
      .eq('user_id', req.params.user_id)
      .neq('status', 'delivered')
      .not('tracking_number', 'is', null);

    if (error) return res.status(500).json({ error: error.message });
    if (!shipments || !shipments.length) return res.json({ success: true, updated: 0 });

    let updatedCount = 0;
    const errors = [];
    for (const shipment of shipments) {
      if (!shipment.tracking_number) continue;
      if (!['usps', 'ups', 'fedex'].includes(shipment.carrier)) continue;

      try {
        const result = await trackPackage(shipment.carrier, shipment.tracking_number);

        await db.from('shipments').update({
          status: result.status,
          tracking_details: JSON.stringify(result.events),
          last_tracked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', shipment.id);

        updatedCount++;
      } catch (innerErr) {
        console.error('Track error for', shipment.carrier, shipment.tracking_number, innerErr.message);
        errors.push({ id: shipment.id, carrier: shipment.carrier, error: innerErr.message });
      }
    }

    const { data: refreshed } = await db.from('shipments')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('updated_at', { ascending: false });

    res.json({ success: true, updated: updatedCount, errors: errors, shipments: refreshed || [] });
  } catch (err) {
    console.error('Refresh tracking error:', err);
    res.status(500).json({ error: 'Failed to refresh tracking.' });
  }
});


// Targeted TCG debug
;


;



// ─── TEMP: TCG debug ───
;

async function fetchTCGPrice(name, setName, cardNumber, game) {
  try {
    const sport = (game || '').toLowerCase();
    let gameId = 'pokemon';
    if (sport.includes('one piece') || sport.includes('onepiece') || sport.includes('one-piece')) {
      gameId = 'one-piece-card-game';
    }

    // Clean card name — strip parenthetical notes like (Reprint), (Alternate Art), (Cosmo Holo)
    const cleanName = (name || '').replace(/\s*\([^)]*\)\s*/g, '').trim();

    // Detect bad/generic set names from imports that won't match anything
    const badSets = ['ascended heroes', 'miscellaneous cards & products', 'miscellaneous', 'promo', 'unknown'];
    const setIsUsable = setName && !badSets.some(b => (setName || '').toLowerCase().includes(b));

    // Search strategies: card number first (most precise), then name+set, then name alone
    const searches = [];
    if (cleanName && cardNumber) searches.push({ q: cleanName, number: cardNumber });
    if (cleanName && setIsUsable) searches.push({ q: `${cleanName} ${setName}` });
    if (cleanName)               searches.push({ q: cleanName });

    for (const params of searches) {
      const qs = new URLSearchParams({ q: params.q, game: gameId, limit: '10', include_statistics: '7d' });
      if (params.number) qs.set('number', params.number);
      const res = await fetch(`https://api.justtcg.com/v1/cards?${qs}`, {
        headers: { 'x-api-key': process.env.JUSTTCG_API_KEY }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const cards = data.data || [];
      if (!cards.length) continue;

      // Find best match — prefer card number match, then exact name
      let card = null;
      if (cardNumber) {
        const cn = cardNumber.toLowerCase().replace(/^0+/, '').trim();
        card = cards.find(c => (c.number || '').toLowerCase().replace(/^0+/, '').trim() === cn);
      }
      if (!card) card = cards.find(c => (c.name || '').toLowerCase() === cleanName.toLowerCase());
      if (!card) card = cards[0];

      const variants = card.variants || [];
      if (!variants.length) continue;

      // Prefer Near Mint Normal, fall back to first variant
      const nmVariant = variants.find(v =>
        (v.condition || '').toLowerCase().includes('near mint') &&
        (v.printing || '').toLowerCase().includes('normal')
      ) || variants[0];

      const nmPrices = variants
        .filter(v => (v.condition || '').toLowerCase().includes('near mint') && v.price)
        .map(v => parseFloat(v.price))
        .filter(p => p > 0)
        .sort((a, b) => a - b);

      const price = nmVariant.price ||
        (nmPrices.length ? nmPrices[Math.floor(nmPrices.length / 2)] : null);

      if (price) return parseFloat(price);
    }
    return null;
  } catch (e) { return null; }
}

async function fetchSportsPrice(playerName, setName, parallel, gradeCompany, grade) {
  try {
    const creds = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) return null;

    // Clean verbose Collectr set names
    const cleanSet = (setName || '')
      .replace(/ Autographs?$/i, '')
      .replace(/ Autograph$/i, '')
      .replace(/Us Olympic And Paralympic Hopefuls? /i, 'Olympic ')
      .replace(/Rookie Autograph$/i, 'RC Auto')
      .trim();

    // Try up to 3 progressively simpler queries
    const gradeStr = gradeCompany && grade ? `${gradeCompany} ${grade}` : null;
    const queries = [
      // Full: name + set + grade
      [playerName, cleanSet || null, gradeStr].filter(Boolean).join(' '),
      // Simpler: name + grade only
      [playerName, gradeStr].filter(Boolean).join(' '),
      // Simplest: name only
      playerName
    ];

    for (const query of queries) {
      if (!query.trim()) continue;

      // soldItemsOnly without condition filter — PSA graded cards sell as "New" on eBay
      const params = new URLSearchParams({
        q: query,
        filter: 'soldItemsOnly:true',
        sort: 'endingSoonest',
        limit: '5'
      });

      const browseRes = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json'
        }
      });
      if (!browseRes.ok) continue;
      const browseData = await browseRes.json();
      const items = browseData.itemSummaries || [];
      if (!items.length) continue;

      const prices = items
        .map(i => parseFloat(i?.price?.value || 0))
        .filter(p => p > 0);
      if (!prices.length) continue;

      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      return parseFloat(avg.toFixed(2));
    }
    return null;
  } catch (e) { return null; }
}


// ─────────────────────────────────────────
// PRICE UPDATE — single item endpoint
// Called from frontend "Refresh" button
// ─────────────────────────────────────────
app.post('/api/collection/:id/refresh-price', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data: item, error: fetchErr } = await db.from('collection_items').select('*').eq('id', req.params.id).single();
    if (fetchErr || !item) return res.status(404).json({ error: 'Item not found' });

    let newPrice = null;
    if (item.category === 'tcg_card' || item.category === 'sealed_tcg') {
      newPrice = await fetchTCGPrice(item.player_character || item.product_name, item.set_name, item.card_number, item.brand);
    } else if (item.category === 'sports_card') {
      newPrice = await fetchSportsPrice(item.player_character, item.set_name, item.parallel, item.grade_company, item.grade);
    }

    if (newPrice === null) return res.json({ success: false, message: 'Could not find price data' });

    const { data: updated } = await db.from('collection_items')
      .update({ estimated_value: newPrice, value_updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    res.json({ success: true, price: newPrice, item: updated });
  } catch (e) {
    res.status(500).json({ error: 'Price refresh failed' });
  }
});

// ─────────────────────────────────────────
// PRICE UPDATE — bulk cron endpoint
// Called by Vercel Cron every morning at 6am
// ─────────────────────────────────────────
app.get('/api/cron/update-prices', async (req, res) => {
  // Verify cron secret so random people can't spam it
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

    // Get all items not updated in last 23 hours
    const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const { data: items } = await db.from('collection_items')
      .select('id, category, player_character, product_name, set_name, brand, parallel, grade_company, grade')
      .in('category', ['tcg_card', 'sealed_tcg', 'sports_card'])
      .or(`value_updated_at.is.null,value_updated_at.lt.${cutoff}`)
      .limit(200); // Safety cap per run

    if (!items || !items.length) return res.json({ success: true, updated: 0 });

    let updated = 0, failed = 0;

    for (const item of items) {
      let newPrice = null;
      try {
        if (item.category === 'tcg_card' || item.category === 'sealed_tcg') {
          newPrice = await fetchTCGPrice(item.player_character || item.product_name, item.set_name, item.card_number, item.brand);
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 200));
        } else if (item.category === 'sports_card') {
          newPrice = await fetchSportsPrice(item.player_character, item.set_name, item.parallel, item.grade_company, item.grade);
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) { /* skip */ }

      if (newPrice !== null) {
        await db.from('collection_items')
          .update({ estimated_value: newPrice, value_updated_at: new Date().toISOString() })
          .eq('id', item.id);
        updated++;
      } else {
        failed++;
      }
    }

    res.json({ success: true, updated, failed, total: items.length });
  } catch (e) {
    res.status(500).json({ error: 'Bulk price update failed', details: e.message });
  }
});

// ─────────────────────────────────────────
// PORTFOLIOS — CRUD
// ─────────────────────────────────────────

// Get user's portfolios
app.get('/api/portfolios/:user_id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data, error } = await db.from('portfolios')
      .select('*, portfolio_items(count)')
      .eq('user_id', req.params.user_id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: 'Failed to load portfolios' }); }
});

// Create portfolio
app.post('/api/portfolios', async (req, res) => {
  const { user_id, name, description } = req.body;
  if (!user_id || !name) return res.status(400).json({ error: 'user_id and name required' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const shareToken = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    const { data, error } = await db.from('portfolios')
      .insert({ user_id, name: name.trim(), description: description || null, share_token: shareToken })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, portfolio: data });
  } catch (e) { res.status(500).json({ error: 'Failed to create portfolio' }); }
});

// Delete portfolio
app.delete('/api/portfolios/:id', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    await db.from('portfolio_items').delete().eq('portfolio_id', req.params.id);
    await db.from('portfolios').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete portfolio' }); }
});

// Get items in a portfolio
app.get('/api/portfolios/:id/items', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data: links } = await db.from('portfolio_items').select('collection_item_id').eq('portfolio_id', req.params.id);
    if (!links || !links.length) return res.json([]);
    const ids = links.map(l => l.collection_item_id);
    const { data: items } = await db.from('collection_items').select('*').in('id', ids);
    res.json(items || []);
  } catch (e) { res.status(500).json({ error: 'Failed to load portfolio items' }); }
});

// Add/remove item from portfolio
app.post('/api/portfolios/:id/items', async (req, res) => {
  const { collection_item_id, action } = req.body; // action: 'add' or 'remove'
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    if (action === 'remove') {
      await db.from('portfolio_items').delete()
        .eq('portfolio_id', req.params.id).eq('collection_item_id', collection_item_id);
    } else {
      await db.from('portfolio_items').upsert({ portfolio_id: req.params.id, collection_item_id });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update portfolio' }); }
});

// ─────────────────────────────────────────
// PORTFOLIO PUBLIC SHARE PAGE
// GET /share/:token — returns portfolio + items (no auth required)
// ─────────────────────────────────────────
app.get('/api/portfolios/share/:token', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
    const { data: portfolio } = await db.from('portfolios').select('*').eq('share_token', req.params.token).single();
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    const { data: links } = await db.from('portfolio_items').select('collection_item_id').eq('portfolio_id', portfolio.id);
    const ids = (links || []).map(l => l.collection_item_id);
    const items = ids.length ? (await db.from('collection_items').select('*').in('id', ids)).data || [] : [];
    // Strip user_id from response for privacy
    const safeItems = items.map(function(i) {
      const { user_id, ...rest } = i;
      return rest;
    });
    res.json({ portfolio: { id: portfolio.id, name: portfolio.name, description: portfolio.description, created_at: portfolio.created_at }, items: safeItems });
  } catch (e) { res.status(500).json({ error: 'Failed to load shared portfolio' }); }
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
