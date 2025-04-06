require('dotenv').config(); // Load .env variables at the top

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

// 🔁 Load existing token if it exists
if (fs.existsSync(TOKEN_PATH)) {
  const savedTokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oauth2Client.setCredentials(savedTokens);
  console.log('✅ Loaded saved tokens');
}

app.get('/', (req, res) => {
  if (oauth2Client.credentials.access_token) {
    res.send('Already authenticated! <a href="/profile">View Gmail Profile</a>');
  } else {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.modify']
    });
    res.redirect(url);
  }
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 💾 Save the tokens to disk
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
