export async function createEmptyBill(groupId) {
    const result = await pool.query(
        `INERT INTO bils (group_id) VALUES (1$) RETURNING id`,
        [groupId]
    );

    return result.rows[0].id;
}
