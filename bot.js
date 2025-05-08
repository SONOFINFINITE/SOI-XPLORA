const { Bot } = require('grammy'); // webhookCallback removed as it's not directly used in this modified version's startup
const { sendSearchRequest, getResponse } = require('./neuroSearch');
const marked = require('marked');
// const { escape } = require('grammy'); // 'escape' is imported but not used.
const dotenv = require('dotenv');
dotenv.config();

// --- START OF NEW IMPORTS ---
const express = require('express');
const crypto = require('crypto'); // For generating a more secure secret path
const fs = require('fs');
const path = require('path');
// For Node.js versions < 18, you might need 'node-fetch'.
// If so, uncomment the next line and run: npm install node-fetch@2
// const fetch = require('node-fetch');
// For Node.js 18+, global 'fetch' is available. We'll assume Node 18+ or Render's environment provides it.
// --- END OF NEW IMPORTS ---

if (!process.env.BOT_TOKEN) {
  console.error('⛔ BOT_TOKEN not found in environment variables!');
  process.exit(1);
}

// --- START OF ASSEMBLYAI CONFIG ---
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!ASSEMBLYAI_API_KEY) {
  console.warn('⚠️ ASSEMBLYAI_API_KEY not found in environment variables! Voice message processing will be disabled.');
}

const TEMP_AUDIO_DIR = path.join(__dirname, 'temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
  try {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
    console.log(`Temporary audio directory created at: ${TEMP_AUDIO_DIR}`);
  } catch (error) {
    console.error(`Error creating temporary audio directory ${TEMP_AUDIO_DIR}:`, error);
    // Decide if this is fatal or if voice processing should just be disabled.
    // For now, we'll let it proceed but voice processing will likely fail.
  }
}
// --- END OF ASSEMBLYAI CONFIG ---


// Настройка marked для безопасного преобразования Markdown в HTML
marked.setOptions({
  renderer: new marked.Renderer(),
  highlight: null,
  pedantic: false,
  gfm: true,
  breaks: true,
  sanitize: false, // Note: sanitize: false can be a security risk if markdown source is untrusted.
  smartypants: false,
  xhtml: false
});

const bot = new Bot(process.env.BOT_TOKEN);

// --- START OF NEW /start COMMAND HANDLER ---
bot.command('start', async (ctx) => {
  const welcomeMessage = `
Привет! 👋 Я XPLORA - твой умный ассистент для поиска информации в интернете. 🧠
Просто отправь мне свой вопрос, и я постараюсь найти на него самый точный и развернутый ответ! 🚀

Отправляй текстовые или голосовые сообщения! 🎤
  `;
  await ctx.reply(welcomeMessage, {
    parse_mode: 'Markdown',
    reply_parameters: { message_id: ctx.msg.message_id }
  });
});
// --- END OF NEW /start COMMAND HANDLER ---

