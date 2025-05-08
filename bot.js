const { Bot, webhookCallback } = require('grammy');
const { sendSearchRequest, getResponse } = require('./neuroSearch');
const marked = require('marked');
const { escape } = require('grammy'); // 'escape' is imported but not used in the provided snippet.
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

    // Команда /start обрабатывается отдельно, поэтому здесь можно ее пропустить,
    // хотя grammY обычно обрабатывает bot.command() до bot.on()
    if (userQuery.toLowerCase() === '/start') {
        // Уже обработано командой bot.command('start', ...)
        // Можно добавить логирование или просто ничего не делать
        console.log("Received /start command, already handled.");
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

    // Optionally, you might want to edit or delete the statusMessage here, e.g.:
    // await ctx.api.deleteMessage(statusMessage.chat.id, statusMessage.message_id);
    // await ctx.api.editMessageText(statusMessage.chat.id, statusMessage.message_id, "✅ Готово!");


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
  // Render provides the PORT environment variable. Default to 10000 if not set.
  const PORT = process.env.PORT || 10000;

  // Endpoint for Render's health checks or to keep the service alive
  app.get('/nosleep', (req, res) => {
    console.log('[HealthCheck] GET /nosleep ping received');
    res.status(200).send('Awake and ready! Thanks for the ping.');
  });

  // Generate a secret path for the webhook to prevent unauthorized access.
  // Using a hash of the bot token is a common practice.
  const secretPathComponent = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest('hex').slice(0, 32);
  const secretPath = `/telegraf/${secretPathComponent}`; // Example: /telegraf/a1b2c3d4...

  // Route for Telegram to send updates to
  app.use(secretPath, webhookCallback(bot, 'express'));

  // Start the server and set up webhook
  app.listen(PORT, async () => {
    console.log(`🚀 Express server started on port ${PORT}.`);
    try {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}${secretPath}`;
      await bot.api.setWebhook(webhookUrl, {
        drop_pending_updates: true, // Recommended to drop pending updates during restarts/deployments.
        // allowed_updates: ['message'] // Optional: Be specific about which updates your bot handles.
      });
      console.log(`✅ Webhook successfully set to ${webhookUrl}`);
      console.log('🤖 Бот запущен в режиме вебхука на Render!');

      // Self-ping mechanism to prevent the service from sleeping on Render's free tier
      const PING_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
      const selfPingUrl = `${process.env.RENDER_EXTERNAL_URL}/nosleep`; // Ping the /nosleep endpoint

      const performSelfPing = async () => {
        try {
          console.log(`[Self-Ping] Pinging ${selfPingUrl} to stay awake...`);
          const response = await fetch(selfPingUrl);
          if (response.ok) {
            const responseText = await response.text();
            console.log(`[Self-Ping] Ping successful: ${response.status} - "${responseText.substring(0, 100)}"`); // Log part of response
          } else {
            const errorText = await response.text().catch(() => 'Could not read error body');
            console.warn(`[Self-Ping] Ping failed: ${response.status} ${response.statusText}. Body: ${errorText.substring(0, 200)}`);
          }
        } catch (error) {
          console.error('[Self-Ping] Error during fetch:', error.message);
        }
      };

      // Perform an initial ping shortly after startup, then set interval
      setTimeout(performSelfPing, 5000); // Initial ping after 5 seconds
      setInterval(performSelfPing, PING_INTERVAL_MS);

    } catch (e) {
      console.error('❌ Critical error during webhook setup or server start:', e);
      process.exit(1); // Exit if webhook setup fails in production
    }
  });

} else {
  // Fallback to polling for local development or other environments
  console.warn('⚠️ RENDER_EXTERNAL_URL not found in environment variables.');
  console.warn('   Starting bot in polling mode for local development.');
  console.warn('   Web service features (webhook, /nosleep, self-ping) are designed for Render and will not be active.');
  console.warn('   If deploying to Render, ensure RENDER_EXTERNAL_URL is automatically set by the platform for your Web Service.');

  bot.start()
    .then(() => {
      console.log('🤖 Бот запущен в режиме опроса (polling)!');
    })
    .catch((err) => {
      console.error('❌ Failed to start bot in polling mode:', err);
      process.exit(1);
    });
}
// --- END OF MODIFIED STARTUP LOGIC ---
// Original `bot.start();` and `console.log('Бот запущен!');` are removed as startup is now handled above.
