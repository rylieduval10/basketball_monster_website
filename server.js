// server-with-new-alerts.js
// Basketball Monster Server - Updated Alert System

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const { Expo } = require('expo-server-sdk');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./devices.db');
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
  useFcmV1: true
});

// ============================================
// DATABASE INITIALIZATION
// ============================================

db.serialize(() => {
  // Valid codes table (with league count)
  db.run(`
    CREATE TABLE IF NOT EXISTS valid_codes (
      code TEXT PRIMARY KEY,
      league_count INTEGER DEFAULT 1,
      created_at TEXT
    )
  `);

  // Devices table
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      code TEXT PRIMARY KEY,
      pushToken TEXT,
      registrationId TEXT,
      timestamp TEXT
    )
  `);

  // User alerts table - NEW STRUCTURE
  db.run(`
    CREATE TABLE IF NOT EXISTS user_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT,
      user_code TEXT,
      title TEXT,
      status TEXT,
      status_color TEXT,
      alert_level TEXT,
      details TEXT,
      teams_affected INTEGER DEFAULT 0,
      sent_at TEXT,
      updated_at TEXT,
      is_deleted INTEGER DEFAULT 0
    )
  `);

  // Notifications history - NEW STRUCTURE
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT UNIQUE,
      title TEXT,
      status TEXT,
      status_color TEXT,
      alert_level TEXT,
      details TEXT,
      total_recipients INTEGER,
      sent_at TEXT,
      updated_at TEXT,
      is_deleted INTEGER DEFAULT 0
    )
  `);

  console.log('✅ Database tables initialized');
});

// ============================================
// ALERT LEVEL COLORS (from boss)
// ============================================

const ALERT_LEVEL_COLORS = {
  low: { background: '#8C8C8CFF', text: '#FFFFFFFF' },
  medium: { background: '#6699FFFF', text: '#FFFFFFFF' },
  high: { background: '#E68A00FF', text: '#FFFFFFFF' },
  monster: { background: '#CC3300FF', text: '#FFFFFFFF' }
};

// ============================================
// STATUS TYPE COLORS (reasonable defaults)
// ============================================

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

// ============================================
// HELPER FUNCTIONS
// ============================================

function isValidPushToken(token) {
  return token && token.startsWith('ExponentPushToken[');
}

function getAlertEmoji(level) {
  const emojis = {
    low: 'ℹ️',
    medium: '⚠️',
    high: '🔥',
    monster: '🚨'
  };
  return emojis[level?.toLowerCase()] || '📢';
}

function getDevice(code) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM devices WHERE code = ?', [code.toUpperCase()], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function getLeagueCount(code) {
  return new Promise((resolve, reject) => {
    db.get('SELECT league_count FROM valid_codes WHERE code = ?', [code.toUpperCase()], (err, row) => {
      if (err) reject(err);
      else resolve(row?.league_count || 1);
    });
  });
}

