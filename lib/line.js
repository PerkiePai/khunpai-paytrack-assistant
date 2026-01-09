import { messagingApi, validateSignature } from "@line/bot-sdk";

const config = {
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
};

const client = new messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken
});

const blobClient = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: config.channelAccessToken
});

export { client, blobClient, config, validateSignature };
