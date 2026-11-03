const db = require('../utils/db');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenAI } = require("@google/genai");

const useVertexAI = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
const client = new GoogleGenAI(useVertexAI ? {
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
} : {
  apiKey: process.env.GEMINI_API_KEY,
});

const normalizeName = (name) => {
  if (!name) return 'Unknown';
  return name.toString().trim().toLowerCase().replace(/\s+/g, ' ');
};

const normalizeDate = (dateStr) => {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  try {
    // If it's a full ISO string, parse it properly
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      // Return YYYY-MM-DD
      return d.toISOString().split('T')[0];
    }
    
    // Basic extraction if format is DD-MM-YYYY
    const parts = dateStr.toString().split('-');
    if (parts.length === 3 && parts[0].length === 2 && parts[2].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`; // Convert to YYYY-MM-DD
    }
    
    return dateStr;
  } catch (e) {
    return dateStr;
  }
};

const normalizeTopic = (topic) => {
  if (!topic) return 'Unknown Topic';
  let t = topic.toString().trim().toLowerCase().replace(/-/g, ' ').replace(/_/g, ' ');
  if (t === 'general topic' || t === 'unknown topic') return t;
  return t.replace(/\b\w/g, l => l.toUpperCase());
};

const normalizeCourse = (course) => {
  if (!course) return 'General';
  let c = course.toString().trim();
  // Keep original casing mostly, maybe just capitalize first letter if not acronym
  if (c.toUpperCase() === c) return c; // e.g. TNPSC
  return c.replace(/\b\w/g, l => l.toUpperCase());
};

const calculateEngagement = (session) => {
  if (session.attendance_duration === null && session.questions_asked === null && session.quiz_completed === null) return null;
  // Start with a base of 50.
  // Add 20 points for attending more than 20 minutes.
  // Add 10 points for completing a quiz.
  // Add 10 points for asking at least one question.
  // Add 10 points if they got any correct answers.
  let score = 50; 
  if (session.attendance_duration && session.attendance_duration > 1200) score += 20; 
  if (session.quiz_completed) score += 10;
  if (session.questions_asked > 0) score += 10;
  if (session.correct_answers > 0) score += 10;
  return Math.max(0, Math.min(100, score));
};

const calculateAttention = (session) => {
  if (session.away_time === null && session.warnings === null && session.tab_switches === null) return null;
  // Start at 100.
  // Deduct 1 point per minute of away time.
  // Deduct 1 point per minute of inactive time.
  // Deduct 5 points per warning.
  // Deduct 2 points per tab switch.
  let score = 100;
  if (session.away_time) score -= session.away_time / 60; // 1 point per min
  if (session.inactive_time) score -= session.inactive_time / 60;
  if (session.warnings) score -= session.warnings * 5;
  if (session.tab_switches) score -= session.tab_switches * 2;
  return Math.max(0, Math.min(100, score));
};

exports.getOverview = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT 
        COUNT(DISTINCT normalized_student_name) as totalStudents,
        COUNT(DISTINCT CONCAT(date, topic, sub_topic)) as totalClasses,
        AVG(quiz_score) as averageScore, AVG(engagement_score) as averageEngagement, AVG(attendance_duration) as averageAttendance,
        AVG(engagement_score) as averageEngagement,
        AVG(attention_score) as averageAttention,
        SUM(questions_asked) as totalQuestions,
        AVG(attendance_duration) as averageAttendance
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (topic && topic !== 'All Topics') { sql += ` AND topic = ?`; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ` AND sub_topic = ?`; params.push(subTopic); }
    if (startDate) { sql += ` AND date >= ?`; params.push(startDate); }
    if (endDate) { sql += ` AND date <= ?`; params.push(endDate); }
    
    const [rows] = await db.query(sql, params);
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getTopics = async (req, res) => {
  try {
    
    let sql = 'SELECT DISTINCT topic FROM analytics_sessions WHERE 1=1';
    let params = [];
        sql += ' ORDER BY topic';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => r.topic));
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getSubTopics = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = 'SELECT DISTINCT sub_topic FROM analytics_sessions WHERE 1=1';
    let params = [];
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    sql += ' ORDER BY sub_topic';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => r.sub_topic));
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getCourses = async (req, res) => { res.json([]); }

exports.getTopicTrend = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT date,
             AVG(quiz_score) as averageScore,
             AVG(engagement_score) as averageEngagement,
             AVG(attention_score) as averageAttention,
             AVG(attendance_duration) as averageAttendance
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    sql += ` GROUP BY date ORDER BY date ASC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getTopicStudents = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT student_name,
             AVG(quiz_score) as averageScore,
             AVG(attendance_duration) as averageAttendance,
             AVG(engagement_score) as averageEngagement,
             AVG(attention_score) as averageAttention,
             COUNT(source_quiz_report) as completedQuizzes
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    sql += ` GROUP BY normalized_student_name, student_name ORDER BY averageScore DESC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

// NEW APIS

exports.getDates = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = 'SELECT DISTINCT date FROM analytics_sessions WHERE 1=1';
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }
    
    sql += ' ORDER BY date ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(r => r.date));
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getTopicComparison = async (req, res) => {
  try {
    let sql = `
      SELECT topic,
             COUNT(DISTINCT date) as classes,
             AVG(quiz_score) as averageScore,
             AVG(attendance_duration) as averageAttendance,
             AVG(engagement_score) as averageEngagement
      FROM analytics_sessions
      GROUP BY topic
    `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getEngagementStats = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT student_name,
             AVG(engagement_score) as engagement,
             AVG(attention_score) as attention
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    sql += ` GROUP BY normalized_student_name, student_name`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getSubTopicPerformance = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT sub_topic,
             AVG(quiz_score) as averageScore,
             COUNT(DISTINCT normalized_student_name) as students,
             SUM(questions_asked) as questions
      FROM analytics_sessions
      WHERE sub_topic IS NOT NULL
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    sql += ` GROUP BY sub_topic ORDER BY averageScore DESC`;
    
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getLearningJourney = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT date, sub_topic,
             COUNT(DISTINCT normalized_student_name) as students,
             AVG(quiz_score) as averageScore
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    sql += ` GROUP BY date, sub_topic ORDER BY date ASC`;
    
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getStudentProgress = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    if (!student) return res.status(400).json({ error: 'Student parameter is required' });
    const sql = `SELECT date, topic, sub_topic, quiz_score as score, engagement_score as engagement, attention_score as attention, attendance_duration as stay, questions_asked as questions
                 FROM analytics_sessions 
                 WHERE normalized_student_name = ?
                 ORDER BY date ASC`;
    const [rows] = await db.query(sql, [student.toLowerCase()]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getActivityBreakdown = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `SELECT student_name, away_time, inactive_time, background_time, warnings, tab_switches
               FROM analytics_sessions WHERE 1=1`;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getQuestionsAnalytics = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `SELECT student_name, date, topic, question_text, questions_asked
               FROM analytics_sessions WHERE questions_asked > 0 AND question_text IS NOT NULL`;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getWeakAreas = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `SELECT student_name, topic, sub_topic, quiz_score, attention_score
               FROM analytics_sessions 
               WHERE (quiz_score < 50 OR attention_score < 50)`;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    sql += ` ORDER BY quiz_score ASC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getQuizStats = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT 
        COUNT(quiz_score) as attempts,
        AVG(quiz_score) as averageScore,
        MAX(quiz_score) as highestScore,
        MIN(quiz_score) as lowestScore,
        AVG(correct_answers) as avgCorrectAnswers
      FROM analytics_sessions WHERE quiz_score IS NOT NULL
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    const [rows] = await db.query(sql, params);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getStudents = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT student_name,
             AVG(quiz_score) as averageScore,
             AVG(attendance_duration) as averageAttendance,
             AVG(engagement_score) as averageEngagement,
             AVG(attention_score) as averageAttention,
             SUM(questions_asked) as questionsAsked,
             COUNT(source_quiz_report) as completedQuizzes
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); }
    if (student) { sql += ` AND normalized_student_name = ?`; params.push(normalizeName(student)); }
    
    sql += ` GROUP BY normalized_student_name, student_name ORDER BY averageScore DESC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getRiskStudents = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT student_name,
             AVG(quiz_score) as averageScore,
             AVG(attendance_duration) as averageAttendance,
             AVG(engagement_score) as averageEngagement,
             SUM(warnings) as totalWarnings,
             AVG(inactive_time) as avgInactiveTime
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    
    sql += ` GROUP BY normalized_student_name, student_name
             HAVING averageScore < 50 OR averageEngagement < 50 OR totalWarnings > 5 OR avgInactiveTime > 300
             ORDER BY averageScore ASC, averageEngagement ASC
             LIMIT 10`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getAiInsight = async (req, res) => {
  try {
    const { data, studentName } = req.body; 
    
    let contextStr = "an aggregated class data";
    if (studentName) contextStr = `data for a specific student named ${studentName}`;
    
    const prompt = `As an expert AI Teacher Assistant, analyze this ${contextStr} and provide a concise, actionable report.
