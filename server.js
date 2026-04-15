const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function supabase(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {})
    }
  });
  return res.json();
}

// ─── Auth: Sign Up ─────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await supabase('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Auth: Sign In ─────────────────────────────────────────────────
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  try {
    const data = await supabase('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ user: data.user, session: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Usage: Check ─────────────────────────────────────────────────
app.post('/api/usage/check', async (req, res) => {
  const { userId } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const DAILY_LIMIT = 5;

  try {
    const rows = await supabase(
      `/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=*`,
      { method: 'GET' }
    );
    const usage = Array.isArray(rows) ? rows[0] : null;
    const count = usage ? usage.count : 0;
    res.json({ count, limit: DAILY_LIMIT, allowed: count < DAILY_LIMIT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pro Status Check ──────────────────────────────────────────────
app.post('/api/pro/check', async (req, res) => {
  const { userId } = req.body;
  try {
    const rows = await supabase(
      `/rest/v1/subscribers?user_id=eq.${userId}&select=*`,
      { method: 'GET' }
    );
    const sub = Array.isArray(rows) ? rows[0] : null;
    const isPro = sub && sub.status === 'active';
    res.json({ isPro });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stripe: Create Checkout Session ──────────────────────────────
app.post('/api/stripe/checkout', async (req, res) => {
  const { userId, email } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}&user_id=${userId}`,
      cancel_url: `${req.headers.origin}/?cancelled=true`,
      metadata: { userId }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stripe: Webhook ──────────────────────────────────────────────
app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    try {
      const existing = await supabase(
        `/rest/v1/subscribers?user_id=eq.${userId}&select=*`,
        { method: 'GET' }
      );
      const sub = Array.isArray(existing) ? existing[0] : null;

      if (sub) {
        await supabase(`/rest/v1/subscribers?id=eq.${sub.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: 'active'
          })
        });
      } else {
        await supabase('/rest/v1/subscribers', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: 'active'
          })
        });
      }
    } catch (err) {
      console.error('Supabase update error:', err.message);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    try {
      await supabase(
        `/rest/v1/subscribers?stripe_subscription_id=eq.${subscription.id}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'inactive' })
        }
      );
    } catch (err) {
      console.error('Subscription cancel error:', err.message);
    }
  }

  res.json({ received: true });
});

// ─── Generate ─────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { messages, userId } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const DAILY_LIMIT = 5;

  try {
    if (userId) {
      const subRows = await supabase(
        `/rest/v1/subscribers?user_id=eq.${userId}&select=*`,
        { method: 'GET' }
      );
      const sub = Array.isArray(subRows) ? subRows[0] : null;
      const isPro = sub && sub.status === 'active';

      if (!isPro) {
        const rows = await supabase(
          `/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=*`,
          { method: 'GET' }
        );
        const usage = Array.isArray(rows) ? rows[0] : null;
        const count = usage ? usage.count : 0;

        if (count >= DAILY_LIMIT) {
          return res.status(429).json({
            error: 'daily_limit_reached',
            message: 'You have used your 5 free messages today.'
          });
        }
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages
      })
    });

    const data = await response.json();

    if (userId) {
      const subRows = await supabase(
        `/rest/v1/subscribers?user_id=eq.${userId}&select=*`,
        { method: 'GET' }
      );
      const sub = Array.isArray(subRows) ? subRows[0] : null;
      const isPro = sub && sub.status === 'active';

      if (!isPro) {
        const rows = await supabase(
          `/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=*`,
          { method: 'GET' }
        );
        const usage = Array.isArray(rows) ? rows[0] : null;

        if (usage) {
          await supabase(`/rest/v1/usage?id=eq.${usage.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ count: usage.count + 1 })
          });
        } else {
          await supabase('/rest/v1/usage', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: userId, date: today, count: 1 })
          });
        }
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NIMP running on port ${PORT}`));
