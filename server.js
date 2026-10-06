import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'projectforge.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  ai_uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
`);

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    subscription_status: user.subscription_status,
    ai_uses: user.ai_uses
  };
}

function signToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const token = req.cookies.projectforge_token;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ]);
    if (!allowed.has(file.mimetype)) return cb(new Error('Only PDF, DOCX and TXT files are supported.'));
    cb(null, true);
  }
});

async function extractText(file) {
  if (!file) return '';
  if (file.mimetype === 'text/plain') return file.buffer.toString('utf8');
  if (file.mimetype === 'application/pdf') {
    const parsed = await pdfParse(file.buffer);
    return parsed.text;
  }
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  return '';
}

function parseJsonFromModel(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openai),
    stripeConfigured: Boolean(stripe),
    time: new Date().toISOString()
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.cookie('projectforge_token', signToken(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: PUBLIC_URL.startsWith('https://'),
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  res.cookie('projectforge_token', signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: PUBLIC_URL.startsWith('https://'),
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('projectforge_token');
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/assignment', authRequired, upload.single('file'), async (req, res) => {
  try {
    if (!openai) return res.status(503).json({ error: 'OpenAI is not configured on the server.' });

    const topic = String(req.body.topic || '').trim();
    const requirements = String(req.body.requirements || '').trim();
    const notes = String(req.body.notes || '').trim();
    const subject = String(req.body.subject || '').trim();

    let fileText = '';
    if (req.file) fileText = await extractText(req.file);
    fileText = fileText.slice(0, 30000);

    if (!topic && !requirements && !fileText) {
      return res.status(400).json({ error: 'Add an assignment topic, requirements, or upload a file.' });
    }

    const prompt = `You are ProjectForge, an academic planning assistant.
Help the student understand and plan their own assignment. Do not claim to have submitted or completed the assignment for them.
Return ONLY valid JSON with these keys:
summary (string),
requirements (array of strings),
outline (array of objects with title and what_to_do),
research_questions (array of strings),
review_checklist (array of strings),
next_steps (array of strings).

Subject: ${subject}
Topic: ${topic}
Requirements typed by student: ${requirements}
Student notes: ${notes}
Uploaded assignment text: ${fileText || '(none)'}`;

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-6-luna',
      input: prompt
    });

    const plan = parseJsonFromModel(response.output_text);
    db.prepare('UPDATE users SET ai_uses = ai_uses + 1 WHERE id = ?').run(req.user.id);
    res.json({ plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'The assignment could not be processed. Check the file and try again.' });
  }
});

app.post('/api/create-checkout-session', authRequired, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on the server.' });
    const priceId = process.env.STRIPE_STUDENT_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: 'The Student Stripe price is not configured.' });

    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_URL}/?payment=success`,
      cancel_url: `${PUBLIC_URL}/?payment=cancelled`,
      metadata: { userId: String(req.user.id) }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start Stripe Checkout.' });
  }
});

function applySubscription(subscription, customerId) {
  const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
  if (!user) return;
  const active = ['active', 'trialing', 'past_due'].includes(subscription.status);
  db.prepare(`
    UPDATE users
    SET stripe_subscription_id = ?, plan = ?, subscription_status = ?
    WHERE id = ?
  `).run(subscription.id, active ? 'student' : 'free', subscription.status, user.id);
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook is not configured.');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = Number(session.metadata?.userId || 0);
      if (userId && session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        db.prepare(`
          UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, subscription_status = ?
          WHERE id = ?
        `).run(session.customer, subscription.id, 'student', subscription.status, userId);
      }
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      applySubscription(event.data.object, event.data.object.customer);
    }

    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Webhook processing failed.');
  }
});

app.use(express.static(path.join(__dirname, '..')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Request failed.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ProjectForge running at ${PUBLIC_URL}`);
});
