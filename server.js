const express = require('express');
const app = express();

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

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;