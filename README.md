# Trade Tracker

A mobile-friendly web app for tracking your TastyTrade options trades. Upload a transactions CSV to see deposits, open/closed positions, P&L, and your full ledger.

## Features

- **Account balance** — net balance from deposits + all trade P&L
- **Deposits** — all money movements, interest, and adjustments
- **Open trades** — every currently open position leg with cost and fees
- **Closed trades** — grouped by symbol with open cost, close value, commissions, fees, and net P&L
- **Monthly P&L chart** — visual breakdown of performance by month
- **All transactions** — full searchable/filterable ledger
- Works on desktop and mobile (installable as a PWA)

---

## Deploying to GitHub Pages (step by step)

### Step 1 — Create a GitHub account

Go to [github.com](https://github.com) and sign up if you don't have an account.

### Step 2 — Create a new repository

1. Click the **+** button (top right) → **New repository**
2. Name it `trade-tracker` (or anything you like)
3. Set it to **Public**
4. Click **Create repository**

### Step 3 — Upload your files

On the new repository page:

1. Click **uploading an existing file** (or drag the files onto the page)
2. Upload all files from this folder:
   - `index.html`
   - `style.css`
   - `app.js`
   - `manifest.json`
   - `icons/icon-192.png`
   - `icons/icon-512.png`
3. Scroll down, click **Commit changes**

> For the icons folder: GitHub's web uploader supports drag-and-drop of folders. Just drag the `icons/` folder onto the upload page.

### Step 4 — Enable GitHub Pages

1. In your repository, click **Settings** (top tab)
2. In the left sidebar, click **Pages**
3. Under **Branch**, select `main` (or `master`) and `/ (root)`
4. Click **Save**

GitHub will show you a URL like:
```
https://YOUR-USERNAME.github.io/trade-tracker/
```

It takes about 1–2 minutes to go live. Refresh the Pages settings page to see the live URL appear.

### Step 5 — Add to your phone home screen

**iPhone (Safari):**
1. Open the URL in Safari
2. Tap the **Share** button (box with arrow)
3. Scroll down → tap **Add to Home Screen**
4. Tap **Add** — it now appears as an app icon

**Android (Chrome):**
1. Open the URL in Chrome
2. Tap the **⋮** menu (top right)
3. Tap **Add to Home screen**
4. Tap **Add**

---

## Updating the app

To update after changes:

1. Go to your repository on GitHub
2. Click the file you want to update → click the **pencil** (edit) icon
3. Paste in the new content → click **Commit changes**

Or use the GitHub web uploader to replace files.

---

## Using the app

1. Open your TastyTrade account → **History** → export as CSV
2. Open the web app
3. Tap **Upload CSV** and select your file
4. Explore the tabs — Summary, Deposits, Open Trades, Closed Trades, All Transactions

Your data never leaves your device. Everything is processed in the browser.
