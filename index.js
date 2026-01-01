require("dotenv").config();
const express = require("express");
const { middleware , Client, channelAccessToken } = require("@line/bot-sdk");

const app = express();

const config = {
    channelSecret : process.env.CHANNEL_SECRET,
    channelAccessToken : process.env.CHANNEL_ACCESS_TOKEN
};

const client = new Client(config);

app.post("/webhook" , middleware(config) , ( req , res ) => {
    Promise
        .all(req.body.events.map(event => handleEvent(event)))
        .then(() => res.status(200).end())
        .catch(err => {
            console.error(err);
            res.statusMessage(500).end();
        });
});

function handleEvent(event) {
    if (event.type !== "message" || event.message.type !== "text") {
        return Promise.resolve(null);
    }

    const text = event.message.text;

    if (text == "hii") {
        return client.replyMessage(event.replyToken, {
            type: "text",
            text: "Hello from test bot!"
        });
    }
}

app.listen(3000 , () => {
    console.log("LINE bot is running on port 3000");
});


