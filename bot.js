const { Bot, webhookCallback } = require('grammy');
const { sendSearchRequest, getResponse } = require('./neuroSearch');
const marked = require('marked');
// const { escape } = require('grammy'); // 'escape' is imported but not used.
const dotenv = require('dotenv');
dotenv.config();

// --- START OF NEW IMPORTS ---
const express = require('express');
const crypto = require('crypto'); // For generating a more secure secret path
// For Node.js versions < 18, you might need 'node-fetch'.
// If so, uncomment the next line and run: npm install node-fetch@2
// const fetch = require('node-fetch');
// For Node.js 18+, global 'fetch' is available. We'll assume Node 18+ or Render's environment provides it.
// --- END OF NEW IMPORTS ---

if (!process.env.BOT_TOKEN) {
  console.error('⛔ BOT_TOKEN not found in environment variables!');
  process.exit(1);
}

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

bot.on('message:text', async (ctx) => {
  try {
    const userQuery = ctx.message.text;

    if (userQuery.toLowerCase() === '/start') {
        console.log("Received /start command, handled by bot.command.");
        return;
    }

    const statusMessage = await ctx.reply(`*Ваш запрос:* \`${userQuery}\`\n\n*Обработка\.\.\.\*`, {
      parse_mode: 'Markdown'
    });

    const rmid = await sendSearchRequest(userQuery);
    const response = await getResponse(rmid);

    let markdownText = (response.TargetMarkdownText || response.responseText)
      .replace(/```(\d+)```/g, '[$1]');

    const htmlResponse = markdownToHTML(markdownText);
    const cleanHTML = cleanHTMLForTelegram(htmlResponse);

    await ctx.reply(`${cleanHTML}`, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.msg.message_id },
      disable_web_page_preview: true
    });

    // Optionally delete status message after successful reply
    // await ctx.api.deleteMessage(statusMessage.chat.id, statusMessage.message_id);

  } catch (error) {
    console.error('Ошибка обработки сообщения:', error);
    await ctx.reply('⚠️ Произошла ошибка при обработке запроса', {
        reply_parameters: { message_id: ctx.msg.message_id }
    });
  }
});

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
      // console.log('Получен webhook запрос:', JSON.stringify(req.body, null, 2)); // Already logged by grammY or can be too verbose
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
      await bot.init(); // Initialize the bot (fetches botInfo)
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
      // No need to call bot.init() separately for bot.start(), it handles it.
      // However, if you want to access bot.botInfo before bot.start() promise resolves,
      // you could call await bot.init(); here too.
      // For consistency and accessing botInfo early:
      await bot.init();
      console.log(`Bot initialized: ${bot.botInfo.username} (ID: ${bot.botInfo.id})`);
      await bot.start(); // bot.start() will also call getMe if not already initialized.
      console.log('🤖 Бот запущен в режиме опроса (polling)!');
    } catch (err) {
      console.error('❌ Failed to start bot in polling mode:', err);
      process.exit(1);
    }
  })();
}
