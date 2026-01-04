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

        console.log("REQ BODY:", request.body);

        const { groupId, title, payType, amount , memberIds } = request.body;

        if ( !groupId || !title || !payType || !amount ) {
            return respond.status(400).json({ error: "missing fields" });
        }

        if ( !Array.isArray(memberIds) || memberIds.length === 0 ) {
            return respond.status(400).json({ error: "no members selected" });
        }

        const billResult = await pool.query(
            `INSERT INTO bills (group_id, title, pay_type, total)
            VALUES ($1, $2, $3, $4)
            RETURNING id`,
            [groupId, title, payType, amount]
        );

        const billId = billResult.rows[0].id;

        const membersResult = await pool.query(
            `SELECT id FROM group_members WHERE group_id = $1 ORDER BY id`,
            [groupId]
        );

        if ( membersResult.rowCount === 0 ) {
            return respond.status(400).json({ error: "no group members" });
        }

        if ( payType === "equal" ) {

            const perPerson = Number(amount) / memberIds.length;

            for ( const memberId of memberIds ) {
                await pool.query(
                    `INSERT INTO bill_participants
                    (bill_id , member_id , amount_due)
                    VALUES ($1 , $2 , $3)`,
                    [billId , memberId  , perPerson]
                );
            }
        }

        if ( payType === "each" ) {

            const perPerson = Number(amount);

            for ( const memberId of memberIds ) {
                await pool.query(
                    `INSERT INTO bill_participants
                    (bill_id , member_id , amount_due)
                    VALUES ($1 , $2 , $3)`,
                    [billId , memberId , perPerson]
                );
            }
        }

        respond.json({
            ok: true,
            billId,
            participants: memberIds.length
        });

    } catch (err) {
        console.error("DB error: ", err);
        respond.status(500).json({ ok: false });
    }
});

app.use("/liff", express.static("liff"));

async function handleEvent(event) {

    //test
    if ( event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/web" ) {
        return handleOpenWeb(event);
    }

    //command
    if (event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/member-set" ) {
        return handleMemberNameSet(event);
    }

    if (event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/summary" ) {
        return handleSummary(event);
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

async function handleSummary(event) {

    const groupId = event.source.groupId;

    if ( !groupId ) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command works only in groups"
        });
    }

    const summary = await getLastestBillSummary(groupId);

    if ( !summary ) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ No bill found"
        });
    }

    return client.replyMessage(event.replyToken, {
        type: "flex",
        altText: "Bill summary",
        contents: billSummaryFlex(summary)
    })

}

async function getLastestBillSummary( groupId ) {

    const billResult = await pool.query(
        `SELECT id , title , total 
        FROM bills 
        WHERE group_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
        [groupId]
    );

    if ( billResult.count === 0 ) return null;

    const bill = billResult.rows[0];

    const participantsResult = await pool.query(
        `SELECT gm.name , bp.amount_due , bp.paid
        FROM bill_participants bp
        JOIN group_members gm ON gm.id = bp.member_id
        WHERE bp.bill_id = $1
        ORDER BY gm.id`,
        [bill.id]
    );

    return {
        bill,
        participants: participantsResult.rows
    };

} 

function billSummaryFlex(summary) {

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "text",
          text: summary.bill.title,
          weight: "bold",
          size: "lg",
          wrap: true
        },
        {
          type: "text",
          text: `Total: ${summary.bill.total}`,
          color: "#666666",
          size: "sm"
        },
        {
          type: "separator"
        },
        ...summary.participants.map(p => ({
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: p.paid ? "✅" : "❌",
              size: "sm",
              flex: 0
            },
            {
              type: "text",
              text: p.name,
              flex: 2
            },
            {
              type: "text",
              text: `${p.amount_due}`,
              align: "end",
              flex: 1
            }
          ]
        }))
      ]
    }
  };

}


//---------------------------------------------------------------------------//

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