DATA: ${JSON.stringify(data, null, 2)}

You MUST strictly format your response with these exact 6 bullet points. Use Markdown:
1. **What happened**: (Summary of the session data)
2. **Strong areas**: (Which students/topics performed well)
3. **Weak areas**: (Which students/topics failed)
4. **Students needing attention**: (Specific names and why)
5. **Next steps**: (Actionable advice for the teacher)
6. **Next topic recommendation**: (What to teach next based on gaps)

Do NOT invent random statistics. Base everything strictly on the DATA provided.`;
    
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    res.json({ insight: response.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getSessions = async (req, res) => {
  try {
    const { topic = req.query.topic || req.params.topic, subTopic = req.query.subTopic || req.params.subTopic, date = req.query.date, startDate = req.query.startDate, endDate = req.query.endDate, student = req.query.student || req.params.student } = Object.assign({}, req.query, req.params);
    let sql = `
      SELECT *
      FROM analytics_sessions WHERE 1=1
    `;
    let params = [];
    
        if (topic && topic !== 'All Topics') { sql += ' AND topic = ?'; params.push(topic); }
    if (subTopic && subTopic !== 'All Topics') { sql += ' AND sub_topic = ?'; params.push(subTopic); }

    if (date) { sql += ` AND date = ?`; params.push(date); } // date variable here actually receives session_id from frontend
    if (student && student !== 'All Students') { sql += ` AND normalized_student_name = ?`; params.push(normalizeName(student)); }
    
    sql += ` ORDER BY date ASC, student_name ASC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
