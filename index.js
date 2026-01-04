import "dotenv/config";
import express from "express";
import { middleware, Client } from "@line/bot-sdk";

import pool from "./db.js";
import { createEmptyBill } from "./services/billservice.js";
import { handleImage } from "./services/imageService.js"


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
            `SELECT user_id, display_name FROM group_members
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
            `INSERT INTO bills 
            (group_id, title, pay_type, total)
            VALUES ($1, $2, $3, $4)
            RETURNING id`,
            [groupId, title, payType, amount]
        );

        const billId = billResult.rows[0].id;

        const membersResult = await pool.query(
            `SELECT id 
            FROM group_members 
            WHERE group_id = $1 
            ORDER BY id`,
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

        const status = await getLastestBillStatus(groupId);

        await client.pushMessage( groupId , {
            type: "flex",
            altText: "New Bill Created!!",
            contents: billStatusFlex(status)
        });

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

    autoRegisterMember(event);

    //test
    if ( event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/web" ) {
        return handleOpenWeb(event);
    }

    //command
    if (event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/member-list" ) {
        return handleMemberList(event);
    }

    if (event.type === "message" && event.message.type === "text" && event.message.text.trim() === "/status" ) {
        return handleStatus(event);
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

    // 2. Handle image messages
    if (event.type === "message" && event.message.type === "image") {
        return handleImage(event);
    }

    return Promise.resolve(null);
}

async function autoRegisterMember(event) {

    if ( event.source.type !== "group" ) return;

    const { groupId , userId } = event.source;
    if ( !groupId || !userId ) return;

    const exists = await pool.query(
        `SELECT 1 FROM group_members
        WHERE group_id = $1 AND user_id = $2`,
        [groupId , userId]
    );

    if ( exists.rowCount > 0 ) return;

    let displayName = null;
    let pictureUrl = null;

    try {
        const profile = await client.getGroupMemberProfile(groupId , userId);
        displayName = profile.displayName;
        pictureUrl = profile.pictureUrl;
    } catch (_) {}

    await pool.query(
        `INSERT INTO group_members 
        (group_id, user_id, display_name, picture_url)
        VALUES ($1, $2, $3, $4)`,
        [groupId, userId, displayName, pictureUrl]
    );

}

async function handleStatus(event) {

    const groupId = event.source.groupId;

    if ( !groupId ) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ This command works only in groups"
        });
    }

    const status = await getLastestBillStatus(groupId);

    if ( !status ) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ No bill found"
        });
    }

    return client.replyMessage(event.replyToken, {
        type: "flex",
        altText: "Bill status",
        contents: billStatusFlex(status)
    })

}

async function getLastestBillStatus( groupId ) {

    const billResult = await pool.query(
        `SELECT id , title , total 
        FROM bills 
        WHERE group_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
        [groupId]
    );

    if ( billResult.rowCount === 0 ) return null;

    const bill = billResult.rows[0];

    const participantsResult = await pool.query(
        `SELECT gm.display_name , bp.amount_due , bp.paid
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
          text: `Total: ${status.bill.total}`,
          color: "#666666",
          size: "sm"
        },
        {
          type: "separator"
        },
        ...status.participants.map(p => ({
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
              text: p.display_name,
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
async function handleMemberList(event) {
  const groupId = event.source.groupId;

  if (!groupId) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ This command works only in groups"
    });
  }

  const result = await pool.query(
    `SELECT display_name
     FROM group_members
     WHERE group_id = $1
     ORDER BY joined_at`,
    [groupId]
  );

  if (result.rowCount === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "No members registered yet."
    });
  }

  const lines = result.rows.map((m, i) =>
    `${i + 1}. ${m.display_name ?? "(unknown)"}`
  );

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "👥 Members in this group\n\n" +
      lines.join("\n") +
      "\n\nℹ️ Only members who have sent at least one message are shown."
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


