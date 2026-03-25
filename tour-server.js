const express = require('express');
const { chromium } = require('playwright');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());

// Multer setup for CSV uploads
const upload = multer({ dest: 'uploads/' });

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Returns a random integer between min and max (inclusive). Unit is caller's choice. */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Sleep for ms milliseconds */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Type text character-by-character with human-like delays (30–100 ms per char) */
async function humanType(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector); // focus the field
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(randomBetween(30, 100));
  }
}

/** Move mouse to a random position on the visible viewport */
async function randomMouseMove(page) {
  const x = randomBetween(100, 900);
  const y = randomBetween(100, 700);
  await page.mouse.move(x, y);
  await sleep(randomBetween(100, 300));
}

// ─── Core automation ────────────────────────────────────────────────────────

async function submitTourRequest({ name, lastName, phone, email, propertyUrl }) {
  let browser;
  const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

  try {
    log(`Launching browser for ${name} ${lastName} → ${propertyUrl}`);

    // FIX: Use browser.newContext(), not createBrowserContext()
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    // FIX: Set userAgent on context, not on page (Playwright API)
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Navigate
    log(`Navigating to property…`);
    await page.goto(propertyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(randomBetween(1500, 3000));

    // Simulate reading the page
    await randomMouseMove(page);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.4));
    await sleep(randomBetween(1000, 2000));
    await randomMouseMove(page);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.4));
    await sleep(randomBetween(800, 1500));

   // Click "Contact Building Directly" button
log('Looking for contact button...');
await sleep(3000); // let page fully render
await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button.Event_Contact_Directly_Button'));
  if (buttons.length > 0) buttons[0].click();
  else throw new Error('Contact button not found in DOM');
});
await sleep(randomBetween(2000, 3500));

    // Wait for chatbot textarea
    const CHAT_INPUT = 'textarea[placeholder*="Type the message"]';
    await page.waitForSelector(CHAT_INPUT, { timeout: 20000 });
    log(`Chatbot open. Starting form…`);

    // Helper: type into chatbot and send
    async function chatSend(text) {
      await randomMouseMove(page);
      await humanType(page, CHAT_INPUT, text);
      await sleep(randomBetween(400, 900));

      // FIX: Find the send button more robustly — look for a button near the textarea
      // Try common send-button patterns in order of specificity
      const sendSelectors = [
        'button[aria-label="Send"]',
        'button[aria-label="send"]',
        'button[title="Send"]',
        'form button[type="submit"]',
        // Fallback: press Enter (works in most chat widgets)
      ];

      let sent = false;
      for (const sel of sendSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            sent = true;
            break;
          }
        } catch (_) {}
      }

      if (!sent) {
        // Last resort: submit via Enter key
        await page.keyboard.press('Enter');
      }

      await sleep(randomBetween(1800, 3000));
    }

    // ── Submit each field ──
    log(`Entering first name: ${name}`);
    await chatSend(name);

    log(`Entering last name: ${lastName}`);
    await chatSend(lastName);

    log(`Entering phone: ${phone}`);
    await chatSend(phone);

    log(`Entering email: ${email}`);
    await chatSend(email);

    log(`SUCCESS — tour request submitted for ${name} ${lastName}`);
    await context.close();
    await browser.close();

    return {
      success: true,
      message: `Tour request submitted for ${name} ${lastName}`,
      property: propertyUrl,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    log(`ERROR — ${error.message}`);
    if (browser) await browser.close();
    return {
      success: false,
      error: error.message,
      property: propertyUrl,
      timestamp: new Date().toISOString()
    };
  }
}

// ─── CSV processing ─────────────────────────────────────────────────────────

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        // Normalise column names to lowercase, trim whitespace
        const normalised = {};
        for (const [k, v] of Object.entries(row)) {
          normalised[k.toLowerCase().trim()] = v ? v.trim() : '';
        }
        rows.push(normalised);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

