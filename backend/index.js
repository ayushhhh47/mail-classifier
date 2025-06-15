require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const { parse, isValid, addDays, addHours, differenceInHours } = require('date-fns');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 5000;

// Validate environment variables
const requiredEnvVars = ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'GEMINI_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// OAuth2 Setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// In-memory token storage
let tokenStorage = null;

function saveToken(token) {
  tokenStorage = token;
  console.log('Token stored in memory');
}

function loadToken() {
  return tokenStorage;
}

// Gemini Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Auth Endpoint
app.get('/auth', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  });
  res.json({ authUrl });
});

// OAuth Callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);
    res.send('Authentication successful! You can close this tab.');
  } catch (error) {
    console.error('OAuth error:', error.message);
    res.status(500).send('Authentication failed.');
  }
});

// Main Task Endpoint
app.get('/tasks', async (req, res) => {
  const token = loadToken();
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  oAuth2Client.setCredentials(token);

  try {
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    const emails = await fetchRecentEmails(gmail);
    const tasks = await processEmails(emails);
    res.json(tasks);
  } catch (error) {
    console.error('Error fetching tasks:', error.message);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Fetch recent Gmail emails
async function fetchRecentEmails(gmail) {
  const afterDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const query = `after:${Math.floor(afterDate.getTime() / 1000)}`;

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500,
    });

    const messages = res.data.messages || [];
    const emails = [];

    for (const msg of messages) {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      emails.push(email.data);
    }

    console.log(`Fetched ${emails.length} emails`);
    return emails;
  } catch (error) {
    console.error('Error fetching emails:', error.message);
    throw error;
  }
}

// Extract tasks from emails using Gemini
async function processEmails(emails) {
  const tasks = [];

  for (const email of emails) {
    const headers = email.payload.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';

    let body = '';
    if (email.payload.parts) {
      for (const part of email.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }
    } else if (email.payload.body?.data) {
      body = Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
    }

    const extracted = await extractInfoWithGemini(body, subject);
    const deadline = parseDeadline(extracted.deadline);
    const priority = categorizeTask(extracted, deadline);

    tasks.push({
      eventType: extracted.eventType,
      subject: extracted.subject,
      deadline: deadline.toISOString(),
      urgency: extracted.urgency,
      importance: extracted.importance,
      score: extracted.score,
      priority,
      registrationLink: extracted.registrationLink,
      summary: extracted.summary,
    });
  }

  return tasks;
}

// Call Gemini to extract info
async function extractInfoWithGemini(emailContent, subject) {
  const prompt = `
    Analyze the email content and extract task details for classification into "Urgent," "Important," or "Later". Use today's date: 14/06/2025.

    Return this format:
    Event Type: <type>
    Subject: <subject>
    Deadline: <deadline>
    Urgency: <high/medium/low>
    Importance: <high/medium/low>
    Score: <score>
    Registration Link: <link>
    Summary: <summary>

    Email: "${emailContent}"
  `;

  try {
    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text();
    const lines = text.split('\n').filter(Boolean);

    return {
      eventType: lines[0]?.replace('Event Type: ', '') || 'Email',
      subject: lines[1]?.replace('Subject: ', '') || subject,
      deadline: lines[2]?.replace('Deadline: ', '') || 'none',
      urgency: lines[3]?.replace('Urgency: ', '') || 'low',
      importance: lines[4]?.replace('Importance: ', '') || 'low',
      score: lines[5]?.replace('Score: ', '') || 'none',
      registrationLink: lines[6]?.replace('Registration Link: ', '') || 'none',
      summary: lines[7]?.replace('Summary: ', '') || 'No summary.',
    };
  } catch (error) {
    console.error('Gemini error:', error.message);
    return {
      eventType: 'Email',
      subject,
      deadline: 'none',
      urgency: 'low',
      importance: 'low',
      score: 'none',
      registrationLink: 'none',
      summary: 'Could not extract information.',
    };
  }
}

// Deadline parser
function parseDeadline(deadlineStr) {
  const now = new Date();
  deadlineStr = deadlineStr.toLowerCase().trim();

  if (deadlineStr === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }
  if (deadlineStr === 'tomorrow') {
    return addDays(now, 1);
  }
  if (deadlineStr === 'day after tomorrow') {
    return addDays(now, 2);
  }
  if (deadlineStr === 'none') {
    return addDays(now, 7);
  }

  const withinMatch = deadlineStr.match(/within (\d+) hours/);
  if (withinMatch) {
    return addHours(now, parseInt(withinMatch[1], 10));
  }

  const formats = ['dd/MM/yyyy HH:mm', 'dd/MM/yyyy', 'yyyy-MM-dd', 'MMMM d, yyyy', 'dd MMM yyyy'];
  for (const fmt of formats) {
    const parsed = parse(deadlineStr, fmt, now);
    if (isValid(parsed)) {
      if (!fmt.includes('HH:mm')) {
        parsed.setHours(23, 59, 59);
      }
      return parsed;
    }
  }

  return addDays(now, 7);
}

// Categorize tasks
function categorizeTask(extracted, deadline) {
  const now = new Date();
  const hoursLeft = differenceInHours(deadline, now);

  const isUrgent = hoursLeft <= 24 || extracted.urgency === 'high';
  const isImportant = hoursLeft <= 72 || extracted.importance === 'high';

  if (isUrgent) {
    return '🔴 Urgent';
  }
  if (isImportant) {
    return '🟡 Important';
  }
  return '⚪ Later';
}

// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});