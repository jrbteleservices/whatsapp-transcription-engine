const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Supabase Client Connection
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. WEBHOOK VERIFICATION (Handshake for Meta Setup)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === META_VERIFY_TOKEN) {
        console.log("✅ Meta Webhook Verification successful!");
        return res.status(200).send(challenge);
    }
    console.warn("❌ Webhook verification failed. Tokens do not match.");
    res.sendStatus(403);
});

// 2. MAIN WEBHOOK INGESTION
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        // Print incoming payload alerts immediately to the Render console log stream
        console.log("📥 Incoming Webhook Received Payload:", JSON.stringify(body));

        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from; // User's phone number

            if (message.type === 'audio') {
                const audioId = message.audio.id;
                
                // Immediately reply with 200 OK to Meta to avoid timeout loops
                res.sendStatus(200);

                console.log(`🎙️ Processing incoming audio message ID: ${audioId} from user: ${from}`);

                // --- DATABASE CHECK ENGINE ---
                let { data: user, error: userError } = await supabase
                    .from('users')
                    .select('*')
                    .eq('phone_number', from)
                    .maybeSingle(); // Safely returns null instead of throwing an error if row is absent

                // If user doesn't exist, create a trial record automatically
                if (!user) {
                    console.log(`✨ Creating new database trial record row for phone number: ${from}`);
                    const { data: newUser, error: insertError } = await supabase
                        .from('users')
                        .insert([{ phone_number: from, subscription_status: 'trial', total_minutes_allowed: 600, minutes_used: 0 }])
                        .select()
                        .single();
                    user = newUser;
                }

                // Check if they ran out of trial allowance minutes
                if (user.minutes_used >= user.total_minutes_allowed) {
                    console.warn(`⚠️ User ${from} has exceeded their maximum trial limits.`);
                    await sendWhatsAppMessage(from, body.entry[0].changes[0].value.metadata.phone_number_id, 
                        `⚠️ *Limit Exceeded!*\nYou have used all your 600 minutes for the year.\n\nUpgrade here to get unlimited access: [Stripe Payment Link Placeholder]`);
                    return;
                }

                // Step A: Fetch Secure Media Download URL from Meta (UPDATED TO V25.0)
                console.log("🔗 Fetching secure audio download string from Meta Graph API v25.0...");
                const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v25.0/${audioId}`, {
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                const downloadUrl = mediaUrlResponse.data.url;

                // Step B: Download Audio Locally
                const localFilePath = path.join(__dirname, `${audioId}.ogg`);
                const writer = fs.createWriteStream(localFilePath);
                
                console.log(`💾 Downloading audio binary layout straight onto local disk space path...`);
                const audioDownload = await axios({
                    method: 'get',
                    url: downloadUrl,
                    responseType: 'stream',
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                audioDownload.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // Step C: Send File to Groq Whisper for instant transcribing
                const FormData = require('form-data');
                const form = new FormData();
                form.append('file', fs.createReadStream(localFilePath));
                form.append('model', 'whisper-large-v3');

                console.log("🗣️ Transmitting raw voice track buffer straight to Groq Whisper API engine...");
                const transcriptionResponse = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    }
                });
                const rawTranscript = transcriptionResponse.data.text;
                console.log(`📝 Audio transcription engine successfully output text: "${rawTranscript.substring(0, 45)}..."`);

                // Estimate audio minutes processed (rough word-count fallback math)
                const estimatedMinutes = Math.max(1, Math.ceil(rawTranscript.split(" ").length / 150));

                // Step D: Format and summarize using Gemini 2.0 Flash
                const systemPrompt = `You are an expert assistant. Format this transcript into a clean WhatsApp layout. Keep it sharp.\n\n📝 *SUMMARY*:\n[1-2 sentences overview]\n\n🔑 *KEY TAKEAWAYS*:\n• [Item 1]\n• [Item 2]\n\n⚡ *ACTION ITEMS*:\n• [Action item]`;
                
                console.log("🤖 Querying Gemini 2.0 Flash for semantic analysis and formatting blocks...");
                const geminiResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
                    contents: [{ parts: [{ text: `${systemPrompt}\n\nTranscript Content:\n${rawTranscript}` }] }]
                });
                let formattedSummary = geminiResponse.data.candidates[0].content.parts[0].text;

                // Update usage accounting balance for this phone number inside Supabase
                const newMinutesUsed = user.minutes_used + estimatedMinutes;
                await supabase
                    .from('users')
                    .update({ minutes_used: newMinutesUsed })
                    .eq('phone_number', from);
                console.log(`📊 Updated user minutes accounting: ${newMinutesUsed} total minutes used.`);

                // Append remaining countdown balance footer text details to the summary payload
                formattedSummary += `\n\n---\n⏳ *Balance:* ${user.total_minutes_allowed - newMinutesUsed} / ${user.total_minutes_allowed} minutes left.`;

                // Step E: Send formatted summary back via WhatsApp
                await sendWhatsAppMessage(from, body.entry[0].changes[0].value.metadata.phone_number_id, formattedSummary);
                console.log("🚀 Summary payload message dispatched back to WhatsApp chat thread successfully!");

                // Local workspace housecleaning
                if (fs.existsSync(localFilePath)) {
                    fs.unlinkSync(localFilePath);
                    console.log("🧹 Local file clean up tracking clear.");
                }
                return;
            }
        }
        // If it's a regular text message or metadata status drop from Meta, resolve with 200
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Webhook processing error logs:", error.response?.data || error.message);
        // Ensure a fallback response is sent if headers weren't already sent down
        if (!res.headersSent) {
            res.sendStatus(500);
        }
    }
});

// Helper function to transmit outbound WhatsApp payloads (UPDATED TO V25.0)
async function sendWhatsAppMessage(to, phone_number_id, textBody) {
    await axios.post(`https://graph.facebook.com/v25.0/${phone_number_id}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: textBody }
    }, {
        headers: { 
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 
            'Content-Type': 'application/json' 
        }
    });
}

app.listen(PORT, () => console.log(`🚀 Micro-SaaS application engine listening on port: ${PORT}`));
