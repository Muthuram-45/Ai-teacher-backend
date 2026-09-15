const db = require('../utils/db');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenAI } = require("@google/genai");

const client = new GoogleGenAI({
  vertexai: process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true',
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
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

const extractMetadataFromFilename = (filename) => {
  let type = 'unknown';
  const lowerName = filename.toLowerCase();
  if (lowerName.includes('class_report')) type = 'class';
  else if (lowerName.includes('quiz_report')) type = 'quiz';
  else if (lowerName.includes('activity_report')) type = 'activity';
  return type;
};

const extractMetadataFromContent = (data, type) => {
  let date = null;
  let topic = null;
  let subTopic = null;
  
  for (let i = 0; i < Math.min(15, data.length); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;
    
    const cell0 = row[0] ? String(row[0]).trim().toLowerCase() : '';
    const cell1 = row[1] ? String(row[1]).trim() : '';
    
    if (cell0.includes('date')) {
      if (cell1) {
        date = normalizeDate(cell1);
      } else {
        const match = cell0.match(/date[\s:]*([\d-]+)/);
        if (match) date = normalizeDate(match[1]);
      }
    }

    if (cell0 === 'topic:' || cell0 === 'topic') {
      if (cell1) topic = normalizeTopic(cell1);
    }
    
    if (cell0 === 'sub topic:' || cell0 === 'sub topic' || cell0 === 'subtopic:') {
      if (cell1) subTopic = normalizeTopic(cell1);
    }
  }

  if (!topic) topic = 'General';
  if (!subTopic) subTopic = 'General';

  return { date, topic, subTopic };
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

exports.uploadReports = async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const sessions = {};
    const validationSummary = {
      detectedReports: [],
      matchedStudents: 0
    };

    let commonDate = null;
    let commonTopic = null;
    let commonSubTopic = null;
    const parsedFiles = [];

    for (const file of files) {
      const type = extractMetadataFromFilename(file.originalname);
      const workbook = xlsx.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      
      const { date, topic, subTopic } = extractMetadataFromContent(data, type);
      if (date && !commonDate) commonDate = date;
      if (topic && topic !== 'General' && !commonTopic) commonTopic = topic;
      if (subTopic && subTopic !== 'General' && !commonSubTopic) commonSubTopic = subTopic;
      
      parsedFiles.push({ file, type, data });
    }

    const sessionDate = commonDate || normalizeDate(new Date().toISOString());
    const sessionTopic = commonTopic || 'Unknown Topic';
    const sessionSubTopic = commonSubTopic || 'General';

    validationSummary.newSessionCreated = {
      date: sessionDate,
      topic: sessionTopic,
      subTopic: sessionSubTopic
    };

    console.log(`\n[ANALYTICS] Class identified: Topic = ${sessionTopic}, SubTopic = ${sessionSubTopic}, Date = ${sessionDate}`);

    for (const { file, type, data } of parsedFiles) {
      let studentsFound = 0;
      console.log(`[ANALYTICS] File: ${file.originalname} | Type: ${type}`);

      if (type === 'class') {
        let inStudentSection = false;
        let colMap = {};
        for (const row of data) {
          if (!row || row.length === 0) continue;
          
          if (row[0] && row[0].toString().toUpperCase().includes('STUDENT DETAILS')) {
            inStudentSection = true;
            continue;
          }
          
          if (inStudentSection) {
            // Find headers
            if (row.includes('Name') || row.includes('First Join')) {
              row.forEach((col, idx) => { if (col) colMap[col.toString().trim()] = idx; });
              continue;
            }
            // Data row
            if (colMap['Name'] !== undefined && row[colMap['Name']]) {
              const sName = row[colMap['Name']].toString().trim();
              if (!sName || sName.toLowerCase() === 'unknown' || sName.includes('Question')) continue; // skip bad rows
              
              const norm = normalizeName(sName);
              const studentId = norm.replace(/\s/g, ''); // Simple student_id based on name
              const key = norm; // Uniqueness is purely student inside this batch
              if (!sessions[key]) sessions[key] = { id: uuidv4(), student_id: studentId, student_name: sName, normalized_student_name: norm, date: sessionDate, topic: sessionTopic, sub_topic: sessionSubTopic };
              
              // Convert "25m 32s" to seconds
              const stayStr = (row[colMap['Total Stay']] || '').toString();
              let durationSecs = 0;
              const minMatch = stayStr.match(/(\d+)m/);
              const secMatch = stayStr.match(/(\d+)s/);
              if (minMatch) durationSecs += parseInt(minMatch[1]) * 60;
              if (secMatch) durationSecs += parseInt(secMatch[1]);
              if (!minMatch && !secMatch && !isNaN(parseInt(stayStr))) durationSecs = parseInt(stayStr) * 60; // fallback

              sessions[key].attendance_duration = (sessions[key].attendance_duration || 0) + durationSecs;
              sessions[key].join_count = parseInt(row[colMap['Join Count']] || 1);
              
              // Extract Questions properly (count by common delimiters like ? or | or newline)
              const rawQuestions = row[colMap['Question']] ? row[colMap['Question']].toString().trim() : '';
              let qCount = 0;
              let qText = '';
              if (rawQuestions && rawQuestions.toLowerCase() !== 'no') {
                 // Try to split by common dividers
                 const splits = rawQuestions.split(/[?|;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
                 qCount = splits.length || (rawQuestions.length > 5 ? 1 : 0);
                 qText = rawQuestions;
              }
              
              sessions[key].questions_asked = qCount;
              sessions[key].question_text = qText;
              sessions[key].source_class_report = file.originalname;
              studentsFound++;
            }
          }
        }
        console.log(`[ANALYTICS] Extracted ${studentsFound} students from Class Report`);
        validationSummary.detectedReports.push({ type: 'Class Report', file: file.originalname, date: sessionDate, topic: sessionTopic, students: studentsFound });
      } 
      else if (type === 'quiz') {
        let inStudentSection = false;
        let colMap = {};
        for (const row of data) {
          if (!row || row.length === 0) continue;
          
          if (row[0] && row[0].toString().toUpperCase().includes('STUDENT RESULTS')) {
            inStudentSection = true;
            continue;
          }
          if (row[0] && row[0].toString().toUpperCase().includes('QUIZ QUESTIONS')) {
            inStudentSection = false; // end of students
          }
          
          if (inStudentSection) {
            if (row.includes('Student Name') || row.includes('Score (%)')) {
              row.forEach((col, idx) => { if (col) colMap[col.toString().trim()] = idx; });
              continue;
            }
            if (colMap['Student Name'] !== undefined && row[colMap['Student Name']]) {
              const sName = row[colMap['Student Name']].toString().trim();
              if (!sName || sName.toLowerCase() === 'unknown') continue;
              
              const norm = normalizeName(sName);
              const studentId = norm.replace(/\s/g, '');
              const key = norm;
              if (!sessions[key]) sessions[key] = { id: uuidv4(), student_id: studentId, student_name: sName, normalized_student_name: norm, date: sessionDate, topic: sessionTopic, sub_topic: sessionSubTopic };
              
              const scoreRaw = row[colMap['Score (%)']];
              sessions[key].quiz_score = scoreRaw ? parseFloat(scoreRaw.toString().replace('%','')) : null;
              sessions[key].quiz_completed = true;
              
              const correctStr = row[colMap['Correct Answers']];
              if (correctStr && correctStr.includes('/')) {
                 sessions[key].correct_answers = parseInt(correctStr.split('/')[0]);
                 sessions[key].total_questions = parseInt(correctStr.split('/')[1]);
              }
              sessions[key].tab_switches = parseInt(row[colMap['Tab Switches']] || 0);
              sessions[key].violations = parseInt(row[colMap['Video Violations']] || 0);
              sessions[key].source_quiz_report = file.originalname;
              studentsFound++;
            }
          }
        }
        console.log(`[ANALYTICS] Extracted ${studentsFound} submissions from Quiz Report`);
        validationSummary.detectedReports.push({ type: 'Quiz Report', file: file.originalname, date: sessionDate, topic: sessionTopic, students: studentsFound });
      }
      else if (type === 'activity') {
        let inStudentSection = false;
        let colMap = {};
        for (const row of data) {
          if (!row || row.length === 0) continue;
          
          if (row[0] && row[0].toString().toUpperCase().includes('ACTIVITY DETAILS')) {
            inStudentSection = true;
            continue;
          }
          
          if (inStudentSection) {
            if (row.includes('Student Name') || row.includes('Total Away Time (s)')) {
              row.forEach((col, idx) => { if (col) colMap[col.toString().trim()] = idx; });
              continue;
            }
            if (colMap['Student Name'] !== undefined && row[colMap['Student Name']]) {
              const sName = row[colMap['Student Name']].toString().trim();
              if (!sName || sName.toLowerCase() === 'unknown') continue;
              
              const norm = normalizeName(sName);
              const studentId = norm.replace(/\s/g, '');
              const key = norm;
              if (!sessions[key]) sessions[key] = { id: uuidv4(), student_id: studentId, student_name: sName, normalized_student_name: norm, date: sessionDate, topic: sessionTopic, sub_topic: sessionSubTopic };
              
              sessions[key].away_time = parseInt(row[colMap['Total Away Time (s)']] || 0);
              sessions[key].inactive_time = parseInt(row[colMap['Total Inactive Time (s)']] || 0);
              sessions[key].background_time = parseInt(row[colMap['Total Background Time (s)']] || 0);
              sessions[key].warnings = parseInt(row[colMap['Total Warnings']] || 0);
              sessions[key].source_activity_report = file.originalname;
              studentsFound++;
            }
          }
        }
        console.log(`[ANALYTICS] Extracted ${studentsFound} students from Activity Report`);
        validationSummary.detectedReports.push({ type: 'Activity Report', file: file.originalname, date: sessionDate, topic: sessionTopic, students: studentsFound });
      }
    }

    const sessionValues = Object.values(sessions);
    validationSummary.matchedStudents = sessionValues.length;

    // Save to DB
    const connection = await db.getConnection();
    let processedRecords = 0;
    
    for (const session of sessionValues) {
      session.engagement_score = calculateEngagement(session);
      session.attention_score = calculateAttention(session);
      session.overall_score = session.quiz_score !== null ? session.quiz_score : null; // base MVP
      
      const sql = `
        INSERT INTO analytics_sessions (
          id, student_id, student_name, normalized_student_name, date, topic, sub_topic,
          attendance_duration, join_count, quiz_score, correct_answers, total_questions, quiz_completed,
          away_time, inactive_time, background_time, warnings, tab_switches, violations, questions_asked, question_text,
          engagement_score, attention_score, overall_score, source_class_report, source_quiz_report, source_activity_report
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          attendance_duration = COALESCE(VALUES(attendance_duration), attendance_duration),
          quiz_score = COALESCE(VALUES(quiz_score), quiz_score),
          quiz_completed = COALESCE(VALUES(quiz_completed), quiz_completed),
          correct_answers = COALESCE(VALUES(correct_answers), correct_answers),
          questions_asked = COALESCE(VALUES(questions_asked), questions_asked),
          question_text = COALESCE(VALUES(question_text), question_text),
          away_time = COALESCE(VALUES(away_time), away_time),
          inactive_time = COALESCE(VALUES(inactive_time), inactive_time),
          engagement_score = VALUES(engagement_score),
          attention_score = VALUES(attention_score),
          overall_score = VALUES(overall_score),
          source_class_report = COALESCE(VALUES(source_class_report), source_class_report),
          source_quiz_report = COALESCE(VALUES(source_quiz_report), source_quiz_report),
          source_activity_report = COALESCE(VALUES(source_activity_report), source_activity_report)
      `;
      
      await connection.query(sql, [
        session.id, session.student_id, session.student_name, session.normalized_student_name, session.date, session.topic, session.sub_topic,
        session.attendance_duration ?? null, session.join_count ?? null, session.quiz_score ?? null, session.correct_answers ?? null, session.total_questions ?? null, session.quiz_completed ?? false,
        session.away_time ?? null, session.inactive_time ?? null, session.background_time ?? null, session.warnings ?? null, session.tab_switches ?? null, session.violations ?? null, session.questions_asked ?? null, session.question_text || null,
        session.engagement_score ?? null, session.attention_score ?? null, session.overall_score ?? null,
        session.source_class_report || null, session.source_quiz_report || null, session.source_activity_report || null
      ]);
      processedRecords++;
    }
    connection.release();

    res.status(200).json({ success: true, processedRecords, validationSummary });
  } catch (error) {
    console.error('Excel processing error:', error);
    res.status(500).json({ error: error.message || 'Failed to process files' });
  }
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