// Функция для конвертации Markdown в HTML
function markdownToHTML(markdown, linksData = []) { // linksData parameter is defined but not used in its call.
  try {
    const renderer = new marked.Renderer();

    const linkMap = new Map();
    let linkCounter = 1;

    renderer.link = (href, title, text) => {
      if (typeof href === 'object' && href.href) {
        const linkUrl = href.href;
        if (/^\d+$/.test(href.text?.replace(/[`\s]/g, ''))) {
          if (!linkMap.has(linkUrl)) {
            linkMap.set(linkUrl, linkCounter++);
          }
          return `<a href="${linkUrl}">[${linkMap.get(linkUrl)}]</a>`;
        }
        return `<a href="${linkUrl}">${href.text || text}</a>`;
      }
      return `<a href="${href}">${text}</a>`;
    };

    marked.setOptions({ renderer });

    if (!markdown) {
      console.warn('Получен пустой markdown');
      return '';
    }

    const unescapedMarkdown = markdown
      .replace(/\\([_*\[\]()~`>#+=|{}.!-])/g, '$1');
    return marked.parse(unescapedMarkdown);
  } catch (error) {
    console.error('Ошибка при конвертации Markdown в HTML:', error, {markdown});
    return markdown || '';
  }
}

// Функция для очистки HTML и использования только поддерживаемых Telegram тегов
function cleanHTMLForTelegram(html) {
  return html
    .replace(/<\/?p>/g, '\n')
    .replace(/<\/?br\/?>/g, '\n')
    .replace(/<\/?div>/g, '\n')
    .replace(/<h[1-6]>/g, '<b>')
    .replace(/<\/h[1-6]>/g, '</b>\n')
    .replace(/<\/?ul>/g, '\n')
    .replace(/<\/?ol>/g, '\n')
    .replace(/<li>/g, '• ')
    .replace(/<\/li>/g, '\n')
    .replace(/<(?!\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|span class="tg-spoiler")[>\s])[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- START OF ASSEMBLYAI HELPER FUNCTIONS ---
async function uploadFileToAssemblyAI(audioFilePath, apiKey) {
  console.log(`[AssemblyAI] Uploading file: ${audioFilePath}`);
  const fileStream = fs.createReadStream(audioFilePath);
  // const stats = fs.statSync(audioFilePath); // Not strictly needed for upload_url

  const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      // 'Content-Type' will be set by fetch based on the stream
      // 'Transfer-Encoding': 'chunked' // Usually handled by Node/fetch
    },
    body: fileStream,
  });

  if (!uploadResponse.ok) {
    const errorBody = await uploadResponse.text().catch(() => 'Could not read error body');
    console.error('[AssemblyAI] Upload failed:', uploadResponse.status, errorBody);
    throw new Error(`AssemblyAI upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }
  const uploadData = await uploadResponse.json();
  console.log('[AssemblyAI] File uploaded, URL:', uploadData.upload_url);
  return uploadData.upload_url;
}

async function requestTranscriptionAssemblyAI(audioUrl, apiKey) {
  console.log(`[AssemblyAI] Requesting transcription for: ${audioUrl}`);
  const response = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ audio_url: audioUrl, language_code: "ru" }), // Added language_code hint
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Could not read error body');
    console.error('[AssemblyAI] Transcription request failed:', response.status, errorBody);
    throw new Error(`AssemblyAI transcription request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  console.log('[AssemblyAI] Transcription requested, ID:', data.id);
  return data.id;
}

async function pollTranscriptionResultAssemblyAI(transcriptId, apiKey, maxRetries = 30, pollIntervalMs = 3000) { // Increased maxRetries
  console.log(`[AssemblyAI] Polling for transcription ID: ${transcriptId}`);
  const pollingEndpoint = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;
  const headers = { 'authorization': apiKey };

  for (let i = 0; i < maxRetries; i++) {
    const pollResponse = await fetch(pollingEndpoint, { headers });
    if (!pollResponse.ok) {
        const errorText = await pollResponse.text().catch(() => 'Could not read error body');
        console.error('[AssemblyAI] Polling failed:', pollResponse.status, errorText);
        throw new Error(`AssemblyAI polling failed: ${pollResponse.status} ${pollResponse.statusText}. Body: ${errorText}`);
    }
    const pollData = await pollResponse.json();

    console.log(`[AssemblyAI] Poll status for ${transcriptId}: ${pollData.status}`);
    if (pollData.status === 'completed') {
      console.log(`[AssemblyAI] Transcription completed for ${transcriptId}`);
      return pollData.text;
    } else if (pollData.status === 'error') {
      console.error(`[AssemblyAI] Transcription failed for ${transcriptId}: ${pollData.error}`);
      throw new Error(`AssemblyAI transcription failed: ${pollData.error}`);
    } else if (pollData.status === 'queued' || pollData.status === 'processing') {
      if (i === maxRetries - 1) {
        console.warn(`[AssemblyAI] Transcription timed out for ${transcriptId}`);
        throw new Error(`AssemblyAI transcription timed out after ${maxRetries * pollIntervalMs / 1000} seconds.`);
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } else {
      console.error(`[AssemblyAI] Unknown status for ${transcriptId}: ${pollData.status}`);
      throw new Error(`Unknown AssemblyAI transcription status: ${pollData.status}`);
    }
  }
  throw new Error('AssemblyAI transcription polling exceeded max retries.');
}
// --- END OF ASSEMBLYAI HELPER FUNCTIONS ---


// --- REFACTORED QUERY PROCESSING FUNCTION ---
async function processUserQuery(ctx, userQuery, originalMessageId) {
  let statusMessage;
  try {
    statusMessage = await ctx.reply(`*Ваш запрос:* \`${userQuery.substring(0,100)}${userQuery.length > 100 ? '...' : ''}\`\n\n*Обработка\.\.\.\*`, {
      parse_mode: 'Markdown',
      // reply_parameters: { message_id: originalMessageId } // Status message doesn't have to be a reply
    });

    const rmid = await sendSearchRequest(userQuery);
    const response = await getResponse(rmid);

    let markdownText = (response.TargetMarkdownText || response.responseText)
      .replace(/```(\d+)```/g, '[$1]'); // Ensure this replacement is what you intend for links

    const htmlResponse = markdownToHTML(markdownText); // linksData is still not passed
    const cleanHTML = cleanHTMLForTelegram(htmlResponse);

    await ctx.reply(cleanHTML, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: originalMessageId },
      disable_web_page_preview: true
    });

  } catch (error) {
    console.error(`Ошибка обработки запроса "${userQuery.substring(0,50)}...":`, error);
    await ctx.reply('⚠️ Произошла ошибка при обработке вашего запроса. Попробуйте еще раз позже.', {
        reply_parameters: { message_id: originalMessageId }
    });
  } finally {
    if (statusMessage) {
      try {
        await ctx.api.deleteMessage(statusMessage.chat.id, statusMessage.message_id);
      } catch (delError) {
        // console.warn("Could not delete status message:", delError.message);
      }
    }
  }
}
// --- END OF REFACTORED QUERY PROCESSING FUNCTION ---


bot.on('message:text', async (ctx) => {
  try {
    const userQuery = ctx.message.text;

    if (userQuery.toLowerCase() === '/start') {
        console.log("Received /start command, handled by bot.command.");
        return; // Already handled by bot.command
    }
    await processUserQuery(ctx, userQuery, ctx.message.message_id);

  } catch (error) { // This outer catch might be redundant if processUserQuery handles all its errors
    console.error('Общая ошибка в обработчике текстового сообщения:', error);
    await ctx.reply('⚠️ Произошла непредвиденная ошибка.', {
        reply_parameters: { message_id: ctx.msg.message_id }
    });
  }
});

// --- NEW VOICE MESSAGE HANDLER ---
bot.on('message:voice', async (ctx) => {
  if (!ASSEMBLYAI_API_KEY) {
    await ctx.reply('Обработка голосовых сообщений временно недоступна.', {
      reply_parameters: { message_id: ctx.msg.message_id }
    });
    return;
  }

  const voice = ctx.message.voice;
  const originalMessageId = ctx.message.message_id;
  let tempFilePath = '';
  let recognitionStatusMessage;

  try {
    recognitionStatusMessage = await ctx.reply('🎙️ Распознаю ваше голосовое сообщение...', {
      reply_parameters: { message_id: originalMessageId }
    });

    const file = await ctx.api.getFile(voice.file_id);
    const telegramFilePath = file.file_path;
    if (!telegramFilePath) {
      throw new Error('Не удалось получить путь к файлу для голосового сообщения от Telegram.');
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${telegramFilePath}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok || !fileResponse.body) {
      throw new Error(`Не удалось загрузить голосовое сообщение с Telegram: ${fileResponse.statusText}`);
    }

    // Determine file extension (Telegram often uses .oga for voice)
    const fileExtension = path.extname(telegramFilePath) || '.oga';
    tempFilePath = path.join(TEMP_AUDIO_DIR, `${voice.file_unique_id}_${Date.now()}${fileExtension}`);

    const dest = fs.createWriteStream(tempFilePath);
    // Use pipeline for better error handling with streams if available (Node 15+)
    // For broader compatibility, using .on('finish') and .on('error')
    await new Promise((resolve, reject) => {
      fileResponse.body.pipe(dest);
      fileResponse.body.on('error', reject);
      dest.on('finish', resolve);
      dest.on('error', reject);
    });
    console.log(`Voice message saved temporarily to: ${tempFilePath}`);

    const assemblyAiAudioUrl = await uploadFileToAssemblyAI(tempFilePath, ASSEMBLYAI_API_KEY);
    const transcriptId = await requestTranscriptionAssemblyAI(assemblyAiAudioUrl, ASSEMBLYAI_API_KEY);
    const transcribedText = await pollTranscriptionResultAssemblyAI(transcriptId, ASSEMBLYAI_API_KEY);

    if (recognitionStatusMessage) {
        await ctx.api.editMessageText(
            recognitionStatusMessage.chat.id,
            recognitionStatusMessage.message_id,
            `✅ Голосовое сообщение распознано.`
        );
        // Optionally delete this message after a short delay or let processUserQuery handle all UX
        setTimeout(() => ctx.api.deleteMessage(recognitionStatusMessage.chat.id, recognitionStatusMessage.message_id).catch(console.warn), 2000);

    }


    if (!transcribedText || transcribedText.trim() === '') {
      await ctx.reply('Не удалось распознать текст в голосовом сообщении или оно было пустым.', {
        reply_parameters: { message_id: originalMessageId }
      });
      return;
    }

    console.log(`Transcribed text: "${transcribedText}"`);
    await processUserQuery(ctx, transcribedText, originalMessageId);

  } catch (error) {
    console.error('Ошибка обработки голосового сообщения:', error);
    if (recognitionStatusMessage) {
        try {
            await ctx.api.editMessageText(
                recognitionStatusMessage.chat.id,
                recognitionStatusMessage.message_id,
                '⚠️ Ошибка при распознавании голосового сообщения.'
            );
        } catch (editError) {
            // If editing fails, send a new message
            await ctx.reply('⚠️ Ошибка при распознавании голосового сообщения.', {
                reply_parameters: { message_id: originalMessageId }
            });
        }
    } else {
        await ctx.reply('⚠️ Ошибка при обработке вашего голосового сообщения.', {
            reply_parameters: { message_id: originalMessageId }
        });
    }
  } finally {
    if (tempFilePath) {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.error(`Ошибка при удалении временного файла ${tempFilePath}:`, err);
        else console.log(`Временный файл ${tempFilePath} удален.`);
      });
    }
  }
});
// --- END OF NEW VOICE MESSAGE HANDLER ---


// --- START OF MODIFIED STARTUP LOGIC ---
// Check if running in an environment that provides an external URL (like Render)
if (process.env.RENDER_EXTERNAL_URL) {
  const app = express();
  const PORT = process.env.PORT || 10000;

  app.get('/nosleep', (req, res) => {
    console.log('[HealthCheck] GET /nosleep ping received');
    res.status(200).send('Awake and ready! Thanks for the ping.');
  });

  const secretPathComponent = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest('hex').slice(0, 32);
  const secretPath = `/telegraf/${secretPathComponent}`;

  app.use(express.json()); // Middleware to parse JSON bodies

  // Webhook handler route
  app.use(secretPath, async (req, res) => {
    try {
      if (!req.body) {
        console.error('Получен пустой запрос webhook');
        return res.status(400).send('Bad Request: No request body');
      }
      if (!req.body.update_id) {
        console.error('Получен webhook без update_id:', req.body);
        return res.status(400).send('Bad Request: Missing update_id');
      }
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } catch (error) {
      console.error('Ошибка обработки webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  // Async IIFE to initialize bot and start server
  (async () => {
    try {
      console.log('Initializing bot...');
      await bot.init();
      console.log(`Bot initialized: ${bot.botInfo.username} (ID: ${bot.botInfo.id})`);

      app.listen(PORT, async () => {
        console.log(`🚀 Express server started on port ${PORT}.`);
        try {
          const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${secretPath}`;
          await bot.api.setWebhook(webhookUrl, {
            drop_pending_updates: true,
          });
          console.log(`✅ Webhook successfully set to ${webhookUrl}`);
          console.log('🤖 Бот запущен в режиме вебхука на Render!');

          const PING_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
          const selfPingUrl = `${process.env.RENDER_EXTERNAL_URL}/nosleep`;

          const performSelfPing = async () => {
            try {
              console.log(`[Self-Ping] Pinging ${selfPingUrl} to stay awake...`);
              const response = await fetch(selfPingUrl); // Global fetch
              if (response.ok) {
                const responseText = await response.text();
                console.log(`[Self-Ping] Ping successful: ${response.status} - "${responseText.substring(0, 50)}..."`);
              } else {
                const errorText = await response.text().catch(() => 'Could not read error body');
                console.warn(`[Self-Ping] Ping failed: ${response.status} ${response.statusText}. Body: ${errorText.substring(0, 100)}...`);
              }
            } catch (error) {
              console.error('[Self-Ping] Error during fetch:', error.message);
            }
          };

          setTimeout(performSelfPing, 5000); // Initial ping
          setInterval(performSelfPing, PING_INTERVAL_MS);

        } catch (e) {
          console.error('❌ Critical error during webhook setup or server start:', e);
          process.exit(1);
        }
      });
    } catch (initError) {
      console.error('❌ Failed to initialize bot:', initError);
      process.exit(1);
    }
  })();

} else {
  // Fallback to polling
  console.warn('⚠️ RENDER_EXTERNAL_URL not found. Starting in polling mode.');
  (async () => {
    try {
      await bot.init();
      console.log(`Bot initialized: ${bot.botInfo.username} (ID: ${bot.botInfo.id})`);
      await bot.start({
          drop_pending_updates: true, // Good practice for polling too
          onStart: (botInfo) => console.log(`🤖 Бот @${botInfo.username} запущен в режиме опроса (polling)!`)
      });
    } catch (err) {
      console.error('❌ Failed to start bot in polling mode:', err);
      process.exit(1);
    }
  })();
}
// --- END OF MODIFIED STARTUP LOGIC ---

// Graceful shutdown
process.once('SIGINT', () => bot.stop().then(() => console.log('Bot stopped by SIGINT')));
process.once('SIGTERM', () => bot.stop().then(() => console.log('Bot stopped by SIGTERM')));