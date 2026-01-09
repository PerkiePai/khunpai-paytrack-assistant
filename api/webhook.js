import { client, blobClient, config, validateSignature } from "../lib/line.js";
import pool from "../lib/db.js";
import { handleImage } from "../lib/imageService.js";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // Verify LINE signature
    const signature = req.headers["x-line-signature"];
    const body = JSON.stringify(req.body);

    if (!validateSignature(body, config.channelSecret, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
    }

    const events = req.body.events;

    try {
        await Promise.all(events.map(event => handleEvent(event)));
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

async function handleEvent(event) {
    // Auto-register member first
    await autoRegisterMember(event);

    // Handle image messages
    if (event.type === "message" && event.message.type === "image") {
        console.log("Received image message");
        return handleImage(event, client, blobClient);
    }

    // Handle text messages
    if (event.type !== "message" || event.message.type !== "text") {
        return Promise.resolve(null);
    }

    const text = event.message.text.trim();

    if (text === "test") {
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "Server is working!"
            }]
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

        // Upsert group
        await pool.query(
            `INSERT INTO groups (group_id, group_name) VALUES ($1, $2)
             ON CONFLICT (group_id) DO UPDATE SET group_name = EXCLUDED.group_name`,
            [groupId, groupName]
        );

        // Upsert user
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
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "This command only works in groups"
            }]
        });
    }

    try {
        const status = await getLatestBillStatus(groupId);

        if (!status) {
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{
                    type: "text",
                    text: "No bills found for this group"
                }]
            });
        }

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "flex",
                altText: "Bill Status",
                contents: billStatusFlex(status)
            }]
        });
    } catch (err) {
        console.error("Error fetching status:", err);
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "Failed to retrieve bill status"
            }]
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

async function handleMemberList(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "This command only works in groups"
            }]
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
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{
                    type: "text",
                    text: "No members registered yet."
                }]
            });
        }

        const lines = result.rows.map((m, i) =>
            `${i + 1}. ${m.display_name || "(unknown)"}`
        );

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text:
                    "Members in this group\n\n" +
                    lines.join("\n") +
                    "\n\nOnly members who have sent at least one message are shown."
            }]
        });
    } catch (err) {
        console.error("Error fetching member list:", err);
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "Failed to retrieve member list"
            }]
        });
    }
}

function handleOpenWeb(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: "text",
                text: "This command can only be used in a group"
            }]
        });
    }

    const liffUrl = `line://app/${process.env.LIFF_ID}?groupId=${groupId}`;

    return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
            type: "template",
            altText: "Open Create Bill",
            template: {
                type: "buttons",
                text: "Create a new bill",
                actions: [
                    {
                        type: "uri",
                        label: "Open Create Bill",
                        uri: liffUrl
                    }
                ]
            }
        }]
    });
}

// Export for Vercel to send notifications from bill.js
export { client, getLatestBillStatus, billStatusFlex };
