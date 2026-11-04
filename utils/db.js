require('dotenv').config();

const isPostgres = Boolean(
  process.env.DB_TYPE === 'postgres' ||
  process.env.DB_PORT === '5432' ||
  process.env.DB_PORT === '6543' ||
  (process.env.DB_HOST && (process.env.DB_HOST.includes('supabase') || process.env.DB_HOST.includes('neon') || process.env.DB_HOST.includes('postgres'))) ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres'))
);

let pool;

function adaptSqlForPostgres(sql) {
  let s = sql;

  // 1. Convert DATE_FORMAT(col, '%Y-%m-%d') to to_char(col, 'YYYY-MM-DD')
  s = s.replace(/DATE_FORMAT\(\s*([^,]+?)\s*,\s*['"]%Y-%m-%d['"]\s*\)/gi, "to_char($1, 'YYYY-MM-DD')");

  // 2. Convert IFNULL to COALESCE
  s = s.replace(/IFNULL\(/gi, 'COALESCE(');

  // 3. PostgreSQL ROUND(double precision, n) needs cast to numeric: ROUND((expr)::numeric, n)
  s = s.replace(/ROUND\(\s*([^,]+?)\s*,\s*(\d+)\s*\)/gi, "ROUND(($1)::numeric, $2)");

  // 4. Convert ON DUPLICATE KEY UPDATE to ON CONFLICT ... DO UPDATE SET
  if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(s)) {
    s = s.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i, 'ON CONFLICT (topic, sub_topic, date, normalized_student_name) DO UPDATE SET');
    // Replace VALUES(col) with EXCLUDED.col
    s = s.replace(/VALUES\(\s*([a-zA-Z0-9_]+)\s*\)/gi, 'EXCLUDED.$1');
  }

  // 5. Convert ? placeholders to $1, $2, $3...
  let paramIndex = 1;
  s = s.replace(/\?/g, () => `$${paramIndex++}`);

  return s;
}

const initDB = async () => {
  try {
    if (isPostgres) {
      const { Pool } = require('pg');
      console.log('📡 Connecting to PostgreSQL / Supabase database...');

      let poolConfig;
      if (process.env.DATABASE_URL) {
        poolConfig = {
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
        };
      } else {
        poolConfig = {
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT, 10) || 5432,
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || '',
          database: process.env.DB_NAME || 'postgres',
          ssl: { rejectUnauthorized: false },
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000
        };
      }

      pool = new Pool(poolConfig);

      // Verify connection and create schema
      const client = await pool.connect();
      try {
        await client.query(`
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
            quiz_score REAL DEFAULT NULL,
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
            engagement_score REAL DEFAULT NULL,
            attention_score REAL DEFAULT NULL,
            overall_score REAL DEFAULT NULL,
            source_class_report VARCHAR(255),
            source_quiz_report VARCHAR(255),
            source_activity_report VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_class_student UNIQUE (topic, sub_topic, date, normalized_student_name)
          )
        `);
        console.log('✅ PostgreSQL / Supabase schema initialized successfully');
      } finally {
        client.release();
      }
    } else {
      const mysql = require('mysql2/promise');
      console.log('📡 Connecting to MySQL database...');

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
      try {
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
        console.log('✅ MySQL database schema initialized successfully');
      } finally {
        connection.release();
      }
    }
  } catch (error) {
    console.error('❌ Failed to initialize database schema:', error.message);
  }
};

initDB();

module.exports = {
  getConnection: async () => {
    if (!pool) throw new Error("Database pool is not initialized yet");
    return pool.getConnection ? pool.getConnection() : pool.connect();
  },
  query: async (sql, params = []) => {
    if (!pool) throw new Error("Database pool is not initialized yet");
    if (isPostgres) {
      const adaptedSql = adaptSqlForPostgres(sql);
      const res = await pool.query(adaptedSql, params);
      return [res.rows, res.fields];
    } else {
      return pool.query(sql, params);
    }
  }
};
