const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, child } = require('firebase/database');

// ==========================================
// 1. CONFIGURATION
// ==========================================

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TARGET_BATCH_ID = "40589"; 

// --- SCHEDULING CONFIGURATION ---
// Format: "Minute Hour DayOfMonth Month DayOfWeek"
// Examples:
// '0 */12 * * *' = Every 12 hours (Current Setting)
// '0 * * * *'    = Every 1 hour
// '0 0 * * *'    = Every day at midnight
// '*/30 * * * *' = Every 30 minutes
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 */12 * * *'; 

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "automateddone.firebaseapp.com",
    databaseURL: "https://automateddone-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "automateddone",
    storageBucket: "automateddone.firebasestorage.app",
    messagingSenderId: "881227012524",
    appId: "1:881227012524:web:8dca369d7f4e63bd384209"
};

const PROXY_BASE = "https://ntxapi.onrender.com/test";
const API_HOST = "https://theeduverse.xyz";
const CONTENT_TYPES = ['lectures', 'notes', 'dpps'];

// ==========================================
// 2. SETUP
// ==========================================

const app = express();
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

// Helper: Proxy URL Generator
const getApiUrl = (path) => {
    const target = `${API_HOST}/api${path}`;
    return `${PROXY_BASE}?url=${encodeURIComponent(target)}&referrer=${encodeURIComponent(API_HOST)}`;
};

// Helper: Format Link
const formatLink = (title, rawUrl) => {
    let finalUrl = rawUrl;
    if (/\/(\d+)_(\d+)\.m3u8$/.test(finalUrl)) {
        finalUrl = finalUrl.replace(/\/(\d+)_(\d+)\.m3u8$/, "/index_1.m3u8");
    }
    if (finalUrl && finalUrl.includes('.m3u8')) {
        finalUrl = `https://smarterz.netlify.app/player?url=${encodeURIComponent(finalUrl)}`;
    }
    return finalUrl;
};

// Helper: Delay to prevent Rate Limiting (Crucial when sending many items)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Capitalize
const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1);

// ==========================================
// 3. AUTOMATION LOGIC
// ==========================================

const runUpdateCycle = async () => {
    // Log to server console only, not Telegram
    console.log(`[${new Date().toISOString()}] Starting 12-Hour Update Cycle...`);

    try {
        // --- A. Fetch Already Completed Items from DB ---
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, `completed_items`));
        const completedMap = snapshot.exists() ? snapshot.val() : {};

        // --- B. Fetch Subjects ---
        const subRes = await axios.get(getApiUrl(`/batches/${TARGET_BATCH_ID}`));
        const subjects = subRes.data.data || [];
        
        console.log(`Found ${subjects.length} subjects. Scanning for content...`);

        // --- C. Iterate Through Everything (Subjects -> Types -> Items) ---
        for (const subject of subjects) {
            for (const type of CONTENT_TYPES) {
                
                // Fetch content
                const contentUrl = getApiUrl(`/${TARGET_BATCH_ID}/subjects/${subject.id}/${type}`);
                let allItems = [];

                try {
                    const contentRes = await axios.get(contentUrl);
                    allItems = contentRes.data.data || [];
                } catch (err) {
                    console.error(`Error fetching ${subject.name} - ${type}:`, err.message);
                    continue; 
                }

                // Filter for pending items
                const pendingItems = allItems.filter(item => !completedMap[item.id]);

                if (pendingItems.length > 0) {
                    console.log(`> Processing ${pendingItems.length} new ${type} for ${subject.name}`);
                    
                    // --- D. Send ALL Pending Items ---
                    for (const item of pendingItems) {
                        const title = item.title || item.name || 'Untitled';
                        const rawUrl = item.url || item.originalUrl || item.baseUrl;
                        const finalLink = formatLink(title, rawUrl);
                        const typeLabel = capitalize(type).replace(/s$/, ''); 

                        // 1. Construct Message
                        const message = 
                            `📌 **${title}**\n` +
                            `📚 **Subject:** ${subject.name}\n` +
                            `📂 **Type:** ${typeLabel}\n\n` +
                            `🔗 [Click to Open](${finalLink})`;

                        try {
                            // 2. Send to Channel
                            await bot.telegram.sendMessage(CHANNEL_ID, message, { 
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true 
                            });

                            // 3. Mark as Done in Firebase
                            await set(ref(db, 'completed_items/' + item.id), true);
                            
                            // 4. Rate Limit Delay (2 seconds is safe for bulk sending)
                            await delay(2000); 

                        } catch (sendErr) {
                            console.error(`Failed to send item ${item.id}:`, sendErr.message);
                            // If Telegram fails, we don't mark as done so it retries next time
                        }
                    }
                }
            }
        }
        console.log(`[${new Date().toISOString()}] Cycle Completed Successfully.`);

    } catch (e) {
        console.error("Critical Error in Update Cycle:", e);
    }
};

// ==========================================
// 4. SCHEDULER
// ==========================================

console.log(`Initializing Scheduler with schedule: ${CRON_SCHEDULE}`);

// Schedule the task based on the config variable
cron.schedule(CRON_SCHEDULE, () => {
    runUpdateCycle();
});

// ==========================================
// 5. SERVER & INIT
// ==========================================

// Manual Trigger for Admin (Private Chat Only - No Channel Logs)
bot.command('force_update', async (ctx) => {
    ctx.reply("🔄 checking for updates..."); // Private reply only
    await runUpdateCycle();
    ctx.reply("✅ Check complete."); // Private reply only
});

bot.launch();

// Keep the server alive
app.get('/', (req, res) => res.send('Bot is Running 🟢'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
