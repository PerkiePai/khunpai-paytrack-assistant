import jsQR from "jsqr";
import { createCanvas, loadImage } from "canvas";
import { parseSlipImage } from "./slipParser.js";
import pool from "../db.js";

/**
 * Handle image messages and extract QR code data
 * @param {Object} event - LINE webhook event
 * @param {Object} client - LINE bot client instance
 */
export async function handleImage(event, client) {
    const groupId = event.source.groupId;
    const userId = event.source.userId;
    const messageId = event.message.id;

    if (!groupId) {
        console.log("Image received outside of group context");
        return;
    }

    try {
        // Get image content from LINE
        const stream = await client.getMessageContent(messageId);
        const chunks = [];
        
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        
        const buffer = Buffer.concat(chunks);

        // Load image and create canvas
        const img = await loadImage(buffer);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        // Extract image data for QR scanning
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const qr = jsQR(imageData.data, img.width, img.height);

        if (!qr) {
            console.log("No QR code found in image");
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: "❌ No QR code detected in this image. Please send a payment slip with a QR code."
            });
        }

        console.log("QR code detected:", qr.data);

        // Process the slip image with QR data
        return handleSlipImage({
            event,
            client,
            buffer,
            qrPayload: qr.data
        });

    } catch (error) {
        console.error("Error processing image:", error);
        
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Failed to process image. Please try again."
        });
    }
}

// Process slip image using Gemini Vision
async function handleSlipImage({ event, client, buffer }) {
    const groupId = event.source.groupId;
    const userId = event.source.userId;

    console.log("Processing payment slip with Gemini...");

    // Parse slip using Gemini
    const slipInfo = await parseSlipImage(buffer);

    if (slipInfo.error) {
        console.error("Gemini parsing error:", slipInfo.error);
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Failed to read payment slip. Please try again."
        });
    }

    if (!slipInfo.amount) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ Could not detect payment amount from the slip."
        });
    }

    console.log("Slip parsed:", slipInfo);

    // Find pending bill for this user
    const pendingBill = await findPendingBillForUser(groupId, userId);

    if (!pendingBill) {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ No pending bill found for you in this group."
        });
    }

    // Check amount match (5% tolerance)
    const tolerance = pendingBill.amount_due * 0.05;
    const diff = Math.abs(slipInfo.amount - pendingBill.amount_due);

    if (diff > tolerance) {
        return client.replyMessage(event.replyToken, {
            type: "flex",
            altText: "Payment Amount Mismatch",
            contents: mismatchFlex(slipInfo.amount, pendingBill.amount_due, pendingBill.bill_title)
        });
    }

    // Mark as paid
    await markAsPaid(pendingBill.participant_id);

    return client.replyMessage(event.replyToken, {
        type: "flex",
        altText: "Payment Confirmed!",
        contents: successFlex(slipInfo, pendingBill)
    });
}

// Find user's pending bill in latest bill for this group
async function findPendingBillForUser(groupId, userId) {
    const result = await pool.query(
        `SELECT bp.id as participant_id, bp.amount_due, b.title as bill_title, b.id as bill_id
         FROM bill_participants bp
         JOIN bills b ON b.id = bp.bill_id
         JOIN group_members gm ON gm.id = bp.member_id
         WHERE b.group_id = $1 AND gm.user_id = $2 AND bp.paid = false
         ORDER BY b.created_at DESC
         LIMIT 1`,
        [groupId, userId]
    );
    return result.rows[0] || null;
}

// Mark participant as paid
async function markAsPaid(participantId) {
    await pool.query(
        `UPDATE bill_participants SET paid = true WHERE id = $1`,
        [participantId]
    );
}

// Success flex message
function successFlex(slipInfo, pendingBill) {
    const contents = [
        { type: "text", text: "✅ Payment Confirmed!", weight: "bold", size: "lg", color: "#1DB446" },
        { type: "separator", margin: "md" },
        { type: "box", layout: "horizontal", margin: "md", contents: [
            { type: "text", text: "Bill:", color: "#666666", flex: 1 },
            { type: "text", text: pendingBill.bill_title, flex: 2, align: "end" }
        ]},
        { type: "box", layout: "horizontal", contents: [
            { type: "text", text: "Amount:", color: "#666666", flex: 1 },
            { type: "text", text: `฿${slipInfo.amount}`, flex: 2, align: "end", weight: "bold" }
        ]}
    ];

    if (slipInfo.bank_name) {
        contents.push({ type: "box", layout: "horizontal", contents: [
            { type: "text", text: "Bank:", color: "#666666", flex: 1 },
            { type: "text", text: slipInfo.bank_name, flex: 2, align: "end" }
        ]});
    }

    return { type: "bubble", body: { type: "box", layout: "vertical", spacing: "sm", contents } };
}

// Mismatch error flex message
function mismatchFlex(paidAmount, expectedAmount, billTitle) {
    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                { type: "text", text: "❌ Amount Mismatch", weight: "bold", size: "lg", color: "#FF4444" },
                { type: "separator", margin: "md" },
                { type: "box", layout: "horizontal", margin: "md", contents: [
                    { type: "text", text: "Bill:", color: "#666666", flex: 1 },
                    { type: "text", text: billTitle, flex: 2, align: "end" }
                ]},
                { type: "box", layout: "horizontal", contents: [
                    { type: "text", text: "Expected:", color: "#666666", flex: 1 },
                    { type: "text", text: `฿${expectedAmount}`, flex: 2, align: "end" }
                ]},
                { type: "box", layout: "horizontal", contents: [
                    { type: "text", text: "Received:", color: "#666666", flex: 1 },
                    { type: "text", text: `฿${paidAmount}`, flex: 2, align: "end", color: "#FF4444" }
                ]},
                { type: "text", text: "Payment differs by more than 5%.", wrap: true, size: "sm", color: "#999999", margin: "md" }
            ]
        }
    };
}