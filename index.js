const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 3001;

// Your frontend URL
const FRONTEND_URL = 'https://primev1.vercel.app/';

// Middleware
app.use(cors({
    origin: [FRONTEND_URL, 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));

// Store frontend connections
const frontendConnections = [];
const MAX_CONNECTIONS = 1000;

// Enhanced logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.originalUrl}`, {
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent')?.substring(0, 100),
        origin: req.get('Origin')
    });
    next();
});

// Helper function to clean old connections
function cleanOldConnections() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const initialLength = frontendConnections.length;
    
    for (let i = frontendConnections.length - 1; i >= 0; i--) {
        const lastSeen = new Date(frontendConnections[i].lastSeen);
        if (lastSeen < fiveMinutesAgo) {
            frontendConnections.splice(i, 1);
        }
    }
    
    if (initialLength !== frontendConnections.length) {
        console.log(`🧹 Cleaned ${initialLength - frontendConnections.length} old connections`);
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
        message: 'Tasks Backend Server is running!',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        frontendUrl: FRONTEND_URL,
        endpoints: {
            test: '/api/test',
            health: '/api/health',
            connections: '/api/connections',
            frontendConnect: '/api/frontend/connect',
            telegramCheck: '/api/telegram/check-membership'
        }
    });
});

// Test endpoint
app.get('/api/test', (req, res) => {
    console.log('✅ Test endpoint called from:', req.get('Origin'));
    res.json({
        success: true,
        message: 'Server is running and connected to frontend!',
        timestamp: new Date().toISOString(),
        frontendUrl: FRONTEND_URL,
        serverUrl: `http://localhost:${PORT}`
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

        // Add to connections list
        frontendConnections.push(connectionInfo);
        
        // Keep only recent connections if over limit
        if (frontendConnections.length > MAX_CONNECTIONS) {
            frontendConnections.splice(0, frontendConnections.length - MAX_CONNECTIONS);
        }

        // Log the connection
        const userInfo = userData ? 
            `@${userData.username || 'unknown'} (${userData.telegramId || 'unknown'})` : 
            'Anonymous';
        
        console.log('🎯 Frontend Connected:', {
            connectionId,
            user: userInfo,
            origin: origin,
            frontendVersion,
            totalConnections: frontendConnections.length
        });

        res.json({
            success: true,
            message: 'Frontend connection registered successfully',
            connectionId: connectionId,
            serverTime: new Date().toISOString(),
            frontendUrl: FRONTEND_URL
        });

    } catch (error) {
        console.error('❌ Error in frontend connection:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Telegram membership check endpoint
app.post('/api/telegram/check-membership', async (req, res) => {
    try {
        const { userId, username, channel, connectionId, taskId, taskName } = req.body;

        console.log('🔍 Checking Telegram membership request:', {
            userId,
            username: username || 'unknown',
            channel,
            connectionId: connectionId || 'unknown',
            origin: req.get('Origin')
        });

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

        // Get Telegram Bot Token from environment
        const botToken = "7997214783:AAG8mwdPox1urOKx4GAO3Lk9xUOzrAMJiV0";
        if (!botToken) {
            console.error('❌ Telegram Bot Token not configured');
            return res.status(500).json({
                success: false,
                error: 'Telegram bot token not configured on server',
                isMember: false
            });
        }

        // Check membership using Telegram Bot API
        const isMember = await checkTelegramChannelMembership(botToken, userId, channel);
        
        console.log('📊 Membership check result:', {
            userId,
            channel,
            isMember,
            origin: req.get('Origin')
        });

        res.json({
            success: true,
            isMember: isMember,
            checkedAt: new Date().toISOString(),
            userId: userId,
            channel: channel
        });

    } catch (error) {
        console.error('❌ Telegram membership check failed:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to check Telegram membership',
            isMember: false
        });
    }
});

// Function to check Telegram channel membership
async function checkTelegramChannelMembership(botToken, userId, channel) {
    try {
        // Remove @ symbol if present and clean the channel name
        const cleanChannel = channel.replace('@', '').trim();
        
        // Try different formats for chat_id
        const chatIdFormats = [
            `@${cleanChannel}`,
            cleanChannel
        ];

        // If channel is numeric, try as supergroup ID
        if (/^\d+$/.test(cleanChannel)) {
            chatIdFormats.push(`-100${cleanChannel}`);
        }

        let lastError = null;

        for (const chatId of chatIdFormats) {
            try {
                const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
                
                console.log(`🔄 Trying chat_id format: ${chatId}`);
                
                const response = await axios.get(url, {
                    params: {
                        chat_id: chatId,
                        user_id: userId
                    },
                    timeout: 15000 // 15 second timeout
                });

                if (response.data.ok) {
                    const status = response.data.result.status;
                    const isMember = ['member', 'administrator', 'creator', 'restricted'].includes(status);
                    
                    console.log(`✅ Membership check successful:`, {
                        chatId,
                        status,
                        isMember
                    });
                    
                    return isMember;
                } else {
                    lastError = new Error(`Telegram API error: ${response.data.description}`);
                }
            } catch (formatError) {
                lastError = formatError;
                console.log(`❌ Failed with chat_id ${chatId}:`, formatError.message);
                // Continue to next format
            }
        }

        // If all formats failed, throw the last error
        if (lastError) {
            throw lastError;
        }

        return false;

    } catch (error) {
        console.error('❌ Telegram API error:', {
            message: error.message,
            response: error.response?.data,
            userId,
            channel
        });

        // Handle specific Telegram API errors
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        // Clean old connections first
        cleanOldConnections();

        // Calculate active connections (last 5 minutes)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const activeConnections = frontendConnections.filter(conn => {
            const lastSeen = new Date(conn.lastSeen);
            return lastSeen > fiveMinutesAgo;
        });

        // Get memory usage
        const memoryUsage = process.memoryUsage();

        const healthInfo = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            frontendUrl: FRONTEND_URL,
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
        console.error('❌ Health check error:', error);
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
        // Clean old connections first
        cleanOldConnections();

        // Calculate active connections (last 5 minutes)
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
            frontend_url: FRONTEND_URL,
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
        console.error('❌ Connections endpoint error:', error);
        res.status(500).json({
            error: 'Failed to get connection statistics',
            details: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('🚨 Unhandled error:', error);
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
        path: req.originalUrl,
        frontendUrl: FRONTEND_URL
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 Tasks Backend Server started successfully!');
    console.log(`📍 Server running on: http://localhost:${PORT}`);
    console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
    console.log(`🤖 Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Not configured'}`);
    console.log('\n📋 Available endpoints:');
    console.log('   GET  /              - Server info');
    console.log('   GET  /api/test      - Test connection');
    console.log('   GET  /api/health    - Health check');
    console.log('   GET  /api/connections - Connection statistics');
    console.log('   POST /api/frontend/connect - Register frontend');
    console.log('   POST /api/telegram/check-membership - Check Telegram membership');
    console.log('\n🔗 Testing connection to frontend...');
    
    // Test frontend connection
    axios.get(`${FRONTEND_URL}`)
        .then(() => console.log('✅ Frontend is accessible'))
        .catch(() => console.log('⚠️  Frontend might not be accessible'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

module.exports = app;



