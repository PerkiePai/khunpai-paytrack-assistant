import "dotenv/config";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import pool from "./db.js";
import { createEmptyBill } from "./services/billservice.js";


const app = express();

const config = {
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
};

const client = new Client(config);


//state
const creatingBill = new Map(); // key = userId, value = billId


app.use("/liff", express.static("liff"));

app.get("/api/group-members", async (request, response) => {
    try {
        const { groupId } = request.query;

        if (!groupId) {
            return response.status(400).json({ error: "groupIds required" });
        }

        const result = await pool.query(
            `SELECT id, name FROM group_members
            WHERE group_id = $1
            ORDER BY id`,
            [groupId]
        );

        response.json(result.rows);

    } catch (err) {
        console.error(err);
        response.status(500).json({ error: "server error!" });
    }

});

app.post("/api/bill", async (request, respond) => {
    try {
        const { title, payType, amount } = request.body;

        const result = await pool.query(
            `INSERT INTO bills (title, total, status)
            VALUES ($1, $2, 'OPEN')
            RETURNING *`,
            [title, amount]
        );

        console.log("Bill saved:", result.rows[0]);

        respond.json({
            ok: true,
            bill: result.rows[0]
        });

    } catch (err) {
        console.error("DB error: ", err);
        respond.status(500).json({ ok: false });
    }
});

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


async function handleEvent(event) {

    if (event.type === "message" && event.message.type === "text" && event.message.text.startsWith("/member-set")) {
        return handleMemberNameSet(event);
    }
    if (
        event.type === "message" &&
        event.message.type === "text" &&
        event.message.text.trim() === "/web"
    ) {
        return handleOpenWeb(event);
    }


    // 1. Handle postback FIRST
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

    // 2. Handle text messages
    if (event.type !== "message" || event.message.type !== "text") {
        return Promise.resolve(null);
    }

    const text = event.message.text;

    if (text === "test") {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "Server is working!!"
        });
    }

    return Promise.resolve(null);
}

//---------------------------------------------------------------------------//

async function getGroupMemberIds(groupId) {
    const ids = [];
    let start = null;

    do {
        const respond = await client.getGroupMemberIds(groupId, start);
        ids.push(...respond.membersIds);
        start = respond.next;

    } while (start);

    return ids;
}

async function getGroupMembers(groupId) {
    const memberIds = await getGroupMemberIds(groupId);

    const members = [];

    for (const userId of memberIds) {
        try {
            const profile = await client.getGroupMemberProfile(groupId, userId);
            members.push({
                userId,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl
            });

        } catch (err) {
            console.warn("cannot get profile for", userId);
        }
    }

    return members;
}

//chat gen
async function handleMemberNameSet(event) {
    const groupId = event.source.groupId;
    const text = event.message.text.trim();

    if (!groupId) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command can only be used in a group"
        });
    }

    const parts = text.split(" ").filter(Boolean);
    if (parts.length < 2) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Usage:\n/member-name-set A B C"
        });
    }

    const names = parts.slice(1);

    // 1️⃣ Remove all existing members for this group
    await pool.query(
        `DELETE FROM group_members WHERE group_id = $1`,
        [groupId]
    );

    // 2️⃣ Insert new members
    for (const name of names) {
        await pool.query(
            `INSERT INTO group_members (group_id, name)
       VALUES ($1, $2)`,
            [groupId, name]
        );
    }

    // 3️⃣ Confirm
    return client.replyMessage(event.replyToken, {
        type: "text",
        text:
            "✅ Group members set:\n" +
            names.map(n => `• ${n}`).join("\n")
    });
}

function handleOpenWeb(event) {
    const groupId = event.source.groupId;

    if (!groupId) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command can only be used in a group"
        });
    }

    const liffUrl = `line://app/2008813600-fASkn3L4?groupId=${groupId}`;

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


app.listen(3000, () => {
    console.log("LINE bot is running on port 3000");
});


