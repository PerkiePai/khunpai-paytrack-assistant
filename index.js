import "dotenv/config";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";

import pool from "./db.js";
import { createEmptyBill } from "./services/billservice.js";
import { handleImage } from "./services/imageService.js";

const app = express();

const config = {
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
};

const client = new Client(config);

// State - TODO: Move to Redis in production
const creatingBill = new Map();

app.post("/webhook", middleware(config), (request, response) => {
    Promise
        .all(request.body.events.map(event => handleEvent(event)))
        .then(() => response.status(200).end())
        .catch(err => {
            console.error(err);
            response.status(500).end();
        });
});

app.use(express.json());

app.get("/api/group-members", async (request, response) => {
    try {
        const { groupId } = request.query;

        if (!groupId) {
            return response.status(400).json({ 
                success: false,
                error: "groupId is required" 
            });
        }

        const result = await pool.query(
            `SELECT gm.user_id, u.display_name
             FROM group_members gm
             JOIN users u ON u.user_id = gm.user_id
             WHERE gm.group_id = $1
             ORDER BY u.display_name`,
            [groupId]
        );

        response.json({
            success: true,
            members: result.rows
        });

    } catch (err) {
        console.error("Error fetching group members:", err);
        response.status(500).json({ 
            success: false,
            error: "Internal server error" 
        });
    }
});

app.post("/api/bill", async (request, response) => {
    const dbClient = await pool.connect();
    
    try {
        const { groupId, title, payType, amount, memberIds } = request.body;

        // Input validation
        if (!groupId || !title || !payType || !amount) {
            return response.status(400).json({ 
                success: false,
                error: "Missing required fields: groupId, title, payType, amount" 
            });
        }

        if (!Array.isArray(memberIds) || memberIds.length === 0) {
            return response.status(400).json({ 
                success: false,
                error: "At least one member must be selected" 
            });
        }

        // Validate amount
        const numAmount = Number(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return response.status(400).json({ 
                success: false,
                error: "Amount must be a positive number" 
            });
        }

        // Validate pay type
        if (!['equal', 'each'].includes(payType)) {
            return response.status(400).json({ 
                success: false,
                error: "Invalid pay type. Must be 'equal' or 'each'" 
            });
        }

        // Start transaction
        await dbClient.query('BEGIN');

        // Verify all memberIds (user_ids) exist in the group
        const memberCheckResult = await dbClient.query(
            `SELECT user_id FROM group_members
             WHERE group_id = $1 AND user_id = ANY($2::text[])`,
            [groupId, memberIds]
        );

        if (memberCheckResult.rowCount !== memberIds.length) {
            await dbClient.query('ROLLBACK');
            return response.status(400).json({ 
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

        // Insert all participants in transaction
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
                await client.pushMessage(groupId, {
                    type: "flex",
                    altText: "New Bill Created!",
                    contents: billStatusFlex(status)
                });
            }
        } catch (notifyError) {
            // Log but don't fail the request if notification fails
            console.error("Failed to send LINE notification:", notifyError);
        }

        response.json({
            success: true,
            billId,
            participants: memberIds.length,
            amountPerPerson: perPerson
        });

    } catch (err) {
        // Rollback on any error
        await dbClient.query('ROLLBACK');
        console.error("Error creating bill:", err);
        response.status(500).json({ 
            success: false,
            error: "Failed to create bill" 
        });
    } finally {
        dbClient.release();
    }
});

app.use("/liff", express.static("liff"));

async function handleEvent(event) {
    // Auto-register member first (now awaited)
    await autoRegisterMember(event);

    // Handle image messages BEFORE text-only check
    if (event.type === "message" && event.message.type === "image") {
        console.log("Received image message");
        return handleImage(event , client);
    }

    // Handle postback events
    if (event.type === "postback" && event.postback.data === "create_bill") {
        const groupId = event.source.groupId;
        const userId = event.source.userId;

        const billId = await createEmptyBill(groupId);
        creatingBill.set(userId, billId);

        return client.replyMessage(event.replyToken, {
            type: "flex",
            altText: "Choose split type",
            contents: splitTypeFlex(billId)
        });
    }

    // Handle text messages
    if (event.type !== "message" || event.message.type !== "text") {
        return Promise.resolve(null);
    }

    const text = event.message.text.trim();

    if (text === "test") {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "Server is working!"
        });
    }

    if (text === "/create-bill") {
        return handleOpenWeb(event);
    }

    if (text === "/member-list") {
        return handleMemberList(event);
    }

    if (text === "/status") {
        return handleStatus(event);
    }

    return Promise.resolve(null);
}

