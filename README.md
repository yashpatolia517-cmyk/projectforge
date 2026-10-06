# ProjectForge — complete AI + payments starter

ProjectForge is a single Node/Express app that serves the website and API together.

Included:
- Account registration/login/logout
- SQLite user database
- Password hashing
- AI assignment planning with OpenAI Responses API
- PDF, DOCX and TXT assignment upload/extraction
- Stripe Checkout subscription flow
- Stripe webhook subscription status syncing
- Student-plan access checks
- AI usage tracking
- Health endpoint
- Render-friendly deployment
- Frontend served by the same backend, so `/api/*` works without CORS setup

## 1. Local setup

Install Node.js 20+.

```bash
npm install
copy .env.example .env
npm start
```

On macOS/Linux use `cp .env.example .env`.

Open `http://localhost:3000`.

## 2. Environment variables

Set:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-6-luna`)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STUDENT_PRICE_ID`
- `JWT_SECRET`
- `PUBLIC_URL`
- `PORT`

Never put API or Stripe secret keys in frontend JavaScript or GitHub.

## 3. Stripe

Create a Product in Stripe, then create a recurring monthly Price for the Student plan.

Put that Price ID into `STRIPE_STUDENT_PRICE_ID`.

Create a webhook endpoint:
`https://YOUR-DOMAIN/api/stripe/webhook`

Subscribe to:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`.

Use Stripe test mode while testing.

## 4. OpenAI

Create an API key and put it in `OPENAI_API_KEY`.

The server calls OpenAI; the key is never sent to the browser.

## 5. Render

Create a Render Web Service from this repository.

Build command:
`npm install`

Start command:
`npm start`

Add the environment variables above in Render.

After deploy:
`https://YOUR-APP.onrender.com/api/health`

## 6. Important production notes

This starter is designed to give you a working end-to-end foundation. Before a large public launch, add:
- email verification
- password reset
- rate limiting / bot protection
- stronger file scanning and storage policies
- a production database if SQLite is not appropriate for your hosting plan
- privacy policy and terms
- proper billing/customer portal flows
- monitoring and backups

Do not commit `.env`.
