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
                const mentioned = message.mentionedIds && message.mentionedIds.includes(botId);
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
        
        const sendMedia = async (filePath, key) => {
            if (!filePath) return;
            try {
                const absPath = path.resolve(filePath);
                if (fs.existsSync(absPath)) {
                    const media = await Media.fromFilePath(absPath);
                    try {
                        await client.sendMessage(message.from, media);
                    } catch (e) {
                        // Fallback as document for unsupported/large files
                        await client.sendMessage(message.from, media, { sendMediaAsDocument: true });
                    }
                    fs.unlink(absPath, (err) => { if (err) console.error(`[CLEANUP ${key}]`, err.message); });
                }
            } catch (err) { console.error(`[ERROR ${key}]`, err.message); }
        };

        if (data.audio) await sendMedia(data.audio, "audio");
        if (data.video) await sendMedia(data.video, "video");
        if (data.image) await sendMedia(data.image, "image");
        if (data.reply) await message.reply(data.reply).catch(e => console.error("[REPLY]", e.message));
    };

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

    // 3. Sticker recognition (automatic)
    if (message.type === 'sticker' && !message.body?.startsWith('/')) {
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
        return;
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
