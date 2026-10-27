# RiskGuard — User Guide

> How a trader uses each module of RiskGuard.

## Getting Started

1. **Register** at `/register` with your name + email + a strong password.
2. **Verify your email** — click the link in the verification email (in dev, check the server console).
3. **Complete onboarding** — set your base currency, timezone, create your first trading account, and set your initial risk profile.
4. **Start trading** — you're now on the dashboard.

## Dashboard

The dashboard is your home base. It shows:

- **Balance** — current account balance.
- **Today/Week/Month P/L** — your P/L for each period.
- **Win rate** — your win rate across all closed trades.
- **Profit factor** — gross profit / gross loss (>1 = profitable).
- **Current streak** — consecutive wins (+) or losses (-).
- **Equity curve** — a mini chart of your balance over the last 100 trades.
- **Risk Meter** — progress bars showing daily loss used, trades today, open trades, and loss streak.
- **Last 10 trades** — quick view of recent trades with direction, asset, result, and P/L.

## Trade Journal (`/app/trades`)

### Adding a trade

1. Scroll to the "Quick add trade" form (or click "Add trade" for a modal).
2. Select the **account** you're trading on.
3. Search for an **asset** (type to filter — EUR/USD, BTC/USD, OTC pairs, etc.) or type your own.
4. Pick **direction** — CALL (green ▲) or PUT (red ▼).
5. Enter your **stake** — or click the suggested stake from your default staking plan.
6. Enter the **payout %** (e.g., 0.85 for 85% broker payout).
7. Set the **expiry** in minutes (quick presets available).
8. Optionally select a **strategy**, **timeframe**, and **emotion**.
9. Toggle **"I followed my plan"** — be honest.
10. Upload a **screenshot** (optional, max 5 MB).
11. Add **notes** and **tags** (press Enter to add a tag).
12. The live preview shows your potential profit, loss, risk %, and break-even win rate.
13. Click **Open trade**.

### Quick-closing a trade

When a trade expires:

1. Find the OPEN trade in the trades table.
2. Click the green ✓ (WIN), red ✗ (LOSS), or gray − (TIE).
3. The P/L is computed automatically: WIN = +stake × payout, LOSS = -stake, TIE = 0.
4. The balance + equity walk are recomputed atomically.

### Filtering trades

Use the filter bar above the table:

- **Date range** — pick a start/end date.
- **Asset** — filter by asset name (text search).
- **Result** — WIN, LOSS, TIE, or OPEN.
- **Strategy** — filter by strategy.
- **Emotion** — filter by emotional state.
- **Followed plan** — "Followed plan" or "Broke plan".
- **Tag** — filter by tag text.

### Bulk delete

1. Check the boxes next to trades you want to delete.
2. Click "Bulk delete" in the warning toolbar.
3. Confirm — the balance + equity walk are recomputed.

## Accounts & Cash Flow (`/app/accounts`)

### Creating an account

1. Click "New account".
2. Enter a name (e.g., "Quotex Demo"), broker, currency, type (DEMO/REAL), and starting balance.
3. Click "Create" — the account is created and made active.

### Recording transactions

1. Open an account's detail page.
2. Click "Add transaction".
3. Select the type: DEPOSIT, WITHDRAWAL, BONUS, or ADJUSTMENT.
4. Enter the amount + date + note.
5. Click "Record" — the balance is recomputed atomically.

### Reconciling balance

1. Open the account detail page.
2. Click "Reconcile".
3. Enter the balance your broker shows.
4. Preview the difference.
5. If non-zero, click "Create adjustment" — an ADJUSTMENT transaction is created.

### Archive/Restore

- Click the archive icon (📦) on a card to hide it from the active list.
- Toggle "Show archived" to see + restore archived accounts.

## Risk Rules (`/app/risk-rules`)

### Editing your risk profile