/** Map flexible CSV column names → internal field names */
function mapRow(row) {
  return {
    name:        row['first name'] || row['firstname'] || row['first_name'] || row['name'] || '',
    lastName:    row['last name']  || row['lastname']  || row['last_name']  || row['surname'] || '',
    email:       row['email'] || row['email address'] || '',
    phone:       row['phone'] || row['phone number']  || row['phonenumber'] || row['mobile'] || '',
    propertyUrl: row['url']   || row['link']          || row['property url'] || row['property_url'] || row['building url'] || ''
  };
}

// ─── Job queue ───────────────────────────────────────────────────────────────
// Simple in-memory queue so jobs survive within a session and status is trackable.

const jobs = {}; // jobId → { status, results, total, done, errors }

async function runQueue(jobId, rows) {
  jobs[jobId].status = 'running';

  for (let i = 0; i < rows.length; i++) {
    const entry = mapRow(rows[i]);

    // Validate required fields
    if (!entry.name || !entry.lastName || !entry.email || !entry.phone || !entry.propertyUrl) {
      jobs[jobId].results.push({
        row: i + 1,
        success: false,
        error: 'Missing required field(s)',
        data: entry
      });
      jobs[jobId].done++;
      continue;
    }

    // Wait 60–90 seconds between submissions (skip wait before the very first one)
    if (i > 0) {
      const waitSec = randomBetween(60, 90);
      console.log(`[Job ${jobId}] Waiting ${waitSec}s before row ${i + 1}…`);
      jobs[jobId].nextIn = waitSec;
      await sleep(waitSec * 1000);
    }

    jobs[jobId].nextIn = null;
    const result = await submitTourRequest(entry);
    jobs[jobId].results.push({ row: i + 1, ...result });
    jobs[jobId].done++;

    if (!result.success) jobs[jobId].errors++;
  }

  jobs[jobId].status = 'complete';
  console.log(`[Job ${jobId}] All ${rows.length} rows processed.`);
}

// ─── API Routes ──────────────────────────────────────────────────────────────

/**
 * POST /submit-csv
 * Upload a CSV file with columns: first name, last name, email, phone, url
 */
app.post('/submit-csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded. Use field name "file".' });
  }

  let rows;
  try {
    rows = await parseCSV(req.file.path);
    fs.unlinkSync(req.file.path); // clean up temp file
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse CSV: ${err.message}` });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV file is empty.' });
  }

  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', results: [], total: rows.length, done: 0, errors: 0, nextIn: null };

  // Run queue asynchronously — don't block the response
  runQueue(jobId, rows).catch(err => {
    jobs[jobId].status = 'failed';
    jobs[jobId].fatalError = err.message;
  });

  res.json({
    jobId,
    message: `Job queued. Processing ${rows.length} tour request(s) with 60–90s delays between each.`,
    statusUrl: `/job/${jobId}`
  });
});

/**
 * POST /submit-one
 * Submit a single tour request (JSON body)
 */
app.post('/submit-one', async (req, res) => {
  const { name, lastName, phone, email, propertyUrl } = req.body;
  if (!name || !lastName || !phone || !email || !propertyUrl) {
    return res.status(400).json({ error: 'Missing required fields: name, lastName, phone, email, propertyUrl' });
  }

  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', results: [], total: 1, done: 0, errors: 0, nextIn: null };

  runQueue(jobId, [{ 'first name': name, 'last name': lastName, phone, email, url: propertyUrl }]);

  res.json({
    jobId,
    message: 'Tour request queued.',
    statusUrl: `/job/${jobId}`
  });
});

/**
 * GET /job/:jobId
 * Check the status and results of a job
 */
app.get('/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

/**
 * GET /jobs
 * List all jobs
 */
app.get('/jobs', (req, res) => {
  res.json(jobs);
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SpotEasy Tour Server running on port ${PORT}`);
  console.log(`  POST /submit-csv   — upload a CSV file`);
  console.log(`  POST /submit-one   — single JSON request`);
  console.log(`  GET  /job/:id      — check job status`);
  console.log(`  GET  /health       — health check`);
});
