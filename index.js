const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// Firebase Admin initialization
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://test-6977e-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '7997214783:AAG8mwdPox1urOKx4GAO3Lk9xUOzrAMJiV0');

// Express app setup
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: [process.env.FRONTEND_URL || 'https://178ql44r-5173.asse.devtunnels.ms', 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));

// Store frontend connections
const frontendConnections = [];
const MAX_CONNECTIONS = 1000;

// Helper function to clean old connections
function cleanOldConnections() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    for (let i = frontendConnections.length - 1; i >= 0; i--) {
        const lastSeen = new Date(frontendConnections[i].lastSeen);
        if (lastSeen < fiveMinutesAgo) {
            frontendConnections.splice(i, 1);
        }
    }
}

// Update last seen for active connections
function updateConnectionLastSeen(connectionId) {
    const connection = frontendConnections.find(conn => conn.id === connectionId);
    if (connection) {
        connection.lastSeen = new Date().toISOString();
    }
}

// Telegram Bot Commands
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
      await referralRef.set({
        joinedAt: new Date().toISOString(),
        bonusGiven: false
      });

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
        await ctx.telegram.sendMessage(referrerId, 
          `New referral! ${ctx.from.first_name}.`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {}
    }

    const userSnap = await userRef.once('value');
    const userData = userSnap.val();

    const referralSnap = await db.ref(`referrals/${currentUserId}`).once('value');
    let referredCount = 0;
    let referralEarnings = 0;

    if (referralSnap.exists()) {
      const refData = referralSnap.val();
      referredCount = refData.referredCount || 0;
      referralEarnings = refData.referralEarnings || 0;
    }

    let welcomeMessage = `👋 <b>Hi ${ctx.from.first_name}!</b>\n`;

    if (referrerId && referrerId !== currentUserId && isNewUser) {
      welcomeMessage += `Referred by a friend! Start earning now!`;
    } else if (isNewUser) {
      welcomeMessage += `Invite friends & earn 10% of their earnings!`;
    }

    await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });

  } catch (error) {
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Add referral earnings manually (Admin only)
bot.command('addreferral', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /addreferral <userId> <amount>');

  const userId = args[1];
  const amount = parseFloat(args[2]);
  if (isNaN(amount)) return ctx.reply('Invalid amount');

  const referralRef = db.ref(`referrals/${userId}`);
  const referralSnap = await referralRef.once('value');
  let referralEarnings = 0;
  if (referralSnap.exists()) referralEarnings = referralSnap.val().referralEarnings || 0;
});

// Error handling
bot.catch((err, ctx) => {});

// Express Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Tasks Backend Server is running!',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running and connected to frontend!',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/frontend/connect', (req, res) => {
    try {
        const { timestamp, userAgent, frontendVersion, userData } = req.body;
        
        cleanOldConnections();
        
        const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
        const origin = req.get('Origin') || 'unknown';
        
        const connectionInfo = {
            id: connectionId,
            timestamp: new Date().toISOString(),
            userAgent: userAgent || 'unknown',
            frontendVersion: frontendVersion || 'unknown',
            userData: userData || null,
            ip: clientIp,
            origin: origin,
            lastSeen: new Date().toISOString()
        };

        frontendConnections.push(connectionInfo);
        
        if (frontendConnections.length > MAX_CONNECTIONS) {
            frontendConnections.splice(0, frontendConnections.length - MAX_CONNECTIONS);
        }

        res.json({
            success: true,
            message: 'Frontend connection registered successfully',
            connectionId: connectionId,
            serverTime: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Function to check Telegram channel membership
async function checkTelegramChannelMembership(botToken, userId, channel) {
    try {
        const cleanChannel = channel.replace('@', '').trim();
        
        const chatIdFormats = [
            `@${cleanChannel}`,
            cleanChannel
        ];

        if (/^\d+$/.test(cleanChannel)) {
            chatIdFormats.push(`-100${cleanChannel}`);
        }

        let lastError = null;

        for (const chatId of chatIdFormats) {
            try {
                const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
                
                const response = await axios.get(url, {
                    params: {
                        chat_id: chatId,
                        user_id: userId
                    },
                    timeout: 15000
                });

                if (response.data.ok) {
                    const status = response.data.result.status;
                    const isMember = ['member', 'administrator', 'creator', 'restricted'].includes(status);
                    return isMember;
                } else {
                    lastError = new Error(`Telegram API error: ${response.data.description}`);
                }
            } catch (formatError) {
                lastError = formatError;
            }
        }

        if (lastError) {
            throw lastError;
        }

        return false;

    } catch (error) {
        if (error.response?.data) {
            const telegramError = error.response.data;
            if (telegramError.error_code === 400) {
                throw new Error('User not found in channel or channel does not exist');
            } else if (telegramError.error_code === 403) {
                throw new Error('Bot is not a member of the channel or does not have permissions');
            } else if (telegramError.error_code === 404) {
                throw new Error('Channel not found or bot is not an admin');
            }
        }

        throw new Error(`Telegram API request failed: ${error.message}`);
    }
}

app.post('/api/telegram/check-membership', async (req, res) => {
    try {
        const { userId, username, channel, connectionId, taskId, taskName } = req.body;

        if (!userId || !channel) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId and channel are required'
            });
        }

        if (connectionId) {
            updateConnectionLastSeen(connectionId);
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return res.status(500).json({
                success: false,
                error: 'Telegram bot token not configured on server',
                isMember: false
            });
        }

        const isMember = await checkTelegramChannelMembership(botToken, userId, channel);
        
        res.json({
            success: true,
            isMember: isMember,
            checkedAt: new Date().toISOString(),
            userId: userId,
            channel: channel
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to check Telegram membership',
            isMember: false
        });
    }
});

