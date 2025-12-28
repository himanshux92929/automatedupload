const { Telegraf, Markup } = require('telegraf');
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
const ADMIN_ID = "7380969878"; // Your ID for Logs
const TARGET_BATCH_ID = "40589"; 

// --- SCHEDULING (Midnight IST) ---
// Server time is usually UTC. Midnight IST (00:00) is 18:30 UTC (previous day).
// Cron: Minute(30) Hour(18) * * *
const CRON_SCHEDULE = '30 18 * * *'; 

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
// 2. SETUP & HELPERS
// ==========================================

const app = express();
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

// --- A. Robust Logger (Sends to You) ---
const logToAdmin = async (message) => {
    console.log(message); // Keep server log for backup
    try {
        await bot.telegram.sendMessage(ADMIN_ID, `⚙️ **Log:** ${message}`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Failed to send log to admin:", e.message);
    }
};

// --- B. Font Beautifier (Math Bold Italic) ---
const toMathBoldItalic = (text) => {
    const map = {
        'A': '𝑨', 'B': '𝑩', 'C': '𝑪', 'D': '𝑫', 'E': '𝑬', 'F': '𝑭', 'G': '𝑮', 'H': '𝑯', 'I': '𝑰', 'J': '𝑱', 'K': '𝑲', 'L': '𝑳', 'M': '𝑴', 'N': '𝑵', 'O': '𝑶', 'P': '𝑷', 'Q': '𝑸', 'R': '𝑹', 'S': '𝑺', 'T': '𝑻', 'U': '𝑼', 'V': '𝑽', 'W': '𝑾', 'X': '𝑿', 'Y': '𝒀', 'Z': '𝒁',
        'a': '𝒂', 'b': '𝒃', 'c': '𝒄', 'd': '𝒅', 'e': '𝒆', 'f': '𝒇', 'g': '𝒈', 'h': '𝒉', 'i': '𝒊', 'j': '𝒋', 'k': '𝒌', 'l': '𝒍', 'm': '𝒎', 'n': '𝒏', 'o': '𝒐', 'p': '𝒑', 'q': '𝒒', 'r': '𝒓', 's': '𝒔', 't': '𝒕', 'u': '𝒖', 'v': '𝒗', 'w': '𝒘', 'x': '𝒙', 'y': '𝒚', 'z': '𝒛'
    };
    return text.split('').map(char => map[char] || char).join('');
};

// --- C. Retry Fetcher (Prevents Timeout Crash) ---
const fetchWithRetry = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url, { timeout: 10000 }); // 10s timeout
        } catch (err) {
            if (i === retries - 1) throw err; // Throw if last attempt fails
            await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
        }
    }
};

const getApiUrl = (path) => {
    const target = `${API_HOST}/api${path}`;
    return `${PROXY_BASE}?url=${encodeURIComponent(target)}&referrer=${encodeURIComponent(API_HOST)}`;
};

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

// ==========================================
// 3. AUTOMATION LOGIC
// ==========================================

const runUpdateCycle = async () => {
    await logToAdmin(`🚀 **Update Cycle Started**`);

    try {
        // 1. Fetch Completed Items
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, `completed_items`));
        const completedMap = snapshot.exists() ? snapshot.val() : {};

        // 2. Fetch Subjects (With Retry)
        let subjects = [];
        try {
            const subRes = await fetchWithRetry(getApiUrl(`/batches/${TARGET_BATCH_ID}`));
            subjects = subRes.data.data || [];
        } catch (err) {
            await logToAdmin(`❌ Critical: Failed to fetch subjects. ${err.message}`);
            return;
        }

        let newItemsCount = 0;

        // 3. Process Loops
        for (const subject of subjects) {
            for (const type of CONTENT_TYPES) {
                
                // Fetch Content (With Retry & Try-Catch so loop doesn't break)
                let allItems = [];
                try {
                    const contentUrl = getApiUrl(`/${TARGET_BATCH_ID}/subjects/${subject.id}/${type}`);
                    const contentRes = await fetchWithRetry(contentUrl);
                    allItems = contentRes.data.data || [];
                } catch (err) {
                    // Log error but CONTINUE to next type/subject
                    await logToAdmin(`⚠️ Skip: ${subject.name} (${type}) failed. ${err.message}`);
                    continue; 
                }

                const pendingItems = allItems.filter(item => !completedMap[item.id]);

                if (pendingItems.length > 0) {
                    
                    for (const item of pendingItems) {
                        try {
                            const title = item.title || item.name || 'Untitled';
                            const rawUrl = item.url || item.originalUrl || item.baseUrl;
                            const finalLink = formatLink(title, rawUrl);
                            
                            // Beautify Text
                            const subjectStyled = toMathBoldItalic(subject.name);
                            const topicStyled = toMathBoldItalic(title);
                            
                            let typeLabel = "Unknown";
                            let buttonText = "Open Link";

                            if (type === 'lectures') { typeLabel = "Lecture"; buttonText = "📺 Watch Lecture"; }
                            if (type === 'notes') { typeLabel = "Notes"; buttonText = "📄 Open Notes"; }
                            if (type === 'dpps') { typeLabel = "DPP"; buttonText = "📝 Open DPP"; }

                            // Construct Message (The Design You Asked For)
                            const message = 
`${subjectStyled}
_________________

Topic :- ${topicStyled}
Type :- ${typeLabel}
_________________`;

                            // Send to Channel with Button
                            await bot.telegram.sendMessage(CHANNEL_ID, message, {
                                ...Markup.inlineKeyboard([
                                    [Markup.button.url(buttonText, finalLink)]
                                ])
                            });

                            // Save to DB
                            await set(ref(db, 'completed_items/' + item.id), true);
                            newItemsCount++;
                            
                            // Delay to respect rate limits
                            await new Promise(r => setTimeout(r, 2000));

                        } catch (sendErr) {
                            await logToAdmin(`❌ Error sending ${item.id}: ${sendErr.message}`);
                        }
                    }
                }
            }
        }
        await logToAdmin(`✅ **Cycle Finished.** Uploaded: ${newItemsCount} items.`);

    } catch (e) {
        await logToAdmin(`💀 **CRITICAL SYSTEM FAILURE:** ${e.message}`);
    }
};

// ==========================================
// 4. SCHEDULER & COMMANDS
// ==========================================

// Midnight IST = 18:30 UTC
cron.schedule(CRON_SCHEDULE, () => {
    runUpdateCycle();
});

// Force Update Command
bot.command('force_update', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return; // Security Check
    ctx.reply("🔄 Force update initialized...");
    await runUpdateCycle();
});

bot.launch();

// Server Keep-Alive
app.get('/', (req, res) => res.send('Bot is Running 🟢'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
