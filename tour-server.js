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
      viewport: { width: 1280, height: 1080 }
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
    await sleep(5000);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // Click the visible Contact Building Directly button
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const target = btns.find(b =>
        b.textContent.includes('Contact Building Directly') && b.offsetParent !== null
      );
      if (target) {
        target.click();
        return { found: true, text: target.textContent.trim().substring(0, 50) };
      }
      return { found: false };
    });
    log('Click result:', JSON.stringify(clicked));
    if (!clicked.found) throw new Error('Could not find visible Contact Building Directly button');

    // Wait for the SpotEasy RSC chatbot modal to open
    log('Waiting for chatbot modal...');
    try {
      await page.waitForSelector('.rsc', { timeout: 30000 });
    } catch (e) {
      throw new Error('Chatbot modal did not open - this building may not support direct contact');
    }
    log('Chatbot modal open!');
    await sleep(2000);

    // The input has class rsc-input
    const CHAT_INPUT = 'input.rsc-input';
    try {
      await page.waitForSelector(CHAT_INPUT, { timeout: 10000 });
    } catch (e) {
      throw new Error('Chat input not found inside modal');
    }
    log('Chat input found. Starting form...');

    async function chatSend(text) {
      await randomMouseMove(page);
      await page.waitForSelector(CHAT_INPUT, { timeout: 5000 });
      await page.click(CHAT_INPUT);
      await page.fill(CHAT_INPUT, '');
      for (const char of text) {
        await page.keyboard.type(char, { delay: randomBetween(30, 100) });
      }
      await sleep(randomBetween(400, 900));
      await page.keyboard.press('Enter');
      await sleep(randomBetween(2000, 3500));
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
    // No delay between submissions - start next immediately
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
  res.json({ jobId, message: `Job queued. Processing ${rows.length} tour request(s).`, statusUrl: `/job/${jobId}` });
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