app.get('/api/health', (req, res) => {
    try {
        cleanOldConnections();

        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const activeConnections = frontendConnections.filter(conn => {
            const lastSeen = new Date(conn.lastSeen);
            return lastSeen > fiveMinutesAgo;
        });

        const memoryUsage = process.memoryUsage();

        const healthInfo = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            connections: {
                total: frontendConnections.length,
                active: activeConnections.length,
                unique_users: [...new Set(frontendConnections
                    .filter(conn => conn.userData?.telegramId)
                    .map(conn => conn.userData.telegramId)
                )].length
            },
            memory: {
                rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB'
            },
            environment: process.env.NODE_ENV || 'development',
            telegram_bot_configured: !!process.env.TELEGRAM_BOT_TOKEN
        };

        res.json(healthInfo);

    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/connections', (req, res) => {
    try {
        cleanOldConnections();

        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const activeConnections = frontendConnections.filter(conn => {
            const lastSeen = new Date(conn.lastSeen);
            return lastSeen > fiveMinutesAgo;
        });

        const uniqueUsers = [...new Set(
            frontendConnections
                .filter(conn => conn.userData && conn.userData.telegramId)
                .map(conn => conn.userData.telegramId)
        )];

        const stats = {
            total_connections: frontendConnections.length,
            active_connections: activeConnections.length,
            unique_users: uniqueUsers.length,
            connection_details: {
                max_stored: MAX_CONNECTIONS,
                cleanup_interval: '5 minutes'
            },
            recent_connections: frontendConnections
                .slice(-10)
                .reverse()
                .map(conn => ({
                    id: conn.id,
                    timestamp: conn.timestamp,
                    user: conn.userData ? 
                        `@${conn.userData.username || 'unknown'} (${conn.userData.telegramId})` : 
                        'Anonymous',
                    origin: conn.origin,
                    last_seen: conn.lastSeen
                }))
        };

        res.json(stats);

    } catch (error) {
        res.status(500).json({
            error: 'Failed to get connection statistics',
            details: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.originalUrl
    });
});

// Start bot and server
const startServer = async () => {
    try {
        await bot.launch();
        
        const server = app.listen(PORT, '0.0.0.0', () => {});
        
        // Graceful shutdown
        process.once('SIGINT', () => {
            bot.stop('SIGINT');
            server.close(() => {
                process.exit(0);
            });
        });
        
        process.once('SIGTERM', () => {
            bot.stop('SIGTERM');
            server.close(() => {
                process.exit(0);
            });
        });

    } catch (error) {
        process.exit(1);
    }
};

startServer();

module.exports = app;
