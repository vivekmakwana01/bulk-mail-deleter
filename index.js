require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
} = process.env;

const TOKEN_PATH = path.join(__dirname, 'tokens.json');

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const DATA_FILE = path.join(__dirname, 'fetchedEmails.json');

// Utility to load previous state
const loadState = () => {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  return { messageIds: [], senderCounts: {}, nextPageToken: null };
};

// Utility to save state
const saveState = (state) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
};

// 🔁 Load tokens if available
if (fs.existsSync(TOKEN_PATH)) {
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oauth2Client.setCredentials(tokens);
  console.log('✅ Loaded saved tokens');
}

// 🔄 Automatically save new tokens on refresh
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token || tokens.access_token) {
    const currentTokens = oauth2Client.credentials;
    const updatedTokens = { ...currentTokens, ...tokens };

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens));
    console.log('🔄 Refreshed & saved new tokens to disk');
  }
});

app.get('/', (req, res) => {
  if (oauth2Client.credentials && oauth2Client.credentials.access_token) {
    res.send('Already authenticated! <a href="/profile">View Gmail Profile</a>');
  } else {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.modify'],
      prompt: 'consent'
    });
    res.redirect(url);
  }
});

app.get('/emails', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // 🔄 Extract query params
    const {
      from,
      subject,
      hasAttachment,
      newerThan,
      olderThan,
      label,
      maxResults = 10,
    } = req.query;

    // 🧠 Build Gmail search query string
    let queryParts = [];

    if (from) queryParts.push(`from:${from}`);
    if (subject) queryParts.push(`subject:"${subject}"`);
    if (hasAttachment === 'true') queryParts.push('has:attachment');
    if (newerThan) queryParts.push(`newer_than:${newerThan}`);
    if (olderThan) queryParts.push(`older_than:${olderThan}`);
    if (label) queryParts.push(`label:${label}`);

    const query = queryParts.join(' ');

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: parseInt(maxResults),
    });

    const messages = response.data.messages || [];

    const emailList = await Promise.all(
      messages.map(async (msg) => {
        const email = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From'],
        });

        const headers = email.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown';

        return {
          id: msg.id,
          from,
          subject,
          snippet: email.data.snippet,
        };
      })
    );

    res.json(emailList);
  } catch (error) {
    console.error('❌ Error listing emails:', error);
    res.status(500).send('Failed to list emails');
  }
});

app.get('/top-senders', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const state = loadState();
    const { messageIds, senderCounts } = state;
    let { nextPageToken } = state;

    let fetched = 0;
    const maxBatch = 1000; // max emails per request (adjust as needed)

    while (fetched < maxBatch) {
      const response = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 500,
        pageToken: nextPageToken || undefined,
      });

      const messages = response.data.messages || [];
      nextPageToken = response.data.nextPageToken || null;

      // Filter out already fetched message IDs
      const newMessages = messages.filter(msg => !messageIds.includes(msg.id));
      fetched += newMessages.length;

      // Fetch sender info
      await Promise.all(
        newMessages.map(async (msg) => {
          const email = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From'],
          });

          const fromHeader = email.data.payload.headers.find(h => h.name === 'From');
          if (fromHeader) {
            const from = fromHeader.value;
            senderCounts[from] = (senderCounts[from] || 0) + 1;
          }

          // Add to processed list
          messageIds.push(msg.id);
        })
      );

      // Save progress
      saveState({ messageIds, senderCounts, nextPageToken });

      if (!nextPageToken) break; // all emails fetched
    }

    // Return top 5 senders
    const sortedSenders = Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sender, count]) => ({ sender, count }));

    res.json({
      status: 'partial',
      fetched: fetched,
      totalProcessed: messageIds.length,
      topSenders: sortedSenders,
      done: !nextPageToken,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).send('Failed to get top senders');
  }
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 💾 Save tokens to disk
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('✅ Tokens saved to', TOKEN_PATH);

    res.redirect('/profile');
  } catch (error) {
    console.error('❌ Error retrieving access token:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/profile', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    res.send(`
      <h2>Authenticated as ${profile.data.emailAddress}</h2>
      <p><a href="/">Back</a></p>
    `);
  } catch (err) {
    res.status(500).send('Failed to fetch Gmail profile');
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
