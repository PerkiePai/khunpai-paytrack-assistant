import pool from "../lib/db.js";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { groupId } = req.query;

    if (!groupId) {
        return res.status(400).json({
            success: false,
            error: "groupId is required"
        });
    }

    try {
        const result = await pool.query(
            `SELECT gm.user_id, u.display_name
             FROM group_members gm
             JOIN users u ON u.user_id = gm.user_id
             WHERE gm.group_id = $1
             ORDER BY u.display_name`,
            [groupId]
        );

        res.status(200).json({
            success: true,
            members: result.rows
        });

    } catch (err) {
        console.error("Error fetching group members:", err);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
}
