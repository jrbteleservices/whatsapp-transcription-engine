const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const { pipeline } = require('stream/promises'); // Robust stream handling

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
            res.sendStatus(200); // Acknowledge early

            console.log(`🎙️ Processing audio: ${audioId}`);

            // Fetch Media URL
            const mediaMeta = await axios.get(`https://graph.facebook.com/v25.0/${audioId}`, {
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });

            const localFilePath = path.join(__dirname, `${audioId}.ogg`);
            
            // Download using pipeline for robustness
            const response = await axios({
                method: 'get',
                url: mediaMeta.data.url,
                responseType: 'stream',
                headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
            });

            await pipeline(response.data, fs.createWriteStream(localFilePath));
            console.log("✅ Download complete");

            // Transcription & AI logic...
            // (Ensure you append your existing transcription/AI calls here)
            
            if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Final Error:", error.message);
        if (!res.headersSent) res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server listening on port: ${PORT}`));
