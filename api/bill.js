import pool from "../lib/db.js";
import { client } from "../lib/line.js";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const dbClient = await pool.connect();

    try {
        const { groupId, title, payType, amount, memberIds } = req.body;

        // Input validation
        if (!groupId || !title || !payType || !amount) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: groupId, title, payType, amount"
            });
        }

        if (!Array.isArray(memberIds) || memberIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: "At least one member must be selected"
            });
        }

        // Validate amount
        const numAmount = Number(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: "Amount must be a positive number"
            });
        }

        // Validate pay type
        if (!['equal', 'each'].includes(payType)) {
            return res.status(400).json({
                success: false,
                error: "Invalid pay type. Must be 'equal' or 'each'"
            });
        }

        // Start transaction
        await dbClient.query('BEGIN');

        // Verify all memberIds exist in the group
        const memberCheckResult = await dbClient.query(
            `SELECT user_id FROM group_members
             WHERE group_id = $1 AND user_id = ANY($2::text[])`,
            [groupId, memberIds]
        );

        if (memberCheckResult.rowCount !== memberIds.length) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                error: "One or more selected members do not exist in this group"
            });
        }

        // Create bill
        const billResult = await dbClient.query(
            `INSERT INTO bills (group_id, title, pay_type, total_pay_amount)
             VALUES ($1, $2, $3, $4)
             RETURNING bill_id`,
            [groupId, title, payType, numAmount]
        );

        const billId = billResult.rows[0].bill_id;

        // Calculate per-person amount
        const perPerson = payType === "equal"
            ? numAmount / memberIds.length
            : numAmount;

        // Insert all participants
        for (const userId of memberIds) {
            await dbClient.query(
                `INSERT INTO bill_participants (bill_id, user_id, pay_amount)
                 VALUES ($1, $2, $3)`,
                [billId, userId, perPerson]
            );
        }

        // Commit transaction
        await dbClient.query('COMMIT');

        // Send LINE notification
        try {
            const status = await getLatestBillStatus(groupId);
            if (status) {
                await client.pushMessage({
                    to: groupId,
                    messages: [{
                        type: "flex",
                        altText: "New Bill Created!",
                        contents: billStatusFlex(status)
                    }]
                });
            }
        } catch (notifyError) {
            console.error("Failed to send LINE notification:", notifyError);
        }

        res.status(200).json({
            success: true,
            billId,
            participants: memberIds.length,
            amountPerPerson: perPerson
        });

    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error("Error creating bill:", err);
        res.status(500).json({
            success: false,
            error: "Failed to create bill"
        });
    } finally {
        dbClient.release();
    }
}

async function getLatestBillStatus(groupId) {
    try {
        const billResult = await pool.query(
            `SELECT bill_id, title, total_pay_amount
             FROM bills
             WHERE group_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [groupId]
        );

        if (billResult.rowCount === 0) return null;

        const bill = billResult.rows[0];

        const participantsResult = await pool.query(
            `SELECT u.display_name, bp.pay_amount, bp.pay_at
             FROM bill_participants bp
             JOIN users u ON u.user_id = bp.user_id
             WHERE bp.bill_id = $1
             ORDER BY u.display_name`,
            [bill.bill_id]
        );

        return {
            bill,
            participants: participantsResult.rows
        };
    } catch (err) {
        console.error("Error getting latest bill status:", err);
        return null;
    }
}

function billStatusFlex(status) {
    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
                {
                    type: "text",
                    text: status.bill.title,
                    weight: "bold",
                    size: "lg",
                    wrap: true
                },
                {
                    type: "text",
                    text: `Total: ${status.bill.total_pay_amount}`,
                    color: "#666666",
                    size: "sm"
                },
                {
                    type: "separator",
                    margin: "md"
                },
                ...status.participants.map(p => ({
                    type: "box",
                    layout: "horizontal",
                    margin: "md",
                    contents: [
                        {
                            type: "text",
                            text: p.pay_at ? "✅" : "❌",
                            size: "sm",
                            flex: 0
                        },
                        {
                            type: "text",
                            text: p.display_name || "(unknown)",
                            flex: 2,
                            margin: "md"
                        },
                        {
                            type: "text",
                            text: `${p.pay_amount}`,
                            align: "end",
                            flex: 1
                        }
                    ]
                }))
            ]
        }
    };
}