1. Navigate to `/app/risk-rules`.
2. Edit any of the 9 fields:
   - **Risk per trade %** — max stake as % of balance.
   - **Max daily loss %** — auto-lockout when hit.
   - **Max daily loss amount** — flat currency cap (optional).
   - **Daily profit target %** — stop-when-ahead.
   - **Max trades per day** — block new trades after this many.
   - **Max consecutive losses** — auto-cooldown when hit.
   - **Cooldown minutes** — how long the consec-loss lockout lasts.
   - **Max open trades** — block new trades when this many are OPEN.
   - **Weekly loss limit %** — lockout until next week start.
3. Click "Save risk profile".

### Manual lockout

1. Click "I need a break".
2. Pick a duration (15 min / 1 hour / 4 hours / 1 day).
3. Optionally add a reason.
4. Click "Lock" — a banner appears on every page with a countdown.

### Overriding a lockout

1. Click "Override" in the lockout banner.
2. Type the exact phrase: "I understand the risk".
3. Write a reason (≥5 characters).
4. Click "Confirm override" — the override is logged in your audit trail.

## Stake Calculator (`/app/stake-calculator`)

1. Enter your **balance**, **risk %**, **payout %**, and **win-rate estimate**.
2. See the **recommended stake**, **potential profit/loss**, **break-even win %**, **losses-to-ruin**, and **expectancy**.
3. Compare **Kelly variants** — Full (aggressive), Half (recommended), Quarter (conservative).
4. **Save staking plans** — create plans with different methods (FIXED_AMOUNT, FIXED_PERCENT, COMPOUNDING, ANTI_MARTINGALE, FIBONACCI, MARTINGALE, KELLY_FRACTION, CUSTOM).
5. Set a **default plan** — used for the "next stake" suggestion in the Add Trade form.
6. **Run Monte Carlo simulation** — 1,000 × 100 trades. See the distribution of ending balances, chance of ruin, and median drawdown.

⚠️ **Martingale is OFF by default** with a red warning + worst-case exposure + probability of hitting the cap.

## Analytics (`/app/analytics`)

1. Use the **filter bar** to select a date range, account, and strategy.
2. View the **summary stats** — net P/L, win rate, profit factor, expectancy, averages, drawdown, recovery factor, streaks.
3. See the **equity curve** chart.
4. Read the **Insights panel** — rule-based findings like "REVENGE trades cost you $X" or "You lose 70% after 2 consecutive losses".
5. Compare the **current period vs previous period**.
6. Browse **win rate breakdowns** by asset, strategy, hour, weekday, emotion, and direction.

## Goals & Sessions (`/app/goals`)

### Goals

1. Click "New goal".
2. Select type (Daily, Weekly, Monthly, Balance target).
3. Enter the target amount + end date.
4. The **realistic-check** warns if the target requires >10% daily growth (unsustainable).
5. Progress bars update automatically as you add trades.

### Trading sessions

1. **Complete the pre-trade checklist** (tick all items).
2. Select your **mood**.
3. Click **"Start session"** — records start balance + mood.
4. Trade normally — trades are auto-linked by time window.
5. Click **"End session"** — records end balance + notes.
6. The session summary shows P/L, win rate, trade count, and plan breaches.

### Compounding planner

1. Enter your **daily growth %** and **number of days**.
2. Optionally select a **withdrawal rule** (none / % of profit / fixed $/day).
3. See the projected balance growth table + summary cards (final balance, total growth %, total withdrawn).

## Reports (`/app/reports`)

1. Select a preset (Daily, Weekly, Monthly) or use the custom range via the Analytics page.
2. View the **printable report** — summary stats, discipline, equity curve, best/worst assets, rule breaches, notes.
3. Click **"Print / PDF"** to print or save as PDF (uses the browser's print dialog).
4. Export **Trades CSV**, **Trades XLSX**, or **Transactions CSV**.
5. **Import CSV** — paste CSV data, map columns, preview, validate, import with dedup.
6. **Backup** — export a full JSON backup or restore from a pasted JSON.

## Settings (`/app/settings`)

- **Account details** — name, timezone, base currency.
- **Notification preferences** — per-type in-app + email toggles (7 alert types).
- **Trading hours** — start/end time + active days.
- **Default staking plan** — set which plan is used for the "next stake" suggestion.
- **Change password**.
- **Delete account** — requires typing "DELETE MY ACCOUNT" exactly. Cascades through all tables.
