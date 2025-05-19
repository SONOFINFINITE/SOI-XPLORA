const { Bot } = require('grammy');
const { sendSearchRequest, getResponse } = require('./neuroSearch');
const marked = require('marked');
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs').promises; // For async file operations
const path = require('path');
const { Readable } = require('stream'); // To convert Web Stream to Node.js Stream
const { pipeline } = require('stream/promises'); // For robust stream piping

// For Node.js versions < 18, you might need 'node-fetch'.
// If so, uncomment the next line and run: npm install node-fetch@2
// const fetch = require('node-fetch');
// For Node.js 18+, global 'fetch' is available. We'll assume Node 18+ or Render's environment provides it.


if (!process.env.BOT_TOKEN) {
  console.error('⛔ BOT_TOKEN not found in environment variables!');
  process.exit(1);
}

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
  }
}

marked.setOptions({
  renderer: new marked.Renderer(),
  highlight: null,
  pedantic: false,
  gfm: true,
  breaks: true,
  sanitize: false,
  smartypants: false,
  xhtml: false
});

const bot = new Bot(process.env.BOT_TOKEN);

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

function markdownToHTML(markdown, linksData = []) {
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
    const unescapedMarkdown = markdown.replace(/\\([_*\[\]()~`>#+=|{}.!-])/g, '$1');
    return marked.parse(unescapedMarkdown);
  } catch (error) {
    console.error('Ошибка при конвертации Markdown в HTML:', error, {markdown});
    return markdown || '';
  }
}

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

async function uploadFileToAssemblyAI(audioFilePath, apiKey) {
  console.log(`[AssemblyAI] Uploading file: ${audioFilePath}`);
  const audioData = await fsPromises.readFile(audioFilePath); // Read file to buffer

  const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      // 'Content-Type' will typically be inferred by fetch for a Buffer,
      // or AssemblyAI is flexible. If issues, set 'Content-Type': 'application/octet-stream'
    },
    body: audioData, // Send buffer
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
    body: JSON.stringify({
        audio_url: audioUrl,
        language_code: "ru",
        speech_model: "universal" // Added universal speech model
    }),
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

async function pollTranscriptionResultAssemblyAI(transcriptId, apiKey, maxRetries = 30, pollIntervalMs = 3000) {
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

async function processUserQuery(ctx, userQuery, originalMessageId) {
  let statusMessage;
  try {
    statusMessage = await ctx.reply(`*Ваш запрос:* \`${userQuery.substring(0,100)}${userQuery.length > 100 ? '...' : ''}\`\n\n*Обработка\.\.\.\*`, {
      parse_mode: 'Markdown',
    });

    const rmid = await sendSearchRequest(userQuery);
    const response = await getResponse(rmid);

    let markdownText = (response.TargetMarkdownText || response.responseText)
      .replace(/```(\d+)```/g, '[$1]');

    const htmlResponse = markdownToHTML(markdownText);
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

bot.on('message:text', async (ctx) => {
  try {
    const userQuery = ctx.message.text;
    if (userQuery.toLowerCase() === '/start') {
        console.log("Received /start command, handled by bot.command.");
        return;
    }
    
    // Проверяем, является ли сообщение ответом на сообщение бота
    let queryWithContext = userQuery;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.from?.id === bot.botInfo.id) {
      try {
        // Извлекаем текст предыдущего сообщения бота
        const botResponseText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
        if (botResponseText) {
          console.log(`Пользователь ответил на сообщение бота. Добавляем контекст.`);
          // Объединяем предыдущий ответ бота с новым запросом пользователя
          queryWithContext = `Мой предыдущий ответ: "${botResponseText}". Уточняющий вопрос пользователя: "${userQuery}"`;
        }
      } catch (contextError) {
        console.error('Ошибка при обработке контекста сообщения:', contextError);
        // Если произошла ошибка при получении контекста, используем только запрос пользователя
      }
    }
    
    await processUserQuery(ctx, queryWithContext, ctx.message.message_id);
  } catch (error) {
    console.error('Общая ошибка в обработчике текстового сообщения:', error);
    await ctx.reply('⚠️ Произошла непредвиденная ошибка.', {
        reply_parameters: { message_id: ctx.msg.message_id }
    });
  }
});

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

    const fileInfo = await ctx.api.getFile(voice.file_id);
    const telegramFilePath = fileInfo.file_path;
    if (!telegramFilePath) {
      throw new Error('Не удалось получить путь к файлу для голосового сообщения от Telegram.');
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${telegramFilePath}`;
    const fileResponse = await fetch(fileUrl);

    if (!fileResponse.ok || !fileResponse.body) {
      throw new Error(`Не удалось загрузить голосовое сообщение с Telegram: ${fileResponse.statusText}`);
    }

    const fileExtension = path.extname(telegramFilePath) || '.oga'; // .oga is common for Telegram voice
    tempFilePath = path.join(TEMP_AUDIO_DIR, `${voice.file_unique_id}_${Date.now()}${fileExtension}`);

    const dest = fs.createWriteStream(tempFilePath);
    const nodeReadableStream = Readable.fromWeb(fileResponse.body); // Convert Web Stream

    await pipeline(nodeReadableStream, dest); // Pipe to file using stream.pipeline

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
        setTimeout(() => ctx.api.deleteMessage(recognitionStatusMessage.chat.id, recognitionStatusMessage.message_id).catch(console.warn), 2000);
    }

    if (!transcribedText || transcribedText.trim() === '') {
      await ctx.reply('Не удалось распознать текст в голосовом сообщении или оно было пустым.', {
        reply_parameters: { message_id: originalMessageId }
      });
      return;
    }

    console.log(`Transcribed text: "${transcribedText}"`);
    
    // Проверяем, является ли голосовое сообщение ответом на сообщение бота
    let queryWithContext = transcribedText;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.from?.id === bot.botInfo.id) {
      try {
        // Извлекаем текст предыдущего сообщения бота
        const botResponseText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
        if (botResponseText) {
          console.log(`Голосовой ответ на сообщение бота. Добавляем контекст.`);
          // Объединяем предыдущий ответ бота с новым запросом пользователя
          queryWithContext = `Мой предыдущий ответ: "${botResponseText}". Уточняющий вопрос пользователя: "${transcribedText}"`;
        }
      } catch (contextError) {
        console.error('Ошибка при обработке контекста голосового сообщения:', contextError);
      }
    }
    
    await processUserQuery(ctx, queryWithContext, originalMessageId);

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
    if (tempFilePath && fs.existsSync(tempFilePath)) { // Check existence before unlinking
      try {
        await fsPromises.unlink(tempFilePath); // Use async unlink
        console.log(`Временный файл ${tempFilePath} удален.`);
      } catch (unlinkErr) {
        console.error(`Ошибка при удалении временного файла ${tempFilePath}:`, unlinkErr);
      }
    }
  }
});

if (process.env.RENDER_EXTERNAL_URL) {
  const app = express();
  const PORT = process.env.PORT || 10000;

  app.get('/nosleep', (req, res) => {
    console.log('[HealthCheck] GET /nosleep ping received');
    res.status(200).send('Awake and ready! Thanks for the ping.');
  });

  const secretPathComponent = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest('hex').slice(0, 32);
  const secretPath = `/telegraf/${secretPathComponent}`;

  app.use(express.json());

  app.use(secretPath, async (req, res) => {
    try {
      if (!req.body || !req.body.update_id) {
        console.error('Получен невалидный webhook запрос:', req.body);
        return res.status(400).send('Bad Request');
      }
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } catch (error) {
      console.error('Ошибка обработки webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  });

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

          const PING_INTERVAL_MS = 2 * 60 * 1000;
          const selfPingUrl = `${process.env.RENDER_EXTERNAL_URL}/nosleep`;

          const performSelfPing = async () => {
            try {
              console.log(`[Self-Ping] Pinging ${selfPingUrl} to stay awake...`);
              const response = await fetch(selfPingUrl);
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
          setTimeout(performSelfPing, 5000);
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
  console.warn('⚠️ RENDER_EXTERNAL_URL not found. Starting in polling mode.');
  (async () => {
    try {
      await bot.init();
      console.log(`Bot initialized: ${bot.botInfo.username} (ID: ${bot.botInfo.id})`);
      await bot.start({
          drop_pending_updates: true,
          onStart: (botInfo) => console.log(`🤖 Бот @${botInfo.username} запущен в режиме опроса (polling)!`)
      });
    } catch (err) {
      console.error('❌ Failed to start bot in polling mode:', err);
      process.exit(1);
    }
  })();
}

process.once('SIGINT', () => bot.stop().then(() => console.log('Bot stopped by SIGINT')));
process.once('SIGTERM', () => bot.stop().then(() => console.log('Bot stopped by SIGTERM')));

