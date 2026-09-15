const express = require('express');
const router = express.Router();

// Teacher credentials: loaded from TEACHER_CREDENTIALS env var (JSON string) if available,
// otherwise falls back to defaults for local development.
// Format: {"email@example.com":{"password":"pw"}, ...}
let USERS;
try {
    USERS = process.env.TEACHER_CREDENTIALS
        ? JSON.parse(process.env.TEACHER_CREDENTIALS)
        : {
            'tutor@skymeet.com': { password: 'tutorpassword' },
            'sara@skymeet.com': { password: 'sarapassword' }
          };
} catch (err) {
    console.error('❌ Failed to parse TEACHER_CREDENTIALS env var:', err.message);
    USERS = {
        'tutor@skymeet.com': { password: 'tutorpassword' },
        'sara@skymeet.com': { password: 'sarapassword' }
    };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        let { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Robust check: trim and lowercase
        const cleanEmail = email.trim().toLowerCase();
        const user = USERS[cleanEmail];

        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Return success with the provided name (dynamic)
        res.json({ success: true, teacherName: name || 'Teacher' });
    } catch (err) {
        console.error('❌ LOGIN ERROR:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

module.exports = router;