function insertUserAlert(alert_id, user_code, title, status, status_color, alert_level, details, teams_affected) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString();
    db.run(
      `INSERT INTO user_alerts 
       (alert_id, user_code, title, status, status_color, alert_level, details, teams_affected, sent_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [alert_id, user_code, title, status, status_color, alert_level, details, teams_affected, timestamp, timestamp],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function insertNotification(alert_id, title, status, status_color, alert_level, details, total_recipients) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString();
    db.run(
      `INSERT INTO notifications 
       (alert_id, title, status, status_color, alert_level, details, total_recipients, sent_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [alert_id, title, status, status_color, alert_level, details, total_recipients, timestamp, timestamp],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// ============================================
// API: GET STATUS COLORS
// ============================================

app.get('/api/status-colors', (req, res) => {
  res.json({
    success: true,
    colors: STATUS_COLORS
  });
});

// ============================================
// API: GET ALERT LEVEL COLORS
// ============================================

app.get('/api/alert-level-colors', (req, res) => {
  res.json({
    success: true,
    colors: ALERT_LEVEL_COLORS
  });
});

// ============================================
// API: ADD VALID CODES
// ============================================

app.post('/api/add-valid-codes', async (req, res) => {
  try {
    const { codes } = req.body;

    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'codes array is required'
      });
    }

    const results = { added: [], skipped: [], errors: [] };
    const promises = codes.map(item => {
      return new Promise((resolve) => {
        let code, league_count = 1;
        
        if (typeof item === 'string') {
          code = item.trim();
        } else if (typeof item === 'object' && item.code) {
          code = item.code;
          league_count = item.league_count || 1;
        } else {
          results.errors.push({ code: item, reason: 'Invalid format' });
          resolve();
          return;
        }

        if (!code || code.trim() === '') {
          results.errors.push({ code: item, reason: 'Empty code' });
          resolve();
          return;
        }

        const upperCode = code.trim().toUpperCase();
        const timestamp = new Date().toISOString();

        db.run(
          'INSERT OR IGNORE INTO valid_codes (code, league_count, created_at) VALUES (?, ?, ?)',
          [upperCode, league_count, timestamp],
          function(err) {
            if (err) {
              results.errors.push({ code: upperCode, reason: err.message });
            } else if (this.changes > 0) {
              results.added.push({ code: upperCode, league_count });
            } else {
              results.skipped.push(upperCode);
            }
            resolve();
          }
        );
      });
    });

    await Promise.all(promises);

    res.json({
      success: true,
      message: `Processed ${codes.length} codes`,
      added: results.added.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      details: results
    });

  } catch (error) {
    console.error('Error adding codes:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: GET VALID CODES
// ============================================

app.get('/api/valid-codes', (req, res) => {
  db.all('SELECT * FROM valid_codes ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({
      success: true,
      codes: rows,
      total: rows.length
    });
  });
});

// ============================================
// API: GET DEVICES
// ============================================

app.get('/api/devices', (req, res) => {
  db.all(`
    SELECT d.*, v.league_count 
    FROM devices d
    LEFT JOIN valid_codes v ON d.code = v.code
    ORDER BY d.timestamp DESC
  `, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({
      success: true,
      devices: rows
    });
  });
});

// ============================================
// API: REGISTER DEVICE
// ============================================

app.post('/api/register', async (req, res) => {
  try {
    const { code, pushToken } = req.body;

    if (!code || !pushToken) {
      return res.status(400).json({
        success: false,
        error: 'code and pushToken are required'
      });
    }

    const upperCode = code.trim().toUpperCase();

    const validCode = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM valid_codes WHERE code = ?', [upperCode], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!validCode) {
      return res.status(400).json({
        success: false,
        error: 'Invalid code. Contact administrator.'
      });
    }

    if (!isValidPushToken(pushToken) && !pushToken.startsWith('simulator_token_')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid push token format'
      });
    }

    const registrationId = uuidv4();
    const timestamp = new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT OR REPLACE INTO devices (code, pushToken, registrationId, timestamp) VALUES (?, ?, ?, ?)',
        [upperCode, pushToken, registrationId, timestamp],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    console.log(`✅ Device registered with code: ${upperCode}`);

    res.json({
      success: true,
      message: 'Device registered successfully',
      registrationId
    });

  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: SEND ALERT (NEW STRUCTURE)
// ============================================

