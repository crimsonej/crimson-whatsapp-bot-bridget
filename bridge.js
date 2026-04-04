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
    // 1. Diagnostic log
    console.log(`[DEBUG] New message from ${message.from}: ${message.body || "[media]"}`);

    // 2. Ignore status broadcasts and own messages
    if (message.from === 'status@broadcast' || message.from === botId || message.author === botId) return;

    const isGroup = message.from.includes('@g.us');
    let shouldProcess = true;

    // Extract raw phone number for session tracking
    let userPhone = message.from.replace('@c.us', '').replace('@g.us', '');
    if (message.author) {
        // Group message: author is the individual ID
        userPhone = message.author.replace('@c.us', '');
    }

    // Helper to send all types of AI responses (text/media)
    const handleAIResponse = async (response) => {
        if (!response || !response.data) return;
        const data = response.data;
        const Media = MessageMedia; // Alias for compatibility with common snippets
        
        const sendMedia = async (filePath, key, filename) => {
            if (!filePath) return;
            try {
                const absPath = path.resolve(filePath);
                if (!fs.existsSync(absPath)) {
                    console.error(`[${key}] File not found: ${absPath}`);
                    return;
                }

                const stats = fs.statSync(absPath);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                console.log(`[MEDIA ${key}] Sending ${absPath} (${sizeMB} MB)`);

                const media = await Media.fromFilePath(absPath);

                // Use the desired realistic filename if provided
                if (filename) {
                    media.filename = filename;
                }

                // Set correct MIME types for WhatsApp compatibility
                if (key === 'audio' && !media.mimetype?.startsWith('audio/')) {
                    media.mimetype = 'audio/mpeg';
                }
                if (key === 'video' && !media.mimetype?.startsWith('video/')) {
                    media.mimetype = 'video/mp4';
                }

                try {
                    // Maximum WhatsApp limit typically allows up to ~64MB for inline media
                    if (stats.size > 64 * 1024 * 1024) {
                        console.log(`[MEDIA ${key}] Large file > 64MB, sending as document`);
                        await client.sendMessage(message.from, media, { sendMediaAsDocument: true });
                    } else {
                        await client.sendMessage(message.from, media);
                    }
                } catch (e) {
                    console.log(`[MEDIA ${key}] Inline send failed, trying as document...`);
                    await client.sendMessage(message.from, media, { sendMediaAsDocument: true });
                }

                // Cleanup temp file
                fs.unlink(absPath, (err) => { if (err) console.error(`[CLEANUP ${key}]`, err.message); });
            } catch (err) { console.error(`[ERROR ${key}]`, err.message); }
        };

        if (data.audio) await sendMedia(data.audio, "audio", data.filename);
        if (data.video) await sendMedia(data.video, "video", data.filename);
        if (data.image) await sendMedia(data.image, "image", data.filename);

        // Determine the target message for replies
        let targetMessage = message;
        if (data.reply_to_quoted && message.hasQuotedMsg) {
            try {
                targetMessage = await message.getQuotedMessage();
            } catch (err) {
                console.error("[ERROR] Failed to fetch quoted message for target:", err.message);
            }
        }

        // 2. Send Sticker if present (direct base64 or file path)
        if (data.sticker) {
            try {
                let stickerMedia;
                if (fs.existsSync(data.sticker)) {
                    stickerMedia = await Media.fromFilePath(data.sticker);
                } else {
                    stickerMedia = new Media('image/webp', data.sticker);
                }
                await targetMessage.reply(stickerMedia, null, { sendMediaAsSticker: true });
            } catch (err) {
                console.error('[ERROR Sticker Send]', err.message);
            }
        } 
        // 3. Send text reply (fallback if no sticker)
        else if (data.reply) {
            await targetMessage.reply(data.reply).catch(e => console.error("[REPLY]", e.message));
        }
    };

    // ----- Process Sticker Replies First -----
    if (message.type === 'sticker' && (!message.body || !message.body.startsWith('/'))) {
        let processSticker = false;
        if (!isGroup) {
            processSticker = true;
        } else if (message.hasQuotedMsg) {
            try {
                const quoted = await message.getQuotedMessage();
                const isIdMatch = (quoted.author === botId || quoted.from === botId);
                const isPartIdMatch = botId && quoted.author && (quoted.author.split('@')[0] === botId.split('@')[0]);
                if (quoted.fromMe || isIdMatch || isPartIdMatch) {
                    processSticker = true;
                }
            } catch (err) {
                console.error("[ERROR] Failed to fetch quoted message for sticker:", err.stack);
            }
        }

        if (processSticker) {
            const media = await message.downloadMedia();
            if (media) {
                try {
                    const response = await axios.post(AI_SERVER, {
                        sticker: true,
                        sticker_data: media.data,
                        sticker_mimetype: media.mimetype,
                        sender: message.from,
                        user_phone: userPhone
                    });
                    await handleAIResponse(response);
                } catch (err) {
                    console.log('Sticker analysis error:', err.message);
                }
            }
        }
        return; // Always return on stickers to avoid sending text payloads to AI
    }

    // ----- Group filter: only process if addressed to bot or a command -----
    if (isGroup) {
        let isAddressed = false;

        // 3a. Command prefix check — always forward /commands regardless of mentions
        const isCommand = message.body && message.body.startsWith('/');
        if (isCommand) {
            isAddressed = true;
        } else {
            // 3b. Check if message has text/caption for name/tag mentions
            if (message.body) {
                const mentioned = message.mentionedIds && message.mentionedIds.some(id => id.split('@')[0] === botId.split('@')[0]);
                const nameMentioned = message.body.toLowerCase().includes(BOT_NAME.toLowerCase());
                isAddressed = mentioned || nameMentioned;
            }

            // 3c. If not addressed yet, check if it's a reply to the bot
            if (!isAddressed && message.hasQuotedMsg) {
                try {
                    const quoted = await message.getQuotedMessage();
                    // Robust check: native fromMe flag OR ID match (including device splits)
                    const isIdMatch = (quoted.author === botId || quoted.from === botId);
                    const isPartIdMatch = botId && quoted.author && (quoted.author.split('@')[0] === botId.split('@')[0]);
                    
                    if (quoted.fromMe || isIdMatch || isPartIdMatch) {
                        isAddressed = true;
                    }
                } catch (err) {
                    console.error("[ERROR] Failed to fetch quoted message:", err.stack);
                }
            }
        }
        if (!isAddressed) shouldProcess = false;
    }

    if (!shouldProcess) return;



    // ----- Process based on message type -----

    // 1. Image recognition command (/reg-img)
    if (message.body && message.body.startsWith('/reg-img')) {
        let imageData = null;
        let quotedMsgIdx = null;

        if (message.hasMedia) {
            imageData = await message.downloadMedia();
        } else if (message.hasQuotedMsg) {
            const quoted = await message.getQuotedMessage();
            if (quoted.hasMedia) {
                imageData = await quoted.downloadMedia();
            }
        }

        if (!imageData) {
            await message.reply('Please send an image or reply to one with /reg-img');
            return;
        }

        try {
            const response = await axios.post(AI_SERVER, {
                message: message.body,
                image_base64: imageData.data,
                mime_type: imageData.mimetype,
                sender: message.from,
                user_phone: userPhone
            });
            await handleAIResponse(response);
        } catch (error) {
            console.log('Error analyzing image:', error.message);
            await message.reply('Sorry, I could not analyze that image.');
        }
        return;
    }

    // 2. Sticker conversion command (/sticker)
    if (message.body && (message.body.startsWith('/sticker') || message.body === '/sticker')) {
        let media = null;
        let mediaType = null;
        let quotedMsg = null;

        // Check if the message itself has media
        if (message.hasMedia) {
            media = await message.downloadMedia();
            mediaType = message.type; // 'image' or 'video'
        }
        // If not, check if it's a reply to a media message
        else if (message.hasQuotedMsg) {
            quotedMsg = await message.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                media = await quotedMsg.downloadMedia();
                mediaType = quotedMsg.type;
            }
        }

        if (!media) {
            await message.reply('Please send or reply to an image/video with /sticker');
            return;
        }

        // Convert image to WebP sticker, or video to GIF
        if (mediaType === 'image') {
            const sharp = require('sharp');
            const buffer = Buffer.from(media.data, 'base64');
            const webpBuffer = await sharp(buffer).webp().toBuffer();
            const stickerMedia = new MessageMedia('image/webp', webpBuffer.toString('base64'));
            await client.sendMessage(message.from, stickerMedia, { sendMediaAsSticker: true });
            return;
        } 
        else if (mediaType === 'video') {
            const fs = require('fs');
            const { exec } = require('child_process');
            const path = require('path');
            const util = require('util');
            const execPromise = util.promisify(exec);

            const origPath = path.join('/tmp', `orig_${Date.now()}.mp4`);
            const outPath = path.join('/tmp', `sticker_${Date.now()}.webp`);

            fs.writeFileSync(origPath, Buffer.from(media.data, 'base64'));

            try {
                // Trim to 6 seconds, resize to 512x512, convert to WebP
                const cmd = `ffmpeg -i "${origPath}" -t 6 -vf "fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -c:v libwebp -quality 70 -loop 0 -an "${outPath}" -y`;
                console.log(`Running: ${cmd}`);
                await execPromise(cmd);

                const stickerData = fs.readFileSync(outPath).toString('base64');
                const stickerMedia = new MessageMedia('image/webp', stickerData);
                await client.sendMessage(message.from, stickerMedia, { sendMediaAsSticker: true });
            } catch (err) {
                console.error('ffmpeg error:', err);
                await message.reply('Sorry, I couldn’t convert that video to an animated sticker.');
            } finally {
                if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
            return;
        }
        else {
            await message.reply('Unsupported media type. Use an image or video.');
            return;
        }
    }



    // Capture quoted message text and media for automatic vision/other messages
    let quotedText = null;
    let imageData = null;

    if (message.hasQuotedMsg) {
        try {
            const quotedMsg = await message.getQuotedMessage();
            quotedText = quotedMsg.body;
            
            // Proactively download media if it's an image/sticker for potential vision analysis
            if (quotedMsg.hasMedia && (quotedMsg.type === 'image' || quotedMsg.type === 'sticker')) {
                const media = await quotedMsg.downloadMedia();
                if (media) {
                    imageData = media.data;
                    console.log("[DEBUG] Downloaded media from QUOTED message.");
                }
            }
        } catch (e) {
            console.error('[ERROR] Failed to fetch quoted message or media:', e.message);
        }
    }

    // Check for direct media if not from quote
    if (!imageData && message.hasMedia && (message.type === 'image' || message.type === 'sticker')) {
        try {
            const media = await message.downloadMedia();
            if (media) {
                imageData = media.data;
                console.log("[DEBUG] Downloaded media from DIRECT message.");
            }
        } catch (e) {
            console.error('[ERROR] Failed to download direct media:', e.message);
        }
    }

    try {
        const response = await axios.post(AI_SERVER, {
            message: message.body || "[media]",
            quoted_message: quotedText,
            image_data: imageData,
            image_base64: imageData,
            sender: message.from,
            user_phone: userPhone,
        });
        await handleAIResponse(response);
    } catch (error) {
        console.error('[ERROR] AI Server issue:', error.message);
    }
});

client.initialize();
