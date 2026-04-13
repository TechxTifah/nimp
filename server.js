const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Supabase config ───────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Helper: call Supabase REST API
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

// ─── Usage: Check + Increment (logged-in users) ────────────────────
// Expects: { userId } in body
// Returns: { count, limit, allowed }
app.post('/api/usage/check', async (req, res) => {
  const { userId } = req.body;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const DAILY_LIMIT = 5;

  try {
    // Look for today's usage row
    const rows = await supabase(
      `/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=*`,
      { method: 'GET' }
    );

    const usage = Array.isArray(rows) ? rows[0] : null;
    const count = usage ? usage.count : 0;
    const allowed = count < DAILY_LIMIT;

    res.json({ count, limit: DAILY_LIMIT, allowed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Usage: Increment after generation ────────────────────────────
app.post('/api/usage/increment', async (req, res) => {
  const { userId } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    const rows = await supabase(
      `/rest/v1/usage?user_id=eq.${userId}&date=eq.${today}&select=*`,
      { method: 'GET' }
    );

    const usage = Array.isArray(rows) ? rows[0] : null;

    if (usage) {
      // Update existing row
      await supabase(
        `/rest/v1/usage?id=eq.${usage.id}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ count: usage.count + 1 })
        }
      );
    } else {
      // Create new row for today
      await supabase('/rest/v1/usage', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: userId, date: today, count: 1 })
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Generate: Main AI route ───────────────────────────────────────
// Now checks usage before calling Anthropic
app.post('/api/generate', async (req, res) => {
  const { messages, userId } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const DAILY_LIMIT = 5;

  try {
    // If logged in, enforce server-side limit
    if (userId) {
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

    // Call Anthropic
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

    // Increment usage if logged in
    if (userId) {
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

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Server ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NIMP running on port ${PORT}`));
