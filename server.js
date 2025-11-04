// server-azure.js
// Basketball Monster Server - Azure SQL Version
require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const { Expo } = require('expo-server-sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Azure SQL Configuration
const sqlConfig = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  database: process.env.AZURE_SQL_DATABASE,
  server: process.env.AZURE_SQL_SERVER,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
  useFcmV1: true
});

let pool;

// Initialize database connection
async function initializeDatabase() {
  try {
    pool = await sql.connect(sqlConfig);
    console.log('✅ Connected to Azure SQL Database');

    // Create tables
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valid_codes' AND xtype='U')
      CREATE TABLE valid_codes (
        code NVARCHAR(50) PRIMARY KEY,
        league_count INT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='devices' AND xtype='U')
      CREATE TABLE devices (
        code NVARCHAR(50) PRIMARY KEY,
        pushToken NVARCHAR(500),
        registrationId NVARCHAR(50),
        timestamp DATETIME DEFAULT GETDATE()
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='user_alerts' AND xtype='U')
      CREATE TABLE user_alerts (
        id INT IDENTITY(1,1) PRIMARY KEY,
        alert_id NVARCHAR(50),
        user_code NVARCHAR(50),
        title NVARCHAR(500),
        status NVARCHAR(100),
        status_color NVARCHAR(20),
        alert_level NVARCHAR(50),
        details NVARCHAR(MAX),
        teams_affected INT DEFAULT 0,
        sent_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        is_deleted INT DEFAULT 0
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='notifications' AND xtype='U')
      CREATE TABLE notifications (
        id INT IDENTITY(1,1) PRIMARY KEY,
        alert_id NVARCHAR(50) UNIQUE,
        title NVARCHAR(500),
        status NVARCHAR(100),
        status_color NVARCHAR(20),
        alert_level NVARCHAR(50),
        details NVARCHAR(MAX),
        total_recipients INT,
        sent_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE(),
        is_deleted INT DEFAULT 0
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

initializeDatabase();

const ALERT_LEVEL_COLORS = {
  low: { background: '#8C8C8CFF', text: '#FFFFFFFF' },
  medium: { background: '#6699FFFF', text: '#FFFFFFFF' },
  high: { background: '#E68A00FF', text: '#FFFFFFFF' },
  monster: { background: '#CC3300FF', text: '#FFFFFFFF' }
};

const STATUS_COLORS = {
  'Questionable': '#6699FFFF',
  'Injured': '#EF4444FF',
  'Starting': '#10B981FF',
  'Note': '#6B7280FF',
  'Doubtful': '#F97316FF',
  'Out': '#DC2626FF',
  'In Locker Room': '#F59E0BFF',
  'Playing': '#059669FF',
  'Off Injury Report': '#3B82F6FF'
};

function isValidPushToken(token) {
  return token && token.startsWith('ExponentPushToken[');
}

function getAlertEmoji(level) {
  const emojis = { low: 'ℹ️', medium: '⚠️', high: '🔥', monster: '🚨' };
  return emojis[level?.toLowerCase()] || '📢';
}

// ============================================
// API: HEALTH CHECK
// ============================================

app.get('/api/health', async (req, res) => {
  try {
    await pool.request().query('SELECT 1');
    res.json({ success: true, status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(500).json({ success: false, status: 'unhealthy', error: error.message });
  }
});

// ============================================
// API: ADD VALID CODES
// ============================================

app.post('/api/add-valid-codes', async (req, res) => {
  try {
    const { codes } = req.body;
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ success: false, error: 'codes array is required' });
    }

    const results = { added: [], skipped: [], errors: [] };

    for (const item of codes) {
      let code, league_count = 1;
      
      if (typeof item === 'string') {
        code = item.trim();
      } else if (typeof item === 'object' && item.code) {
        code = item.code;
        league_count = item.league_count || 1;
      } else {
        results.errors.push({ code: item, reason: 'Invalid format' });
        continue;
      }

      if (!code || code.trim() === '') {
        results.errors.push({ code: item, reason: 'Empty code' });
        continue;
      }

      const upperCode = code.trim().toUpperCase();

      try {
        const checkResult = await pool.request()
          .input('code', sql.NVarChar, upperCode)
          .query('SELECT code FROM valid_codes WHERE code = @code');

        if (checkResult.recordset.length === 0) {
          await pool.request()
            .input('code', sql.NVarChar, upperCode)
            .input('league_count', sql.Int, league_count)
            .query('INSERT INTO valid_codes (code, league_count) VALUES (@code, @league_count)');
          results.added.push({ code: upperCode, league_count });
        } else {
          results.skipped.push(upperCode);
        }
      } catch (err) {
        results.errors.push({ code: upperCode, reason: err.message });
      }
    }

    res.json({
      success: true,
      message: `Processed ${codes.length} codes`,
      added: results.added.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      details: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: GET VALID CODES
// ============================================

app.get('/api/valid-codes', async (req, res) => {
  try {
    const result = await pool.request().query('SELECT * FROM valid_codes ORDER BY created_at DESC');
    res.json({ success: true, codes: result.recordset, total: result.recordset.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: VERIFY CODE
// ============================================

app.get('/api/verify/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.request()
      .input('code', sql.NVarChar, code)
      .query('SELECT * FROM valid_codes WHERE code = @code');
    
    if (result.recordset.length > 0) {
      res.json({ success: true, valid: true, code: result.recordset[0].code, league_count: result.recordset[0].league_count });
    } else {
      res.json({ success: true, valid: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: DELETE CODE
// ============================================

app.delete('/api/delete-code/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.request()
      .input('code', sql.NVarChar, code)
      .query('DELETE FROM valid_codes WHERE code = @code');
    
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: 'Code not found' });
    }
    res.json({ success: true, message: `Code ${code} deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: GET DEVICES
// ============================================

app.get('/api/devices', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT d.*, v.league_count 
      FROM devices d
      LEFT JOIN valid_codes v ON d.code = v.code
      ORDER BY d.timestamp DESC
    `);
    res.json({ success: true, devices: result.recordset });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: REGISTER DEVICE
// ============================================

app.post('/api/register', async (req, res) => {
  try {
    const { code, pushToken } = req.body;
    if (!code || !pushToken) {
      return res.status(400).json({ success: false, error: 'code and pushToken are required' });
    }

    const upperCode = code.trim().toUpperCase();

    const validCodeResult = await pool.request()
      .input('code', sql.NVarChar, upperCode)
      .query('SELECT * FROM valid_codes WHERE code = @code');

    if (validCodeResult.recordset.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid code. Contact administrator.' });
    }

    if (!isValidPushToken(pushToken) && !pushToken.startsWith('simulator_token_')) {
      return res.status(400).json({ success: false, error: 'Invalid push token format' });
    }

    const registrationId = uuidv4();

    const checkDevice = await pool.request()
      .input('code', sql.NVarChar, upperCode)
      .query('SELECT code FROM devices WHERE code = @code');

    if (checkDevice.recordset.length > 0) {
      await pool.request()
        .input('code', sql.NVarChar, upperCode)
        .input('pushToken', sql.NVarChar, pushToken)
        .input('registrationId', sql.NVarChar, registrationId)
        .query('UPDATE devices SET pushToken = @pushToken, registrationId = @registrationId, timestamp = GETDATE() WHERE code = @code');
    } else {
      await pool.request()
        .input('code', sql.NVarChar, upperCode)
        .input('pushToken', sql.NVarChar, pushToken)
        .input('registrationId', sql.NVarChar, registrationId)
        .query('INSERT INTO devices (code, pushToken, registrationId) VALUES (@code, @pushToken, @registrationId)');
    }

    console.log(`✅ Device registered with code: ${upperCode}`);
    res.json({ success: true, message: 'Device registered successfully', registrationId });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: SEND ALERT
// ============================================

app.post('/api/alert', async (req, res) => {
  try {
    const { title, status, status_color, alert_level, details, users } = req.body;
    if (!title || !status || !alert_level || !users || users.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const finalStatusColor = status_color || STATUS_COLORS[status] || '#6B7280FF';
    const alert_id = uuidv4();
    let successful = 0, failed = 0;
    const messages = [];

    for (const user of users) {
      try {
        const deviceResult = await pool.request()
          .input('code', sql.NVarChar, user.user_id.toUpperCase())
          .query('SELECT * FROM devices WHERE code = @code');
        
        if (deviceResult.recordset.length === 0) {
          console.log(`❌ User ${user.user_id} not registered`);
          failed++;
          continue;
        }

        const device = deviceResult.recordset[0];

        await pool.request()
          .input('alert_id', sql.NVarChar, alert_id)
          .input('user_code', sql.NVarChar, user.user_id)
          .input('title', sql.NVarChar, title)
          .input('status', sql.NVarChar, status)
          .input('status_color', sql.NVarChar, finalStatusColor)
          .input('alert_level', sql.NVarChar, alert_level)
          .input('details', sql.NVarChar, details || '')
          .input('teams_affected', sql.Int, user.teams_affected || 0)
          .query(`INSERT INTO user_alerts (alert_id, user_code, title, status, status_color, alert_level, details, teams_affected) 
                  VALUES (@alert_id, @user_code, @title, @status, @status_color, @alert_level, @details, @teams_affected)`);

        let notificationBody = status;
        if (user.teams_affected > 0) notificationBody += ` [${user.teams_affected} teams]`;
        if (details) notificationBody += ` - ${details.substring(0, 100)}`;

        let notificationTitle = `${getAlertEmoji(alert_level)} `;
        if (alert_level.toLowerCase() === 'monster') notificationTitle += 'MONSTER ALERT - ';
        notificationTitle += title;

        messages.push({
          to: device.pushToken,
          sound: 'default',
          title: notificationTitle,
          body: notificationBody,
          data: { alert_id, status, alert_level, title, details, teams_affected: user.teams_affected },
          priority: 'high',
          channelId: 'default',
        });

        successful++;
      } catch (error) {
        console.error(`Error processing user ${user.user_id}:`, error);
        failed++;
      }
    }

    if (messages.length > 0) {
      try {
        const chunks = expo.chunkPushNotifications(messages);
        for (const chunk of chunks) {
          await expo.sendPushNotificationsAsync(chunk);
        }
        console.log(`✅ Sent ${messages.length} notifications`);
      } catch (error) {
        console.error('❌ Error sending push notifications:', error);
      }
    }

    await pool.request()
      .input('alert_id', sql.NVarChar, alert_id)
      .input('title', sql.NVarChar, title)
      .input('status', sql.NVarChar, status)
      .input('status_color', sql.NVarChar, finalStatusColor)
      .input('alert_level', sql.NVarChar, alert_level)
      .input('details', sql.NVarChar, details || '')
      .input('total_recipients', sql.Int, successful)
      .query(`INSERT INTO notifications (alert_id, title, status, status_color, alert_level, details, total_recipients) 
              VALUES (@alert_id, @title, @status, @status_color, @alert_level, @details, @total_recipients)`);

    res.json({ success: true, alert_id, successful, failed, total: users.length });
  } catch (error) {
    console.error('Error sending alert:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: GET USER ALERTS
// ============================================

app.get('/api/user/:code/alerts', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.request()
      .input('code', sql.NVarChar, code)
      .query('SELECT TOP 50 * FROM user_alerts WHERE user_code = @code AND is_deleted = 0 ORDER BY sent_at DESC');
    res.json({ success: true, alerts: result.recordset });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: GET NOTIFICATIONS
// ============================================

app.get('/api/notifications', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await pool.request()
      .input('limit', sql.Int, limit)
      .query('SELECT TOP (@limit) * FROM notifications WHERE is_deleted = 0 ORDER BY sent_at DESC');
    res.json({ success: true, notifications: result.recordset });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: UPDATE ALERT
// ============================================

app.put('/api/alerts/:alert_id', async (req, res) => {
  try {
    const { alert_id } = req.params;
    const { title, status, status_color, alert_level, details } = req.body;
    const finalStatusColor = status_color || STATUS_COLORS[status] || '#6B7280FF';

    await pool.request()
      .input('title', sql.NVarChar, title)
      .input('status', sql.NVarChar, status)
      .input('status_color', sql.NVarChar, finalStatusColor)
      .input('alert_level', sql.NVarChar, alert_level)
      .input('details', sql.NVarChar, details || '')
      .input('alert_id', sql.NVarChar, alert_id)
      .query('UPDATE user_alerts SET title = @title, status = @status, status_color = @status_color, alert_level = @alert_level, details = @details, updated_at = GETDATE() WHERE alert_id = @alert_id');

    await pool.request()
      .input('title', sql.NVarChar, title)
      .input('status', sql.NVarChar, status)
      .input('status_color', sql.NVarChar, finalStatusColor)
      .input('alert_level', sql.NVarChar, alert_level)
      .input('details', sql.NVarChar, details || '')
      .input('alert_id', sql.NVarChar, alert_id)
      .query('UPDATE notifications SET title = @title, status = @status, status_color = @status_color, alert_level = @alert_level, details = @details, updated_at = GETDATE() WHERE alert_id = @alert_id');

    res.json({ success: true, message: 'Alert updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// API: DELETE ALERT
// ============================================

app.delete('/api/alerts/:alert_id', async (req, res) => {
  try {
    const { alert_id } = req.params;

    await pool.request()
      .input('alert_id', sql.NVarChar, alert_id)
      .query('UPDATE user_alerts SET is_deleted = 1 WHERE alert_id = @alert_id');

    await pool.request()
      .input('alert_id', sql.NVarChar, alert_id)
      .query('UPDATE notifications SET is_deleted = 1 WHERE alert_id = @alert_id');

    res.json({ success: true, message: 'Alert deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/status-colors', (req, res) => res.json({ success: true, colors: STATUS_COLORS }));
app.get('/api/alert-level-colors', (req, res) => res.json({ success: true, colors: ALERT_LEVEL_COLORS }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏀 Basketball Monster Server (Azure SQL) running on port ${PORT}`);
});
