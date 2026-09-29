# TaskMint Website Starter

Standalone earning/rewards website. Telegram Mini App is not required.

## Deploy on Render
- Build command: `npm install`
- Start command: `npm start`
- Add `DATABASE_URL`
- Add a long random `JWT_SECRET`
- `NODE_ENV=production`

The app creates its own `tm_` tables so it can share an existing PostgreSQL database without changing the old Telegram tables.

## Current features
- Landing page
- Email/password registration and login
- JWT session
- User dashboard
- Balance and activity
- Referral code generation
- bKash/Nagad withdrawal request
- PostgreSQL storage

## Not yet enabled
- Real ad provider rewards
- Real task/offer provider callbacks
- Admin panel
- Automated payouts
- Email verification/password reset
- Fraud/risk engine

Do not credit users from client-side JavaScript. Provider reward events must be verified server-side before adding points.
