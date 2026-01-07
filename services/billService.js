import pool from "../db.js";

export async function createEmptyBill(groupId) {
    const result = await pool.query(
        `INSERT INTO bills (group_id) VALUES ($1) RETURNING id`,
        [groupId]
    );


    return result.rows[0].id;
}
