import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

async function testGemini() {
    console.log("=== Gemini API Connection Test ===\n");

    // Check API key
    if (!process.env.GEMINI_API_KEY) {
        console.error("GEMINI_API_KEY is not set in .env");
        process.exit(1);
    }
    console.log("GEMINI_API_KEY found\n");

    console.log("Testing connection to Gemini API...\n");
    const startTime = Date.now();

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const result = await model.generateContent("Say 'Hello' in one word");
        const response = await result.response;
        const text = response.text();

        const elapsed = Date.now() - startTime;

        console.log("Connection successful!");
        console.log(`Response: ${text.trim()}`);
        console.log(`Completed in ${elapsed}ms`);

    } catch (error) {
        console.error("Connection failed:", error.message);
        process.exit(1);
    }
}

testGemini();
