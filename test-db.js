import pool from "./db.js";

async function testDB() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("DB Connected:", result.rows[0]);
  } catch (err) {
    console.error("DB ERROR:", err);
  }
}

testDB();
