const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

const initDB = async () => {
  try {
    const baseConnection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });
    
    await baseConnection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'skymeet'}\``);
    await baseConnection.end();

    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'skymeet',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const connection = await pool.getConnection();
    
    // We will NOT drop the table, to preserve existing data.
    // Instead we will just alter it if the columns don't exist, though CREATE TABLE IF NOT EXISTS will handle it if it doesn't exist at all.
    
    // Create table if not exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        id VARCHAR(255) PRIMARY KEY,
        student_id VARCHAR(255) NOT NULL,
        student_name VARCHAR(255) NOT NULL,
        normalized_student_name VARCHAR(255) NOT NULL,


        date DATE NOT NULL,
        topic VARCHAR(255) NOT NULL,
        sub_topic VARCHAR(255),
        
        attendance_duration INT DEFAULT NULL,
        join_count INT DEFAULT NULL,
        
        quiz_score FLOAT DEFAULT NULL,
        correct_answers INT DEFAULT NULL,
        total_questions INT DEFAULT NULL,
        quiz_completed BOOLEAN DEFAULT false,
        
        away_time INT DEFAULT NULL,
        inactive_time INT DEFAULT NULL,
        background_time INT DEFAULT NULL,
        
        warnings INT DEFAULT NULL,
        tab_switches INT DEFAULT NULL,
        violations INT DEFAULT NULL,
        
        questions_asked INT DEFAULT NULL,
        question_text TEXT,
        
        engagement_score FLOAT DEFAULT NULL,
        attention_score FLOAT DEFAULT NULL,
        overall_score FLOAT DEFAULT NULL,
        
        source_class_report VARCHAR(255),
        source_quiz_report VARCHAR(255),
        source_activity_report VARCHAR(255),
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        UNIQUE KEY unique_class_student (topic(100), sub_topic(100), date, normalized_student_name(100))
      )
    `);



    console.log('✅ Database schema initialized successfully');
    connection.release();
  } catch (error) {
    console.error('❌ Failed to initialize database schema:', error.message);
  }
};

initDB();

module.exports = {
  getConnection: async () => {
    if (!pool) throw new Error("Database pool is not initialized yet");
    return pool.getConnection();
  },
  query: async (sql, params) => {
    if (!pool) throw new Error("Database pool is not initialized yet");
    return pool.query(sql, params);
  }
};
