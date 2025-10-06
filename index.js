// Combined Telegram Bot + Express Server with Firebase
require('dotenv').config();
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// ===== Firebase Initialization =====
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://test-6977e-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

// ===== Telegram Bot Initialization =====
const botToken = "7997214783:AAG8mwdPox1urOKx4GAO3Lk9xUOzrAMJiV0";
if (!botToken) {
  console.error('❌ Telegram Bot Token not configured!');
  process.exit(1);
}

const bot = new Telegraf(botToken);

// ===== Telegram Bot Handlers =====
bot.start(async (ctx) => {
  try {
    const messageText = ctx.message.text;
    const args = messageText.split(' ');
    const referrerId = args[1];
    const currentUserId = String(ctx.from.id);

    const userRef = db.ref(`users/${currentUserId}`);
    const snapshot = await userRef.once('value');

    let isNewUser = false;

    if (!snapshot.exists()) {
      isNewUser = true;
      await userRef.set({
        telegramId: parseInt(currentUserId),
        username: ctx.from.username || "",
        firstName: ctx.from.first_name || "User",
        lastName: ctx.from.last_name || "",
        balance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        joinDate: new Date().toISOString(),
        adsWatchedToday: 0,
        tasksCompleted: {},
        referredBy: referrerId || null
      });
    }

    if (referrerId && referrerId !== currentUserId && isNewUser) {
      const referralRef = db.ref(`referrals/${referrerId}/referredUsers/${currentUserId}`);
      await referralRef.set({ joinedAt: new Date().toISOString(), bonusGiven: false });

      const referrerStatsRef = db.ref(`referrals/${referrerId}`);
      const referrerStatsSnap = await referrerStatsRef.once('value');

      let referredCount = 0;
      let referralEarnings = 0;

      if (referrerStatsSnap.exists()) {
        const data = referrerStatsSnap.val();
        referredCount = data.referredCount || 0;
        referralEarnings = data.referralEarnings || 0;
      }

      await referrerStatsRef.update({
        referralCode: referrerId,
        referredCount: referredCount + 1,
        referralEarnings: referralEarnings
      });

      try {
        await ctx.telegram.sendMessage(referrerId, `New referral! ${ctx.from.first_name}.`, { parse_mode: 'HTML' });
      } catch (error) {
        // ignore if notification fails
      }
    }

    const welcomeMessage = isNewUser
      ? (referrerId && referrerId !== currentUserId ? `👋 Hi ${ctx.from.first_name}! Referred by a friend! Start earning now!` 
          : `👋 Hi ${ctx.from.first_name}! Invite friends & earn 10% of their earnings!`)
      : `Welcome back, ${ctx.from.first_name}!`;

    await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });

  } catch (error) {
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

bot.catch((err, ctx) => {
  // Only critical errors are printed
  console.error(`Error for ${ctx.updateType}:`, err.message);
});

bot.launch();

// ===== Express Server Initialization =====
const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:5173'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Store frontend connections
const frontendConnections = [];
const MAX_CONNECTIONS = 1000;

function cleanOldConnections() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  for (let i = frontendConnections.length - 1; i >= 0; i--) {
    if (new Date(frontendConnections[i].lastSeen) < fiveMinutesAgo) {
      frontendConnections.splice(i, 1);
    }
  }
}

function updateConnectionLastSeen(connectionId) {
  const conn = frontendConnections.find(c => c.id === connectionId);
  if (conn) conn.lastSeen = new Date().toISOString();
}

// ===== Express Endpoints =====
app.get('/', (req, res) => {
  res.json({ message: 'Backend Server running', timestamp: new Date().toISOString() });
});

app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Server running' });
});

app.post('/api/frontend/connect', (req, res) => {
  try {
    const { timestamp, userAgent, frontendVersion, userData } = req.body;
    cleanOldConnections();

    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    frontendConnections.push({
      id: connectionId,
      timestamp: new Date().toISOString(),
      userAgent: userAgent || 'unknown',
      frontendVersion: frontendVersion || 'unknown',
      userData: userData || null,
      ip: req.ip || 'unknown',
      origin: req.get('Origin') || 'unknown',
      lastSeen: new Date().toISOString()
    });

    if (frontendConnections.length > MAX_CONNECTIONS) {
      frontendConnections.splice(0, frontendConnections.length - MAX_CONNECTIONS);
    }

    res.json({ success: true, connectionId });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/telegram/check-membership', async (req, res) => {
  try {
    const { userId, channel, connectionId } = req.body;
    if (!userId || !channel) return res.status(400).json({ success: false, error: 'Missing userId or channel' });

    if (connectionId) updateConnectionLastSeen(connectionId);

    const isMember = await checkTelegramChannelMembership(botToken, userId, channel);
    res.json({ success: true, isMember });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, isMember: false });
  }
});

async function checkTelegramChannelMembership(botToken, userId, channel) {
  const cleanChannel = channel.replace('@', '').trim();
  const chatIdFormats = [`@${cleanChannel}`, cleanChannel];
  if (/^\d+$/.test(cleanChannel)) chatIdFormats.push(`-100${cleanChannel}`);

  let lastError = null;
  for (const chatId of chatIdFormats) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
      const response = await axios.get(url, { params: { chat_id: chatId, user_id: userId }, timeout: 15000 });
      if (response.data.ok) {
        const status = response.data.result.status;
        return ['member', 'administrator', 'creator', 'restricted'].includes(status);
      } else {
        lastError = new Error(response.data.description);
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return false;
}

// Health check
app.get('/api/health', (req, res) => {
  try {
    cleanOldConnections();
    const activeConnections = frontendConnections.filter(conn => new Date(conn.lastSeen) > new Date(Date.now() - 5*60*1000));
    const memory = process.memoryUsage();
    res.json({
      status: 'healthy',
      connections: { total: frontendConnections.length, active: activeConnections.length },
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      telegram_bot_configured: !!botToken
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Start Express server
const server = app.listen(PORT, () => {
  console.log(`🚀 Express running on port ${PORT}`);
});

// ===== Graceful Shutdown =====
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close(() => process.exit(0));
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (error) => process.exit(1));
process.on('unhandledRejection', (reason) => process.exit(1));

module.exports = app;
