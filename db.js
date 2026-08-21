const mysql = require('mysql2/promise');
require('dotenv').config();

// Configures a connection pool for asynchronous query handling
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: 'cert_tracker',
  waitForConnections: true,
  connectionLimit: 10
});

module.exports = pool;
