const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const AI_SERVER = 'http://localhost:5000/reply';
const BOT_NAME = 'Crimsonej'; // your bot's name

let botId = null;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/home/joa/chromium-for-bot/chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code with WhatsApp.');
});

client.on('ready', () => {
    botId = client.info.wid._serialized;
    console.log('Bot ID:', botId);
    console.log('WhatsApp client is ready!');
});

client.on('message', async (message) => {
    // 1. Diagnostic log at the very first line
    console.log(`[DEBUG] New message from ${message.from}: ${message.body}`);

    // 2. Ignore messages from the bot itself to avoid loops
    if (message.from === botId || message.author === botId) {
        return;
    }

    const isGroup = message.from.includes('@g.us');
    let shouldProcess = false;

    if (isGroup) {
        // 3a. Command prefix check — always forward /commands regardless of mentions
        const isCommand = message.body && message.body.startsWith('/');
        if (isCommand) {
            console.log(`[DEBUG] Command detected: ${message.body.split(' ')[0]}`);
            shouldProcess = true;
        } else {
            // 3b. Define the three conditions for responding in a group
            const nameMentioned = message.body && message.body.toLowerCase().includes(BOT_NAME.toLowerCase());
            const mentioned = message.mentionedIds && message.mentionedIds.includes(botId);
            let replyToBot = false;

            if (message.hasQuotedMsg) {
                try {
                    const quoted = await message.getQuotedMessage();
                    
                    // Detailed debug logs for the quoted message
                    console.log(`[DEBUG] Quote Metadata - ID: ${quoted.id._serialized}`);
                    console.log(`[DEBUG] Quote Authorship - Author: ${quoted.author}, FromMe: ${quoted.fromMe}, BotID: ${botId}`);

                    // Check 1: Using the library's native .fromMe flag (most reliable)
                    // Check 2: Comparing the ID strings directly
                    // Check 3: Comparing the numerical part of the ID (fallback)
                    const isIdMatch = (quoted.author === botId || quoted.from === botId);
                    const isPartIdMatch = botId && quoted.author && (quoted.author.split('@')[0] === botId.split('@')[0]);
                    
                    if (quoted.fromMe || isIdMatch || isPartIdMatch) {
                        console.log("[DEBUG] Triggering: THIS IS A REPLY TO THE BOT!");
                        replyToBot = true;
                    } else {
                        console.log("[DEBUG] Skipping quote: Not a reply to the bot.");
                    }
                } catch (err) {
                    console.error("[ERROR] Critical failure while fetching quoted message:", err.stack);
                }
            }

            // Log the decision factors for monitoring
            console.log(`[DEBUG] Group Evaluation - nameMentioned: ${nameMentioned}, mentioned: ${mentioned}, hasQuotedMsg: ${message.hasQuotedMsg}, replyToBot: ${replyToBot}`);

            if (nameMentioned || mentioned || replyToBot) {
                shouldProcess = true;
            }
        }
    } else {
        // 4. For direct messages, always proceed
        shouldProcess = true;
    }

    if (!shouldProcess) return;

    // Extract raw phone number (digits only, no domain or device suffix)
    const rawSender = message.author || message.from;
    const senderNumber = rawSender.split('@')[0].split(':')[0];

    // Capture quoted message text if replying to something
    let quotedText = null;
    if (message.hasQuotedMsg) {
        try {
            const quotedMsg = await message.getQuotedMessage();
            quotedText = quotedMsg.body;
        } catch (e) {
            console.error('[ERROR] Failed to fetch quoted message:', e.message);
        }
    }

    try {
        const response = await axios.post(AI_SERVER, {
            message: message.body || "[sticker]",
            quoted_message: quotedText,    // quoted message text (null if none)
            sender: message.from,          // keep original for memory
            user_phone: senderNumber,      // clean phone number
        });

        console.log("AI response:", response.data);

        // Helper function for sending media robustly
        const sendMedia = async (filePath) => {
            if (!filePath) return;
            try {
                // Ensure absolute path
                const absPath = path.resolve(filePath);
                
                // Ensure file is readable
                try {
                    fs.accessSync(absPath, fs.constants.R_OK);
                } catch (e) {
                    console.error(`[ERROR] File not readable or does not exist: ${absPath}`);
                    return;
                }

                const media = await MessageMedia.fromFilePath(absPath);
                
                try {
                    // Try to send normally
                    await client.sendMessage(message.from, media);
                } catch (sendError) {
                    console.error(`[ERROR] Failed standard send for ${absPath}, retrying as document:`, sendError.message);
                    // Fallback to sending as document for unsupported formats
                    // Adding a check for 'detached Frame' to avoid crash loop
                    if (sendError.message.includes('detached Frame')) {
                         console.error('[CRITICAL] Browser state invalid, cannot send media.');
                         return;
                    }
                    await client.sendMessage(message.from, media, { sendMediaAsDocument: true });
                }

                // Cleanup temp file
                fs.unlink(absPath, (err) => { if (err) console.error('[CLEANUP]', err.message); });
            } catch (mediaError) {
                console.error(`[ERROR] Failed to process media ${filePath}:`, mediaError.message);
            }
        };

        // Send audio, video, image if present
        if (response.data.audio) await sendMedia(response.data.audio);
        if (response.data.video) await sendMedia(response.data.video);
        if (response.data.image) await sendMedia(response.data.image);

        // Send text reply if present
        if (response.data.reply) {
            await message.reply(response.data.reply);
        }
    } catch (error) {
        console.error('[ERROR] AI Server issue:', error.message);
    }
});

client.initialize();