app.post('/api/alert', async (req, res) => {
  try {
    const { title, status, status_color, alert_level, details, users } = req.body;

    if (!title || !status || !alert_level || !users || users.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, status, alert_level, users'
      });
    }

    // Use provided status_color or default from our map
    const finalStatusColor = status_color || STATUS_COLORS[status] || '#6B7280FF';

    const alert_id = uuidv4();
    let successful = 0;
    let failed = 0;

    const messages = [];

    for (const user of users) {
      try {
        const device = await getDevice(user.user_id);
        
        if (!device) {
          console.log(`❌ User ${user.user_id} not registered`);
          failed++;
          continue;
        }

        // Store alert
        await insertUserAlert(
          alert_id,
          user.user_id,
          title,
          status,
          finalStatusColor,
          alert_level,
          details,
          user.teams_affected || 0
        );

        // Build notification body
        let notificationBody = status;
        
        if (user.teams_affected > 0) {
          notificationBody += ` [${user.teams_affected} teams]`;
        }

        if (details) {
          notificationBody += ` - ${details.substring(0, 100)}`;
        }

        // Build notification title - Add MONSTER ALERT for critical alerts
        let notificationTitle = `${getAlertEmoji(alert_level)} `;
        if (alert_level.toLowerCase() === 'monster') {
          notificationTitle += 'MONSTER ALERT - ';
        }
        notificationTitle += title;

        messages.push({
          to: device.pushToken,
          sound: 'default',
          title: notificationTitle,
          body: notificationBody,
          data: {
            alert_id,
            status,
            alert_level,
            title,
            details,
            teams_affected: user.teams_affected
          },
          priority: 'high',
          channelId: 'default',
        });

        successful++;
      } catch (error) {
        console.error(`Error processing user ${user.user_id}:`, error);
        failed++;
      }
    }

    // Send push notifications
    if (messages.length > 0) {
      try {
        const chunks = expo.chunkPushNotifications(messages);
        const tickets = [];

        for (const chunk of chunks) {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        }

        console.log(`✅ Sent ${messages.length} notifications`);
      } catch (error) {
        console.error('❌ Error sending push notifications:', error);
      }
    }

    // Store notification in history
    await insertNotification(
      alert_id,
      title,
      status,
      finalStatusColor,
      alert_level,
      details,
      successful
    );

    res.json({
      success: true,
      alert_id,
      successful,
      failed,
      total: users.length
    });

  } catch (error) {
    console.error('Error sending alert:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: GET USER ALERTS
// ============================================

app.get('/api/user/:code/alerts', (req, res) => {
  const code = req.params.code.toUpperCase();
  
  db.all(
    `SELECT * FROM user_alerts 
     WHERE user_code = ? AND is_deleted = 0 
     ORDER BY sent_at DESC 
     LIMIT 50`,
    [code],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({
        success: true,
        alerts: rows
      });
    }
  );
});

// ============================================
// API: GET NOTIFICATIONS (Dashboard History)
// ============================================

app.get('/api/notifications', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  
  db.all(
    'SELECT * FROM notifications WHERE is_deleted = 0 ORDER BY sent_at DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({
        success: true,
        notifications: rows
      });
    }
  );
});

// ============================================
// API: UPDATE ALERT
// ============================================

app.put('/api/alerts/:alert_id', async (req, res) => {
  try {
    const { alert_id } = req.params;
    const { title, status, status_color, alert_level, details } = req.body;

    const finalStatusColor = status_color || STATUS_COLORS[status] || '#6B7280FF';
    const updated_at = new Date().toISOString();

    // Update user_alerts
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE user_alerts 
         SET title = ?, status = ?, status_color = ?, alert_level = ?, details = ?, updated_at = ?
         WHERE alert_id = ?`,
        [title, status, finalStatusColor, alert_level, details, updated_at, alert_id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Update notifications
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE notifications 
         SET title = ?, status = ?, status_color = ?, alert_level = ?, details = ?, updated_at = ?
         WHERE alert_id = ?`,
        [title, status, finalStatusColor, alert_level, details, updated_at, alert_id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Alert updated successfully'
    });

  } catch (error) {
    console.error('Error updating alert:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// API: DELETE ALERT (Soft Delete)
// ============================================

app.delete('/api/alerts/:alert_id', async (req, res) => {
  try {
    const { alert_id } = req.params;

    // Soft delete from user_alerts
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE user_alerts SET is_deleted = 1 WHERE alert_id = ?',
        [alert_id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Soft delete from notifications
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE notifications SET is_deleted = 1 WHERE alert_id = ?',
        [alert_id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({
      success: true,
      message: 'Alert deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting alert:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
🏀 Basketball Monster Server (NEW ALERT SYSTEM) running on port ${PORT}
📱 View dashboard at: http://localhost:${PORT}

📡 API Endpoints:
   POST   /api/add-valid-codes - Add codes with league counts
   GET    /api/valid-codes - Get all valid codes
   GET    /api/devices - Get all registered devices
   POST   /api/register - Register device with code
   POST   /api/alert - Send new alert (NEW STRUCTURE)
   GET    /api/user/:code/alerts - Get alerts for user
   GET    /api/notifications - Get dashboard history
   PUT    /api/alerts/:alert_id - Update alert
   DELETE /api/alerts/:alert_id - Delete alert
   GET    /api/status-colors - Get status color mappings
   GET    /api/alert-level-colors - Get alert level colors

✅ Ready! New alert structure with status types and colors!
  `);
});