exports.getRecentClasses = async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT topic, sub_topic, date, COUNT(DISTINCT normalized_student_name) as students
      FROM analytics_sessions
      GROUP BY topic, sub_topic, date
      ORDER BY date DESC
      LIMIT 10
    `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};


exports.getAdminMeetings = async (req, res) => {
  try {
    const sql = `
      SELECT 
        topic, 
        COALESCE(sub_topic, 'General') AS sub_topic, 
        DATE_FORMAT(date, '%Y-%m-%d') AS date,
        COUNT(DISTINCT normalized_student_name) AS joined_students_count,
        ROUND(AVG(attendance_duration), 0) AS avg_attendance_duration,
        ROUND(AVG(quiz_score), 1) AS avg_quiz_score,
        ROUND(AVG(engagement_score), 1) AS avg_engagement_score,
        ROUND(AVG(attention_score), 1) AS avg_attention_score,
        COALESCE(SUM(warnings), 0) AS total_warnings,
        COALESCE(SUM(tab_switches), 0) AS total_tab_switches,
        COALESCE(SUM(questions_asked), 0) AS total_questions_asked,
        COUNT(CASE WHEN source_class_report IS NOT NULL THEN 1 END) AS has_class_report,
        COUNT(CASE WHEN source_quiz_report IS NOT NULL THEN 1 END) AS has_quiz_report,
        COUNT(CASE WHEN source_activity_report IS NOT NULL THEN 1 END) AS has_activity_report
      FROM analytics_sessions
      GROUP BY topic, COALESCE(sub_topic, 'General'), DATE_FORMAT(date, '%Y-%m-%d')
      ORDER BY date DESC
    `;
    const [rows] = await db.query(sql);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getMeetingConsolidated = async (req, res) => {
  try {
    const { topic, subTopic, date } = req.query;
    if (!topic || !date) {
      return res.status(400).json({ error: 'topic and date are required' });
    }

    // Clean date to YYYY-MM-DD
    let cleanDate = date;
    if (typeof date === 'string' && date.includes('T')) {
      cleanDate = date.split('T')[0];
    }

    let sql = `
      SELECT *, DATE_FORMAT(date, '%Y-%m-%d') AS formatted_date 
      FROM analytics_sessions 
      WHERE topic = ? 
        AND (DATE_FORMAT(date, '%Y-%m-%d') = ? OR DATE(date) = ? OR date = ?)
    `;
    let params = [topic, cleanDate, cleanDate, cleanDate];

    if (subTopic && subTopic !== 'All Topics' && subTopic !== 'All Sub Topics' && subTopic !== 'General') {
      sql += ' AND (sub_topic = ? OR sub_topic IS NULL)';
      params.push(subTopic);
    }

    sql += ' ORDER BY student_name ASC';
    const [students] = await db.query(sql, params);

    const totalStudents = students.length;
    let totalScore = 0, scoreCount = 0;
    let totalDuration = 0, durationCount = 0;
    let totalEngagement = 0, engCount = 0;
    let totalAttention = 0, attCount = 0;
    let totalWarnings = 0, totalTabSwitches = 0, totalQuestions = 0;
    let classReportCount = 0, quizReportCount = 0, activityReportCount = 0;

    students.forEach(s => {
      if (s.quiz_score !== null && s.quiz_score !== undefined) {
        totalScore += parseFloat(s.quiz_score);
        scoreCount++;
      }
      if (s.attendance_duration !== null && s.attendance_duration !== undefined) {
        totalDuration += parseInt(s.attendance_duration);
        durationCount++;
      }
      if (s.engagement_score !== null && s.engagement_score !== undefined) {
        totalEngagement += parseFloat(s.engagement_score);
        engCount++;
      }
      if (s.attention_score !== null && s.attention_score !== undefined) {
        totalAttention += parseFloat(s.attention_score);
        attCount++;
      }
      if (s.warnings) totalWarnings += parseInt(s.warnings);
      if (s.tab_switches) totalTabSwitches += parseInt(s.tab_switches);
      if (s.questions_asked) totalQuestions += parseInt(s.questions_asked);
      if (s.source_class_report) classReportCount++;
      if (s.source_quiz_report) quizReportCount++;
      if (s.source_activity_report) activityReportCount++;
    });

    res.json({
      meeting: {
        topic,
        subTopic: subTopic || (students[0] && students[0].sub_topic) || 'General',
        date: cleanDate,
        total_students_joined: totalStudents,
        avg_quiz_score: scoreCount > 0 ? Math.round(totalScore / scoreCount) : null,
        avg_attendance_duration: durationCount > 0 ? Math.round(totalDuration / durationCount) : null,
        avg_engagement_score: engCount > 0 ? Math.round(totalEngagement / engCount) : null,
        avg_attention_score: attCount > 0 ? Math.round(totalAttention / attCount) : null,
        total_warnings: totalWarnings,
        total_tab_switches: totalTabSwitches,
        total_questions_asked: totalQuestions,
        reports_attached: {
          class_report: classReportCount > 0,
          quiz_report: quizReportCount > 0,
          activity_report: activityReportCount > 0
        }
      },
      students
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};


exports.saveLiveSessionAnalytics = async ({
  roomName,
  topic = 'General',
  subTopic = 'General',
  attendance = {},
  doubts = [],
  quizId = null,
  quizzes = {},
  studentActivitiesData = {}
}) => {
  try {
    const cleanTopic = topic || 'General';
    const cleanSubTopic = subTopic || 'General';
    const today = new Date().toISOString().split('T')[0];

    // Find quiz for this room
    let quiz = null;
    if (quizId && quizzes[quizId]) {
      quiz = quizzes[quizId];
    } else if (quizzes) {
      quiz = Object.values(quizzes).reverse().find(q => q.roomName === roomName || q.topic === cleanSubTopic || q.topic === cleanTopic) || null;
    }

    // Activity data for this room
    const roomActivities = (studentActivitiesData && roomName && studentActivitiesData[roomName]) ? studentActivitiesData[roomName] : {};

    // Collect all unique student names
    const studentMap = {}; // normalized_name -> data

    // 1. Process Attendance
    if (attendance) {
      Object.values(attendance).forEach(s => {
        if (!s || !s.identity) return;
        const role = (s.role || '').toLowerCase();
        if (role === 'teacher') return;

        const originalName = s.identity.trim();
        const normName = originalName.toLowerCase();
        if (normName === 'teacher') return;

        let staySecs = 0;
        if (s.totalStayTime) {
          staySecs = Math.round(s.totalStayTime / 1000);
        }
        if (s.status === 'online' && s.lastJoined) {
          staySecs += Math.round((Date.now() - s.lastJoined) / 1000);
        }

        studentMap[normName] = {
          student_name: originalName,
          normalized_student_name: normName,
          attendance_duration: staySecs > 0 ? staySecs : 60,
          join_count: s.joinCount || 1,
          quiz_score: null,
          correct_answers: null,
          total_questions: null,
          quiz_completed: false,
          away_time: 0,
          inactive_time: 0,
          background_time: 0,
          warnings: 0,
          tab_switches: 0,
          questions_asked: 0,
          question_text: '',
          has_attendance: true
        };
      });
    }

    // 2. Process Quiz Submissions
    if (quiz && Array.isArray(quiz.submissions)) {
      quiz.submissions.forEach(sub => {
        if (!sub || !sub.studentName) return;
        const originalName = sub.studentName.trim();
        const normName = originalName.toLowerCase();
        if (normName === 'teacher') return;

        if (!studentMap[normName]) {
          studentMap[normName] = {
            student_name: originalName,
            normalized_student_name: normName,
            attendance_duration: null,
            join_count: 1,
            away_time: 0,
            inactive_time: 0,
            background_time: 0,
            warnings: 0,
            tab_switches: 0,
            questions_asked: 0,
            question_text: '',
            has_attendance: false
          };
        }

        studentMap[normName].quiz_score = typeof sub.score === 'number' ? sub.score : null;
        studentMap[normName].correct_answers = sub.correctCount !== undefined ? sub.correctCount : null;
        studentMap[normName].total_questions = sub.totalQuestions !== undefined ? sub.totalQuestions : (quiz.questions ? quiz.questions.length : null);
        studentMap[normName].quiz_completed = true;
        if (sub.browserSwitchCount) {
          studentMap[normName].tab_switches = Math.max(studentMap[normName].tab_switches || 0, sub.browserSwitchCount);
        }
      });
    }

    // 3. Process Activity & Proctoring Data
    if (roomActivities) {
      Object.entries(roomActivities).forEach(([sName, act]) => {
        if (!sName || !act) return;
        const normName = sName.trim().toLowerCase();
        if (normName === 'teacher') return;

        if (!studentMap[normName]) {
          studentMap[normName] = {
            student_name: sName.trim(),
            normalized_student_name: normName,
            attendance_duration: null,
            join_count: 1,
            quiz_score: null,
            correct_answers: null,
            total_questions: null,
            quiz_completed: false,
            questions_asked: 0,
            question_text: '',
            has_attendance: false
          };
        }

        studentMap[normName].away_time = Math.round(act.awayTime || 0);
        studentMap[normName].inactive_time = Math.round(act.inactiveTime || 0);
        studentMap[normName].background_time = Math.round(act.backgroundTime || 0);
        studentMap[normName].warnings = act.warningCount || 0;
      });
    }

    // 4. Process Doubts / Questions
    if (Array.isArray(doubts)) {
      doubts.forEach(d => {
        if (!d || !d.name) return;
        const normName = d.name.trim().toLowerCase();
        if (studentMap[normName]) {
          studentMap[normName].questions_asked = (studentMap[normName].questions_asked || 0) + 1;
          const text = d.text || '';
          studentMap[normName].question_text = studentMap[normName].question_text 
            ? `${studentMap[normName].question_text}; ${text}`
            : text;
        }
      });
    }

    const studentsToSave = Object.values(studentMap);
    if (studentsToSave.length === 0) {
      console.log(`[LIVE ANALYTICS] No student records to save for room: ${roomName}`);
      return { success: true, count: 0 };
    }

    // 5. Calculate scores and save to MySQL
    for (const session of studentsToSave) {
      session.engagement_score = calculateEngagement(session);
      session.attention_score = calculateAttention(session);
      session.overall_score = session.quiz_score !== null ? session.quiz_score : null;

      const recordId = uuidv4();
      const studentId = session.normalized_student_name.replace(/\s+/g, '');

      const sql = `
        INSERT INTO analytics_sessions (
          id, student_id, student_name, normalized_student_name, date, topic, sub_topic,
          attendance_duration, join_count, quiz_score, correct_answers, total_questions, quiz_completed,
          away_time, inactive_time, background_time, warnings, tab_switches, violations,
          questions_asked, question_text, engagement_score, attention_score, overall_score,
          source_class_report, source_quiz_report, source_activity_report
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          attendance_duration = COALESCE(VALUES(attendance_duration), attendance_duration),
          join_count = COALESCE(VALUES(join_count), join_count),
          quiz_score = COALESCE(VALUES(quiz_score), quiz_score),
          correct_answers = COALESCE(VALUES(correct_answers), correct_answers),
          total_questions = COALESCE(VALUES(total_questions), total_questions),
          quiz_completed = COALESCE(VALUES(quiz_completed), quiz_completed),
          away_time = COALESCE(VALUES(away_time), away_time),
          inactive_time = COALESCE(VALUES(inactive_time), inactive_time),
          background_time = COALESCE(VALUES(background_time), background_time),
          warnings = COALESCE(VALUES(warnings), warnings),
          tab_switches = COALESCE(VALUES(tab_switches), tab_switches),
          questions_asked = COALESCE(VALUES(questions_asked), questions_asked),
          question_text = COALESCE(VALUES(question_text), question_text),
          engagement_score = VALUES(engagement_score),
          attention_score = VALUES(attention_score),
          overall_score = VALUES(overall_score),
          source_class_report = 'Live Meeting',
          source_quiz_report = CASE WHEN VALUES(quiz_completed) = 1 THEN 'Live Quiz' ELSE source_quiz_report END,
          source_activity_report = 'Live Activity Monitor'
      `;

      await db.query(sql, [
        recordId,
        studentId,
        session.student_name,
        session.normalized_student_name,
        today,
        cleanTopic,
        cleanSubTopic,
        session.attendance_duration ?? null,
        session.join_count ?? 1,
        session.quiz_score ?? null,
        session.correct_answers ?? null,
        session.total_questions ?? null,
        session.quiz_completed ?? false,
        session.away_time ?? 0,
        session.inactive_time ?? 0,
        session.background_time ?? 0,
        session.warnings ?? 0,
        session.tab_switches ?? 0,
        0, // violations
        session.questions_asked ?? 0,
        session.question_text || null,
        session.engagement_score ?? null,
        session.attention_score ?? null,
        session.overall_score ?? null,
        'Live Meeting',
        session.quiz_completed ? 'Live Quiz' : null,
        'Live Activity Monitor'
      ]);
    }

    console.log(`✅ [LIVE ANALYTICS] Successfully recorded ${studentsToSave.length} student(s) for ${cleanTopic} (${cleanSubTopic}) on ${today}`);
    return { success: true, count: studentsToSave.length };
  } catch (err) {
    console.error('❌ [LIVE ANALYTICS ERROR] Failed to save live session analytics:', err);
    return { success: false, error: err.message };
  }
};
