import jsQR from "jsqr";
import { createCanvas , loadImage } from "canvas";

export async function handleImage(event) {
    const groupId = event.source.groupId;
    const userId = event.source.userId;
    const messageId = event.message.id;

    if (!groupId) return;

    const stream = await client.getMessageContent(messageId);
    const chunks = [];
    for await ( const chunk of stream ) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const img = await loadImage(buffer);
    const canvas = createCanvas(img.width , img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const qr = jsQR(imageData.data, img.width, img.height);

    if (!qr) return console.log("this img is not slip!!");

    return handleSlipImage({
        event, 
        buffer, 
        qrPayload: qr.data
    });



}