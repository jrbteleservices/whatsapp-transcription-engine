const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');

const app = express();
app.use(express.json());

// Initialize Supabase and Config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 1. WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.META_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

// 2. MAIN WEBHOOK INGESTION
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log("📥 Incoming Webhook Received Payload:", JSON.stringify(body));

        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const message = body.entry[0].changes[0].value.messages[0];
            const from = message.from;

            if (message.type === 'audio') {
                const audioId = message.audio.id;
                res.sendStatus(200); // Acknowledge early

                console.log(`🎙️ Processing incoming audio message ID: ${audioId} from user: ${from}`);

                // Database check/create logic
                let { data: user, error: userError } = await supabase
                    .from('users')
                    .select('*')
                    .eq('phone_number', from)
                    .maybeSingle();

                if (!user) {
                    console.log(`✨ Creating new database trial record row for phone number: ${from}`);
                    const { data: newUser, error: insertError } = await supabase
                        .from('users')
                        .insert([{ 
                            phone_number: from, 
                            subscription_status: 'trial', 
                            total_minutes_allowed: 600, 
                            minutes_used: 0 
                        }])
                        .select()
                        .single();
                    
                    if (insertError) throw insertError;
                    user = newUser; // FIX: Assign created user to the variable
                }

                if (user.minutes_used >= user.total_minutes_allowed) {
                    return;
                }

                // Download Audio
                const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v25.0/${audioId}`, {
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                const downloadUrl = mediaUrlResponse.data.url;
                const localFilePath = path.join(__dirname, `${audioId}.ogg`);
                const writer = fs.createWriteStream(localFilePath);
                
                const audioDownload = await axios({
                    method: 'get',
                    url: downloadUrl,
                    responseType: 'stream',
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                audioDownload.data.pipe(writer);
                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

                // Transcription & AI
                const form = new FormData();
                form.append('file', fs.createReadStream(localFilePath));
                form.append('model', 'whisper-large-v3');

                const transcriptionResponse = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
                    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
                });
                
                const geminiResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
                    contents: [{ parts: [{ text: `Format this transcript:\n${transcriptionResponse.data.text}` }] }]
                });

                // Update Usage
                await supabase.from('users').update({ minutes_used: user.minutes_used + 1 }).eq('phone_number', from);
                
                // Cleanup
                if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
                return;
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Webhook processing error logs:", error.message);
        if (!res.headersSent) res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Engine listening on port: ${PORT}`));
