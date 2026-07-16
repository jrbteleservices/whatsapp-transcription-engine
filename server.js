const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const { pipeline } = require('stream/promises');

const app = express();
app.use(express.json());

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHONE_NUMBER_ID = '1218771404650240'; // Your verified Phone Number ID

// 1. WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// 2. MAIN WEBHOOK INGESTION
app.post('/webhook', async (req, res) => {
    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        
        if (message?.type === 'audio') {
            const audioId = message.audio.id;
            res.sendStatus(200); // Acknowledge early to Meta

            console.log(`🎙️ Processing audio ID: ${audioId} from ${message.from}`);

            // A. Fetch Meta Media URL
            const mediaMeta = await axios.get(`https://graph.facebook.com/v25.0/${audioId}`, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });

            // B. Robust Download
            const localFilePath = path.join(__dirname, `${audioId}.ogg`);
            const response = await axios({
                method: 'get',
                url: mediaMeta.data.url,
                responseType: 'stream',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });
            await pipeline(response.data, fs.createWriteStream(localFilePath));
            console.log("✅ Download complete");

            // C. Transcription (Groq)
            const form = new FormData();
            form.append('file', fs.createReadStream(localFilePath));
            form.append('model', 'whisper-large-v3');

            const transcriptionResponse = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
                headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
            });
            
            const transcript = transcriptionResponse.data.text;
            console.log(`🗣️ Transcript: ${transcript}`);

            // D. AI Processing (Gemini)
            const geminiResponse = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, 
                { contents: [{ parts: [{ text: `Summarize this and provide key action items: ${transcript}` }] }] }
            );

            const replyText = geminiResponse.data.candidates[0].content.parts[0].text;
            console.log(`🤖 AI Response: ${replyText}`);

            // E. Send Reply to WhatsApp
            await axios.post(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
                messaging_product: "whatsapp",
                to: message.from,
                text: { body: replyText }
            }, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });

            // Cleanup
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        } else {
            res.sendStatus(200);
        }
    } catch (error) {
        console.error("❌ Final Error:", error.message);
        if (!res.headersSent) res.sendStatus(500);
    }
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Engine running on port: ${PORT}`));
} catch (error) {
    if (error.response) {
        console.error("❌ API Rejected Request (Status 429):", error.response.status);
        console.error("❌ Provider Error Data:", JSON.stringify(error.response.data));
    } else {
        console.error("❌ Final Error:", error.message);
    }
    if (!res.headersSent) res.sendStatus(500);
}
