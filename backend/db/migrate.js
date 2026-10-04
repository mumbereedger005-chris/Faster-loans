'use strict';
// db/migrate.js — Run schema.sql against the MySQL database
// Usage: node db/migrate.js
process.env.TZ = 'Africa/Kampala';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

async function migrate() {
  let conn;
  try {
    // Connect WITHOUT database selected first (to allow CREATE DATABASE)
    conn = await mysql.createConnection({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306'),
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true,
      timezone: '+03:00',
    });

    console.log('✅  Connected to MySQL');

    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    // Split on semicolons, filter blanks/comments
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let ok = 0, skip = 0;
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
        ok++;
      } catch (err) {
        // Ignore duplicate/already-exists errors gracefully
        if ([1050, 1060, 1061, 1062, 1068].includes(err.errno)) {
          skip++;
        } else {
          console.error(`❌  Statement failed:\n${stmt.substring(0, 120)}\n   → ${err.message}`);
        }
      }
    }

    console.log(`✅  Migration complete — ${ok} statements executed, ${skip} skipped (already exist)`);

    // Confirm timezone in DB
    const [tz] = await conn.query("SELECT CONVERT_TZ(NOW(), '+00:00', '+03:00') AS eat_now");
    console.log(`🕐  Uganda time in DB: ${tz[0].eat_now}`);

  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

migrate();
