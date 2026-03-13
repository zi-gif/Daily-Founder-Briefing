# ScOp Daily Founder Call Briefing — Setup Guide

## What you're building

An automated system that emails you a briefing before every founder call on your calendar. It runs on Google Apps Script (free, inside your Google account) and uses the Claude API to generate company summaries, founder bios, and industry term definitions.

---

## Step-by-step setup

### Step 1: Create the Google Apps Script project

1. Go to **[script.google.com](https://script.google.com)**
2. Click **"New project"** (top left)
3. Rename it to **"Daily Founder Briefing"**
4. **Select all** the placeholder code in `Code.gs` and **delete** it
5. **Paste** in the contents of the `Code.gs` file I provided
6. Press **Ctrl+S / Cmd+S** to save

### Step 2: Get your Claude (Anthropic) API key

1. Go to **[console.anthropic.com](https://console.anthropic.com)**
2. Sign up or log in
3. Go to **API Keys** → **Create Key** → name it "ScOp Briefing"
4. **Copy the key** (you only see it once)

### Step 3: Set up Google Custom Search (important for quality)

This is what makes the research actually work. Free tier gives you 100 searches/day.

1. Go to **[programmablesearchengine.google.com](https://programmablesearchengine.google.com/controlpanel/all)**
2. Click **"Add"** to create a new search engine
3. Under "What to search": select **"Search the entire web"**
4. Name it anything (e.g., "ScOp Research")
5. Click **Create** → you'll see your **Search Engine ID** (cx). Copy it.
6. Go to **[console.cloud.google.com](https://console.cloud.google.com)**
7. Create a project (or use an existing one)
8. Go to **APIs & Services → Library** → search for **"Custom Search API"** → **Enable** it
9. Go to **APIs & Services → Credentials** → **Create Credentials → API Key**
10. Copy this API key

### Step 4: Add all three keys to Script Properties

In the Apps Script editor:

1. Click **⚙ Project Settings** (gear icon, left sidebar)
2. Scroll to **Script Properties**
3. Add these three properties:

| Property | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Claude API key from Step 2 |
| `GOOGLE_CSE_API_KEY` | Your Google API key from Step 3.9 |
| `GOOGLE_CSE_ID` | Your Search Engine ID from Step 3.5 |

### Step 5: Test it

1. Back in the Editor, make sure the function dropdown says **`main`** (not `myFunction`)
2. Click **▶ Run**
3. **First time only:** a permissions dialog appears — click through:
   - "Review permissions" → choose your account → "Advanced" → "Go to Daily Founder Briefing (unsafe)" → "Allow"
4. Check your inbox for the briefing email

If something fails, click **Executions** in the left sidebar to see logs.

### Step 6: Set up the automatic daily trigger

1. Click **⏰ Triggers** (clock icon, left sidebar)
2. Click **"+ Add Trigger"**
3. Configure:
   - **Function:** `main`
   - **Deployment:** Head
   - **Event source:** Time-driven
   - **Type:** Day timer
   - **Time of day:** 8am to 9am
4. Click **Save**

---

## What changed in v2

- **Google Custom Search API** replaces raw Google scraping — reliable, structured results, no CAPTCHAs
- **Smarter website fetching** — tries `/about`, `/about-us`, `/team` subpages; extracts meta tags (these work even on JS-heavy sites)
- **No more Zi Pan in bios** — you're filtered out automatically
- **Concise output** — Claude now writes "N/A" when info is missing instead of verbose filler paragraphs
- **Better browser User-Agent** — sites are less likely to block the requests

---

## Configuration

Edit the `CONFIG` object at the top of `Code.gs`:

| Setting | Default | What it does |
|---------|---------|-------------|
| `RECIPIENT_EMAIL` | zi@scopvc.com | Who gets the email |
| `INTERNAL_DOMAIN` | scopvc.com | Emails from this domain = internal |
| `KNOWN_INTERNALS` | zi, ziang.pan, mtucker | Always excluded from founder bios |
| `SEND_IF_NO_CALLS` | false | Set `true` for a "no calls today" email |
| `CLAUDE_MODEL` | claude-sonnet-4-6 | Use `claude-haiku-4-5-20251001` for faster/cheaper |

---

## Known limitations

- **LinkedIn bios are limited.** LinkedIn blocks scraping, so we rely on Google search snippets that preview LinkedIn profiles. Sometimes this yields enough (name, headline, current role), sometimes not. For better founder data, consider a paid enrichment API like Proxycurl (~$0.01/lookup).
- **JS-heavy websites** still return limited content. The meta tag extraction helps, but some sites are completely client-rendered. Google Custom Search snippets usually fill the gap.
- **6-minute execution limit.** Google Apps Script kills scripts after 6 min. Unlikely to hit with typical call volume (5-6 calls/day is fine).
- **Trigger timing.** "8am to 9am" means the email arrives somewhere in that window.
- **100 searches/day free.** Each founder call uses ~5-7 searches. So ~14 calls/day is the free tier limit. More than enough for typical usage.
