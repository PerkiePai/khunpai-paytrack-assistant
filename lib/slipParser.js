import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SLIP_EXTRACTION_PROMPT = `You are an OCR and bank slip information extraction system.

Analyze the provided Thai bank slip image and extract transaction details.

Assumptions:
- Bank name is written in Thai
- Amount is in THB

STRICT RULES:
- Output ONLY valid JSON
- Do NOT include explanations, markdown, or extra text
- If a field cannot be found, return null
- Preserve original Thai text exactly as shown
- Keep masked account numbers as-is (including x and -)
- Amount must be a number (THB)
- Date format: YYYY-MM-DD
- Time format: HH:mm

Return JSON with EXACTLY the following structure and keys:

{
  "bank_name": string | null,
  "amount": number | null,
  "transaction_date": string | null,
  "transaction_time": string | null,
  "sender": string | null,
  "receiver": string | null,
  "reference_id": string | null,
  "channel": string | null
}

Important:
- Do not guess missing information
- Output must be strict JSON only
- Any non-JSON output will be rejected`;

/**
 * Parse bank slip image using Gemini Vision to extract transaction details
 * @param {Buffer} imageBuffer - Image buffer from LINE message
 * @returns {Promise<{
 *   bank_name: string|null,
 *   amount: number|null,
 *   transaction_date: string|null,
 *   transaction_time: string|null,
 *   sender: string|null,
 *   receiver: string|null,
 *   reference_id: string|null,
 *   channel: string|null,
 *   error: string|null
 * }>}
 */
export async function parseSlipImage(imageBuffer) {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash"
        });

        // Convert buffer to base64
        const base64Image = imageBuffer.toString("base64");

        const result = await model.generateContent([
            SLIP_EXTRACTION_PROMPT,
            {
                inlineData: {
                    mimeType: "image/jpeg",
                    data: base64Image
                }
            }
        ]);

        const response = await result.response;
        const text = response.text().trim();

        // Clean up response - remove markdown code blocks if present
        const cleanedText = text
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();

        const parsed = JSON.parse(cleanedText);

        return {
            bank_name: parsed.bank_name || null,
            amount: typeof parsed.amount === "number" ? parsed.amount : null,
            transaction_date: parsed.transaction_date || null,
            transaction_time: parsed.transaction_time || null,
            sender: parsed.sender || null,
            receiver: parsed.receiver || null,
            reference_id: parsed.reference_id || null,
            channel: parsed.channel || null,
            error: null
        };
    } catch (error) {
        console.error("Error parsing slip with Gemini:", error);
        return {
            bank_name: null,
            amount: null,
            transaction_date: null,
            transaction_time: null,
            sender: null,
            receiver: null,
            reference_id: null,
            channel: null,
            error: error.message
        };
    }
}
