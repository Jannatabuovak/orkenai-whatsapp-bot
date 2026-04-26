const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return verifyWebhook(req, res);
  }

  if (req.method === "POST") {
    return handleIncomingWebhook(req, res);
  }

  return res.status(405).send("Method Not Allowed");
}

function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.warn("Webhook verification failed");
  return res.status(403).send("Forbidden");
}

async function handleIncomingWebhook(req, res) {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // Если это статус доставки, а не сообщение клиента — просто подтверждаем получение
    if (value?.statuses) {
      console.log("Received message status update");
      return res.status(200).send("EVENT_RECEIVED");
    }

    const message = value?.messages?.[0];

    if (!message) {
      console.log("No incoming message found");
      return res.status(200).send("EVENT_RECEIVED");
    }

    const from = message.from;

    // Обрабатываем только текстовые сообщения
    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        "Спасибо за сообщение. Сейчас я лучше понимаю текстовые запросы. Напишите, пожалуйста, что вас интересует: сайт, WhatsApp-бот или автоматизация?"
      );

      return res.status(200).send("EVENT_RECEIVED");
    }

    const userText = message.text?.body?.trim();

    if (!userText) {
      return res.status(200).send("EVENT_RECEIVED");
    }

    console.log("Incoming WhatsApp message:", {
      from,
      text: userText
    });

    const aiReply = await askClaude(userText);

    await sendWhatsAppMessage(from, aiReply);

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook error:", error);

    // Meta должна получить 200, иначе будет повторять webhook-запросы
    return res.status(200).send("EVENT_RECEIVED");
  }
}

async function askClaude(userText) {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing");
    return fallbackReply();
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 500,
        temperature: 0.4,
        system: getSystemPrompt(),
        messages: [
          {
            role: "user",
            content: userText
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", data);
      return fallbackReply();
    }

    const reply = data.content?.[0]?.text?.trim();

    if (!reply) {
      return fallbackReply();
    }

    return limitWhatsAppText(reply);
  } catch (error) {
    console.error("Claude request failed:", error);
    return fallbackReply();
  }
}

function getSystemPrompt() {
  return `
Ты AI-менеджер цифрового агентства OrkenAI.kz.

OrkenAI помогает бизнесу в Казахстане создавать:
- сайты и лендинги;
- WhatsApp-ботов;
- Telegram-ботов;
- AI-ассистентов;
- автоматизацию заявок;
- интеграции с Google Sheets, Telegram, CRM, сайтами и формами;
- цифровые системы для продаж, клиентского сервиса и внутренних процессов.

Твоя роль:
Ты не просто бот, а вежливый менеджер OrkenAI, который помогает клиенту понять, какое решение ему подойдёт.

Стиль общения:
- отвечай на русском языке, если клиент пишет по-русски;
- отвечай на казахском языке, если клиент пишет по-казахски;
- пиши кратко, тепло и профессионально;
- не используй сложные технические термины без необходимости;
- не говори, что ты языковая модель;
- не обещай невозможного;
- не придумывай факты о клиенте;
- не делай слишком длинные ответы;
- веди клиента к заявке.

Главная задача:
Понять, что нужно клиенту, и мягко собрать данные:
1. сфера бизнеса;
2. что хочет автоматизировать или создать;
3. есть ли сайт/Instagram/WhatsApp;
4. какие услуги или товары продаёт;
5. нужен ли сайт, бот, AI-помощник или комплексное решение;
6. когда нужно запустить;
7. как можно связаться с клиентом.

Цены-ориентиры:
- лендинг — от 150 000 ₸;
- сайт с WhatsApp-заявками — от 250 000 ₸;
- WhatsApp-бот — от 200 000 ₸;
- AI-бот с GPT/Claude — от 350 000 ₸;
- автоматизация процесса — рассчитывается индивидуально.

Если клиент спрашивает цену:
Назови ориентир и объясни, что точная стоимость зависит от задачи, количества страниц, сценариев бота, интеграций и уровня автоматизации.

Если клиент спрашивает “что вы делаете?”:
Объясни, что OrkenAI создаёт не просто сайты, а цифровые системы: сайт + WhatsApp + AI-бот + заявки + автоматизация.

Если клиент пишет непонятно:
Задай уточняющий вопрос и предложи выбрать:
1 — сайт
2 — WhatsApp-бот
3 — AI-ассистент
4 — автоматизация
5 — узнать стоимость

Если клиент готов заказать:
Попроси коротко написать:
- сфера бизнеса;
- что нужно сделать;
- город;
- желаемый срок;
- имя для связи.

Не отправляй Markdown-таблицы.
Не используй слишком много эмодзи.
Максимум 1 эмодзи в сообщении.
`;
}

async function sendWhatsAppMessage(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("WhatsApp credentials are missing");
    return;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: {
            preview_url: false,
            body
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("WhatsApp API error:", data);
      return;
    }

    console.log("WhatsApp message sent:", data);
  } catch (error) {
    console.error("Failed to send WhatsApp message:", error);
  }
}

function fallbackReply() {
  return `Спасибо за сообщение.

Сейчас AI-помощник временно недоступен, но я всё равно помогу сориентироваться.

Напишите, пожалуйста, что вас интересует:

1 — сайт
2 — WhatsApp-бот
3 — AI-ассистент
4 — автоматизация
5 — узнать стоимость`;
}

function limitWhatsAppText(text) {
  const maxLength = 3500;

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 50) + "\n\nПродолжу после вашего ответа.";
}
