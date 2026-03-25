const express = require('express');
const { chromium } = require('playwright');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function humanType(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(randomBetween(30, 100));
  }
}

async function randomMouseMove(page) {
  await page.mouse.move(randomBetween(100, 900), randomBetween(100, 700));
  await sleep(randomBetween(100, 300));
}

async function submitTourRequest({ name, lastName, phone, email, propertyUrl }) {
  let browser;
  const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

  try {
    log(`Launching browser for ${name} ${lastName} -> ${propertyUrl}`);

    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    log(`Navigating to property...`);
    await page.goto(propertyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(randomBetween(5000, 7000));

    await randomMouseMove(page);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.4));
    await sleep(randomBetween(1000, 2000));
    await randomMouseMove(page);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.4));
    await sleep(randomBetween(1000, 2000));

    log(`Clicking contact button...`);
    await sleep(3000);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.Event_Contact_Directly_Button');
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });
    if (!clicked) throw new Error('Could not find Contact Building Directly button');
    await sleep(randomBetween(4000, 6000));

    await page.screenshot({ path: '/tmp/after-click.png' });
    const imgBase64 = fs.readFileSync('/tmp/after-click.png').toString('base64');
    log('SCREENSHOT_BASE64_START');
    console.log(imgBase64.substring(0, 500));
    log('SCREENSHOT_BASE64_END');

    const CHAT_INPUT = 'textarea[placeholder*="Type the message"]';
    await page.waitForSelector(CHAT_INPUT, { timeout: 20000 });
    log(`Chatbot open. Starting form...`);

    async function chatSend(text) {
      await randomMouseMove(page);
      await humanType(page, CHAT_INPUT, text);
      await sleep(randomBetween(400, 900));
      const sendSelectors = [
        'button[aria-label="Send"]',
        'button[aria-label="send"]',
        'button[title="Send"]',
        'form button[type="submit"]'
      ];
      let sent = false;
      for (const sel of sendSelectors) {
        try { const b = await page.$(sel); if (b) { await b.click(); sent = true; break; } } catch (_) {}
      }
      if (!sent) await page.keyboard.press('Enter');
      await sleep(randomBetween(1800, 3000));
    }

    log(`Entering first name: ${name}`);
    await chatSend(name);
    log(`Entering last name: ${lastName}`);
    await chatSend(lastName);
    log(`Entering phone: ${phone}`);
    await chatSend(phone);
    log(`Entering email: ${email}`);
    await chatSend(email);

    log(`SUCCESS - tour request submitted for ${name} ${lastName}`);
    await context.close();
    await browser.close();

    return { success: true, message: `Tour request submitted for ${name} ${lastName}`, property: propertyUrl, timestamp: new Date().toISOString() };

  } catch (error) {
    log(`ERROR - ${error.message}`);
    if (browser) await browser.close();
    return { success: false, error: error.message, property: propertyUrl, timestamp: new Date().toISOString() };
  }
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        const n = {};
        for (const [k, v] of Object.entries(row)) n[k.toLowerCase().trim()] = v ? v.trim() : '';
        rows.push(n);
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function mapRow(row) {
  return {
    name:        row['first name'] || row['firstname'] || row['first_name'] || row['name'] || '',
    lastName:    row['last name']  || row['lastname']  || row['last_name']  || row['surname'] || '',
    email:       row['email'] || row['email address'] || '',
    phone:       row['phone'] || row['phone number']  || row['phonenumber'] || row['mobile'] || '',
    propertyUrl: row['url']   || row['link']          || row['property url'] || row['property_url'] || row['building url'] || ''
  };
}

const jobs = {};

async function runQueue(jobId, rows) {
  jobs[jobId].status = 'running';
  for (let i = 0; i < rows.length; i++) {
    const entry = mapRow(rows[i]);
    if (!entry.name || !entry.lastName || !entry.email || !entry.phone || !entry.propertyUrl) {
      jobs[jobId].results.push({ row: i + 1, success: false, error: 'Missing required field(s)', data: entry });
      jobs[jobId].done++;
      continue;
    }
    if (i > 0) {
      const waitSec = randomBetween(60, 90);
      console.log(`[Job ${jobId}] Waiting ${waitSec}s before row ${i + 1}...`);
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

app.post('/submit-csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded. Use field name "file".' });
  let rows;
  try { rows = await parseCSV(req.file.path); fs.unlinkSync(req.file.path); }
  catch (err) { return res.status(400).json({ error: `Failed to parse CSV: ${err.message}` }); }
  if (rows.length === 0) return res.status(400).json({ error: 'CSV file is empty.' });
  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', results: [], total: rows.length, done: 0, errors: 0, nextIn: null };
  runQueue(jobId, rows).catch(err => { jobs[jobId].status = 'failed'; jobs[jobId].fatalError = err.message; });
  res.json({ jobId, message: `Job queued. Processing ${rows.length} tour request(s) with 60-90s delays between each.`, statusUrl: `/job/${jobId}` });
});

app.post('/submit-one', async (req, res) => {
  const { name, lastName, phone, email, propertyUrl } = req.body;
  if (!name || !lastName || !phone || !email || !propertyUrl)
    return res.status(400).json({ error: 'Missing required fields: name, lastName, phone, email, propertyUrl' });
  const jobId = `job_${Date.now()}`;
  jobs[jobId] = { status: 'queued', results: [], total: 1, done: 0, errors: 0, nextIn: null };
  runQueue(jobId, [{ 'first name': name, 'last name': lastName, phone, email, url: propertyUrl }]);
  res.json({ jobId, message: 'Tour request queued.', statusUrl: `/job/${jobId}` });
});

app.get('/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.get('/jobs', (req, res) => res.json(jobs));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SpotEasy Tour Server running on port ${PORT}`);
  console.log(`  POST /submit-csv   - upload a CSV file`);
  console.log(`  POST /submit-one   - single JSON request`);
  console.log(`  GET  /job/:id      - check job status`);
  console.log(`  GET  /health       - health check`);
});