async function autoRegisterMember(event) {
    if (event.source.type !== "group") return;

    const { groupId, userId } = event.source;
    if (!groupId || !userId) return;

    try {
        const exists = await pool.query(
            `SELECT 1 FROM group_members
             WHERE group_id = $1 AND user_id = $2`,
            [groupId, userId]
        );

        if (exists.rowCount > 0) return;

        let displayName = null;
        let groupName = null;

        try {
            const profile = await client.getGroupMemberProfile(groupId, userId);
            displayName = profile.displayName;
        } catch (profileError) {
            console.warn("Could not fetch profile:", profileError.message);
        }

        try {
            const groupSummary = await client.getGroupSummary(groupId);
            groupName = groupSummary.groupName;
        } catch (groupError) {
            console.warn("Could not fetch group name:", groupError.message);
        }

        // Upsert group (insert or update group_name)
        await pool.query(
            `INSERT INTO groups (group_id, group_name) VALUES ($1, $2)
             ON CONFLICT (group_id) DO UPDATE SET group_name = EXCLUDED.group_name`,
            [groupId, groupName]
        );

        // Upsert user (insert or update display_name)
        await pool.query(
            `INSERT INTO users (user_id, display_name) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
            [userId, displayName]
        );

        // Link user to group
        await pool.query(
            `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
            [groupId, userId]
        );

        console.log(`Registered new member: ${displayName || userId}`);
    } catch (err) {
        console.error("Error auto-registering member:", err);
    }
}

async function handleStatus(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command only works in groups"
        });
    }

    try {
        const status = await getLatestBillStatus(groupId);

        if (!status) {
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: "❌ No bills found for this group"
            });
        }

        return client.replyMessage(event.replyToken, {
            type: "flex",
            altText: "Bill Status",
            contents: billStatusFlex(status)
        });
    } catch (err) {
        console.error("Error fetching status:", err);
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Failed to retrieve bill status"
        });
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
                    text: `Total: ฿${status.bill.total_pay_amount}`,
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
                            text: `฿${p.pay_amount}`,
                            align: "end",
                            flex: 1
                        }
                    ]
                }))
            ]
        }
    };
}

// Placeholder for splitTypeFlex - implement based on your needs
function splitTypeFlex(billId) {
    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: "Choose split type",
                    weight: "bold",
                    size: "lg"
                },
                {
                    type: "button",
                    action: {
                        type: "postback",
                        label: "Equal Split",
                        data: `split_equal_${billId}`
                    },
                    style: "primary"
                },
                {
                    type: "button",
                    action: {
                        type: "postback",
                        label: "Each Pays",
                        data: `split_each_${billId}`
                    },
                    style: "secondary",
                    margin: "md"
                }
            ]
        }
    };
}

async function handleMemberList(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command only works in groups"
        });
    }

    try {
        const result = await pool.query(
            `SELECT u.display_name
             FROM group_members gm
             JOIN users u ON u.user_id = gm.user_id
             WHERE gm.group_id = $1
             ORDER BY u.display_name`,
            [groupId]
        );

        if (result.rowCount === 0) {
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: "No members registered yet."
            });
        }

        const lines = result.rows.map((m, i) =>
            `${i + 1}. ${m.display_name || "(unknown)"}`
        );

        return client.replyMessage(event.replyToken, {
            type: "text",
            text:
                "👥 Members in this group\n\n" +
                lines.join("\n") +
                "\n\nℹ️ Only members who have sent at least one message are shown."
        });
    } catch (err) {
        console.error("Error fetching member list:", err);
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Failed to retrieve member list"
        });
    }
}

function handleOpenWeb(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command can only be used in a group"
        });
    }

    const liffUrl = `line://app/${process.env.LIFF_ID || "2008813600-fASkn3L4"}?groupId=${groupId}`;

    return client.replyMessage(event.replyToken, {
        type: "template",
        altText: "Open Create Bill",
        template: {
            type: "buttons",
            text: "🧾 Create a new bill",
            actions: [
                {
                    type: "uri",
                    label: "Open Create Bill",
                    uri: liffUrl
                }
            ]
        }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`LINE bot is running on port ${PORT}`);
});