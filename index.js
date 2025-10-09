const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// URLs configuration
const FRONTEND_URL = 'https://primev1.vercel.app';
const ADMIN_URL = 'https://primev1admin.vercel.app/';
const DASHBOARD_URL = 'https://primev1.vercel.app';

// Middleware
app.use(cors({
    origin: [FRONTEND_URL, ADMIN_URL, 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));

// Store frontend connections
const frontendConnections = [];
const MAX_CONNECTIONS = 1000;

// --- Firebase Configuration ---
const FIREBASE_DB_URL = 'https://test-6977e-default-rtdb.firebaseio.com';

// --- Helper Functions ---
async function getData(path) {
  try {
    const res = await axios.get(`${FIREBASE_DB_URL}/${path}.json`);
    return res.data;
  } catch (err) {
    return null;
  }
}

async function setData(path, data) {
  try {
    await axios.put(`${FIREBASE_DB_URL}/${path}.json`, data);
  } catch (err) {
    console.log('Firebase error');
  }
}

async function updateData(path, data) {
  try {
    await axios.patch(`${FIREBASE_DB_URL}/${path}.json`, data);
  } catch (err) {
    console.log('Firebase update error');
  }
}

// --- Telegram Bot Setup ---
const BOT_TOKEN = '7997214783:AAG8mwdPox1urOKx4GAO3Lk9xUOzrAMJiV0';
const bot = new Telegraf(BOT_TOKEN);

// --- Telegram Bot Commands ---

// Start Command - Opens dashboard
bot.start(async (ctx) => {
  try {
    const messageText = ctx.message.text;
    const args = messageText.split(' ');
    const referrerId = args[1] || null;
    const currentUserId = String(ctx.from.id);

    // Check if user exists
    let userData = await getData(`users/${currentUserId}`);
    let isNewUser = false;

    if (!userData) {
      isNewUser = true;
      // Create new user
      await setData(`users/${currentUserId}`, {
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

    // Handle referral system
    if (referrerId && referrerId !== currentUserId && isNewUser) {
      await setData(`referrals/${referrerId}/referredUsers/${currentUserId}`, {
        joinedAt: new Date().toISOString(),
        bonusGiven: false
      });

      // Update referrer stats
      let referrerStats = await getData(`referrals/${referrerId}`) || {};
      let referredCount = referrerStats.referredCount || 0;
      let referralEarnings = referrerStats.referralEarnings || 0;

      await updateData(`referrals/${referrerId}`, {
        referralCode: referrerId,
        referredCount: referredCount + 1,
        referralEarnings: referralEarnings
      });

      // Notify referrer
      try {
        await ctx.telegram.sendMessage(referrerId, `🎉 New referral! ${ctx.from.first_name} joined using your link.`, { parse_mode: 'HTML' });
      } catch (error) {
        console.log('Could not notify referrer:', error.message);
      }
    }

    // Send dashboard message with button
    const welcomeMessage = `👋 <b>Welcome ${ctx.from.first_name}!</b>\n\n` +
                          `Click the button below to open your dashboard and start earning:`;

    // Option 1: Web App button (for Telegram Mini Apps)
    await ctx.reply(welcomeMessage, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🚀 Open Dashboard',
              web_app: {
                url: DASHBOARD_URL
              }
            }
          ]
        ]
      }
    });

  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Add referral earnings manually (Admin only)
bot.command('addreferral', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('Usage: /addreferral <userId> <amount>');

    const userId = args[1];
    const amount = parseFloat(args[2]);
    if (isNaN(amount)) return ctx.reply('Invalid amount');

    const referralSnap = await getData(`referrals/${userId}`) || {};
    const referralEarnings = referralSnap.referralEarnings || 0;

    await updateData(`referrals/${userId}`, {
      referralEarnings: referralEarnings + amount
    });

    await ctx.reply(`✅ Added ${amount} to referral earnings of user ${userId}`);
  } catch (err) {
    await ctx.reply('❌ Failed to add referral earnings.');
  }
});

// --- Express Server Routes ---

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

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Telegram Bot & Tasks Backend Server is running!',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running and connected to frontend!',
        timestamp: new Date().toISOString()
    });
});

// Frontend connection registration endpoint
app.post('/api/frontend/connect', (req, res) => {
    try {
        const { timestamp, userAgent, frontendVersion, userData } = req.body;
        
        // Clean old connections first
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

// Telegram membership check endpoint
app.post('/api/telegram/check-membership', async (req, res) => {
    try {
        const { userId, username, channel, connectionId, taskId, taskName } = req.body;

        if (!userId || !channel) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId and channel are required'
            });
        }

        // Update connection last seen
        if (connectionId) {
            updateConnectionLastSeen(connectionId);
        }

        // Check membership using Telegram Bot API
        const isMember = await checkTelegramChannelMembership(BOT_TOKEN, userId, channel);

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

// Send Telegram notification endpoint (Admin only)
app.post('/api/send-notification', async (req, res) => {
    try {
        const { message, imageUrl, buttons } = req.body;

        if (!message && !imageUrl) {
            return res.status(400).json({ 
                success: false,
                error: 'Message or image required' 
            });
        }

        // Fetch all users
        const users = await getData('users');
        if (!users) {
            return res.status(404).json({
                success: false,
                error: 'No users found in database'
            });
        }

        const chatIds = Object.values(users).map(u => u.telegramId).filter(id => id);

        // Prepare reply markup if buttons are provided
        const replyMarkup = buttons && buttons.length > 0
            ? { 
                inline_keyboard: [buttons.map(b => ({ 
                    text: b.text, 
                    url: b.url 
                }))] 
              }
            : undefined;

        let successCount = 0;
        let failCount = 0;

        // Send notifications to all users
        for (const chat_id of chatIds) {
            try {
                if (imageUrl) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                        chat_id,
                        photo: imageUrl,
                        caption: message || '',
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id,
                        text: message,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
                successCount++;
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                failCount++;
            }
        }

        const result = {
            success: true,
            message: `Notifications sent successfully`,
            stats: {
                totalUsers: chatIds.length,
                successful: successCount,
                failed: failCount
            },
            timestamp: new Date().toISOString()
        };

        res.json(result);

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to send notifications',
            details: error.message
        });
    }
});

// Health check endpoint
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
            telegram_bot_configured: !!BOT_TOKEN
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

// Connections statistics endpoint
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

// --- Bot Error handling ---
bot.catch((err, ctx) => {
    console.log('Bot error');
});

// --- Start Server and Bot ---
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Start the Telegram bot
bot.launch().then(() => {
    console.log('Telegram Bot started');
}).catch(err => {
    console.log('Failed to start Telegram Bot');
});

// --- Graceful shutdown ---
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

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    process.exit(1);
});

module.exports = app;
