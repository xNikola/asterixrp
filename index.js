require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
const CUSTOM_ACTIVITY = process.env.CUSTOM_ACTIVITY || 'Monitoring admins';
const STREAM_URL = process.env.STREAM_URL || 'https://twitch.tv/yourchannel'; // required for purple circle

// --- Discord Bot Setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Purple streaming status
  client.user.setPresence({
    status: 'online',
    activities: [{
      name: CUSTOM_ACTIVITY,
      type: ActivityType.Streaming,
      url: STREAM_URL
    }]
  });
});

client.login(TOKEN);

// --- Express Setup ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Cache Helpers ---
function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE)); }
    catch (err) { console.error('Failed to read cache.json', err); }
  }
  return null;
}
function saveCache(data) { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); }

// --- Blacklist Helpers ---
function loadBlacklist() {
  if (fs.existsSync(BLACKLIST_FILE)) {
    try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE)); }
    catch (err) { console.error('Failed to read blacklist.json', err); }
  }
  return [];
}
function saveBlacklist(list) { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(list, null, 2)); }

// --- Fetch Messages from Discord using bot ---
async function fetchAllMessages() {
  console.log('Fetching all messages from Discord...');
  let messages = [];
  let before = null;
  const perRequest = 100;
  const channel = await client.channels.fetch(CHANNEL_ID);

  if (!channel || !channel.isTextBased()) {
    console.error('Invalid channel ID or channel is not text-based');
    return [];
  }

  while (true) {
    const options = { limit: perRequest };
    if (before) options.before = before;

    const chunk = await channel.messages.fetch(options);
    if (!chunk.size) break;

    messages = messages.concat(Array.from(chunk.values()));
    before = chunk.last().id;
    console.log('Fetched messages:', messages.length);

    if (chunk.size < perRequest) break;
  }

  // Normalize embeds for parser
  const normalized = messages.map(m => {
    const embed = m.embeds?.[0];
    let title = null;
    if (embed) {
      if (embed.title) title = embed.title;
      else if (embed.fields?.length) title = embed.fields.map(f => f.value).join('\n');
    }
    return {
      id: m.id,
      timestamp: m.createdAt?.toISOString() || m.timestamp,
      embeds: title ? [{ title }] : [],
    };
  });

  saveCache(normalized);
  console.log('All messages cached to', CACHE_FILE);
  return normalized;
}

// --- Parse Messages into Admins or Players ---
function parseMessages(msgs) {
  const blacklist = loadBlacklist();
  const participants = {};

  msgs.forEach(m => {
    const embed = m.embeds?.[0];
    if (!embed || !embed.title) return;

    const lines = embed.title.split("\n");
    let name, license, minutes;

    lines.forEach(line => {
      if (line.startsWith("Admin:") || line.startsWith("Igrač:")) {
        name = line.replace("Admin:", "").replace("Igrač:", "").trim();
      }
      if (line.startsWith("Licenca:")) {
        license = line.replace("Licenca:", "").trim();
      }
      if (line.startsWith("Radnja:")) {
        const match = line.match(/proveo na dužnosti (-?\d+)\s*minuta/i);
        if (match) minutes = parseInt(match[1], 10);
      }
    });

    if (name && blacklist.includes(name)) return;

    if (name && license && minutes != null) {
      if (!participants[name]) {
        participants[name] = { admin: name, license, totalMinutes: 0, lastDuty: null };
      }
      participants[name].totalMinutes += minutes;

      const ts = new Date(m.timestamp);
      if (!participants[name].lastDuty || ts > new Date(participants[name].lastDuty)) {
        participants[name].lastDuty = ts.toISOString();
      }
    }
  });

  return Object.values(participants);
}


// --- Load Messages from Cache or Fetch ---
async function getMessages() {
  let cached = loadCache();
  if (cached) return cached;
  return await fetchAllMessages();
}

// --- API Endpoints ---
app.get('/admins', async (req, res) => {
  try {
    const admins = parseMessages(await getMessages());
    admins.sort((a, b) => b.totalMinutes - a.totalMinutes);
    res.json(admins);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/rescan', async (req, res) => {
  try { res.json(parseMessages(await fetchAllMessages())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admins/remove-time', (req, res) => {
  const { admin, minutes } = req.body;
  if (!admin || !minutes) return res.status(400).json({ error: "Provide admin and minutes" });
  let cache = loadCache();
  if (!cache) return res.status(500).json({ error: "Cache not loaded" });

  cache.push({
    timestamp: new Date().toISOString(),
    embeds: [{ title: `Admin: ${admin}\nLicenca: manual\nRadnja: proveo na dužnosti -${minutes} minuta` }]
  });
  saveCache(cache);
  res.json({ success: true });
});

app.post('/admins/add-time', (req, res) => {
  const { admin, minutes } = req.body;
  if (!admin || !minutes) return res.status(400).json({ error: "Provide admin and minutes" });
  let cache = loadCache();
  if (!cache) return res.status(500).json({ error: "Cache not loaded" });

  cache.push({
    timestamp: new Date().toISOString(),
    embeds: [{ title: `Admin: ${admin}\nLicenca: manual\nRadnja: proveo na dužnosti ${minutes} minuta` }]
  });
  saveCache(cache);
  res.json({ success: true });
});

app.post('/admins/remove-admin', (req, res) => {
  const { admin } = req.body;
  if (!admin) return res.status(400).json({ error: "Provide admin" });
  let cache = loadCache();
  if (!cache) return res.status(500).json({ error: "Cache not loaded" });

  cache = cache.filter(m => {
    const embed = m.embeds?.[0];
    if (!embed || !embed.title) return true;
    return !embed.title.includes(`Admin: ${admin}`);
  });
  saveCache(cache);
  res.json({ success: true });
});

app.post('/admins/blacklist', (req, res) => {
  const { admin } = req.body;
  if (!admin) return res.status(400).json({ error: "Provide admin" });
  let list = loadBlacklist();
  if (!list.includes(admin)) { list.push(admin); saveBlacklist(list); }
  res.json({ success: true, blacklist: list });
});

app.post('/admins/unblacklist', (req, res) => {
  const { admin } = req.body;
  if (!admin) return res.status(400).json({ error: "Provide admin" });
  let list = loadBlacklist().filter(a => a !== admin);
  saveBlacklist(list);
  res.json({ success: true, blacklist: list });
});

app.get('/admins/blacklist', (req, res) => { res.json(loadBlacklist()); });

app.get('/admins/bydate/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const msgs = await getMessages();
    const filtered = msgs.filter(m => new Date(m.timestamp).toISOString().split('T')[0] === date);
    res.json(parseMessages(filtered));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admins/range', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Provide from and to dates in YYYY-MM-DD format" });
    const fromDate = new Date(from + "T00:00:00Z");
    const toDate = new Date(to + "T23:59:59Z");
    const msgs = await getMessages();
    const filtered = msgs.filter(m => {
      const ts = new Date(m.timestamp);
      return ts >= fromDate && ts <= toDate;
    });
    res.json(parseMessages(filtered));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
