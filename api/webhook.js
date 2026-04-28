// ============================================================
// WhatsApp AI Agent — Railway Freight Export
// Компания: ж/д грузоперевозки, экспорт из Казахстана
// Vercel API Route: /api/webhook.js
// ИИ: Claude → Gemini → fallback
// ============================================================

const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ============================================================
// Память диалогов
// Важно: на Vercel память может сбрасываться при рестарте.
// Для продакшена лучше Redis / Vercel KV / база данных.
// ============================================================

const conversationStore = new Map();
const processedMessages = new Set();

const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 10;

// ============================================================
// Webhook entry point
// ============================================================

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const mode      = req.query["hub.mode"];
      const token     = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified");
        return res.status(200).send(challenge);
      }

      return res.status(403).send("Forbidden");
    }

    if (req.method === "POST") {
      await handleIncomingWebhook(req);
      return res.status(200).send("EVENT_RECEIVED");
    }

    return res.status(405).send("Method Not Allowed");

  } catch (error) {
    console.error("Webhook handler error:", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}

// ============================================================
// Основная обработка входящего сообщения
// ============================================================

async function handleIncomingWebhook(req) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) {
      console.log("No value in webhook body");
      return;
    }

    // Игнорируем статусы доставки
    if (value.statuses) {
      console.log("Status event ignored");
      return;
    }

    const messages = value.messages;
    if (!messages || messages.length === 0) {
      console.log("No messages in webhook body");
      return;
    }

    const message = messages[0];
    const messageId = message.id;
    const from = message.from;

    if (!from) {
      console.log("No sender phone");
      return;
    }

    // Защита от повторной обработки одного и того же сообщения
    if (messageId && processedMessages.has(messageId)) {
      console.log(`Duplicate message ignored: ${messageId}`);
      return;
    }

    if (messageId) {
      processedMessages.add(messageId);

      // Чтобы Set не рос бесконечно
      if (processedMessages.size > 500) {
        const first = processedMessages.values().next().value;
        processedMessages.delete(first);
      }
    }

    // Пока обрабатываем только текст
    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        getUnsupportedTypeReply(getSessionLang(from))
      );
      return;
    }

    const userText = message.text?.body?.trim();
    if (!userText) {
      console.log("Empty text message");
      return;
    }

    console.log(`[IN] from=${from} text="${userText}"`);

    const session = getOrCreateSession(from);

    // Определяем язык
    if (session.messages.length === 0) {
      session.lang = detectLanguage(userText);
    }

    appendToHistory(from, "user", userText);

    // Если клиент просит живого менеджера
    if (wantsHumanAgent(userText)) {
      const reply = getHandoffReply(session.lang);
      appendToHistory(from, "assistant", reply);
      markLeadHot(from);
      await notifyCRM(from, session);
      await sendWhatsAppMessage(from, reply);
      return;
    }

    const aiReply = await askAI(session);

    appendToHistory(from, "assistant", aiReply);
    updateLeadScore(from, userText, aiReply);

    if (session.leadScore >= 3 && !session.crmNotified) {
      session.crmNotified = true;
      await notifyCRM(from, session);
    }

    await sendWhatsAppMessage(from, aiReply);

  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

// ============================================================
// ИИ: Claude → Gemini → fallback
// ============================================================

async function askAI(session) {
  const claudeReply = await askClaude(session);
  if (claudeReply) return claudeReply;

  console.warn("Claude unavailable. Trying Gemini...");

  const geminiReply = await askGemini(session);
  if (geminiReply) return geminiReply;

  console.warn("Both AI providers unavailable. Using fallback.");
  return fallbackReply(session.lang);
}

// ============================================================
// Claude
// ============================================================

async function askClaude(session) {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing");
    return null;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 700,
        temperature: 0.3,
        system: getSystemPrompt(session.lang),
        messages: buildClaudeMessages(session),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", JSON.stringify(data));
      return null;
    }

    const reply = data.content?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(cleanReply(reply)) : null;

  } catch (error) {
    console.error("Claude request failed:", error);
    return null;
  }
}

// ============================================================
// Gemini
// ============================================================

async function askGemini(session) {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing");
    return null;
  }

  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: getSystemPrompt(session.lang),
            },
          ],
        },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 700,
          responseMimeType: "text/plain",
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_ONLY_HIGH",
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_ONLY_HIGH",
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_ONLY_HIGH",
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_ONLY_HIGH",
          },
        ],
        contents: buildGeminiContents(session),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", JSON.stringify(data));
      return null;
    }

    const finishReason = data?.candidates?.[0]?.finishReason;

    if (finishReason === "SAFETY" || finishReason === "RECITATION") {
      console.warn("Gemini blocked response:", finishReason);
      return fallbackReply(session.lang);
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(cleanReply(reply)) : null;

  } catch (error) {
    console.error("Gemini request failed:", error);
    return null;
  }
}

// ============================================================
// Формат истории для Claude
// ============================================================

function buildClaudeMessages(session) {
  return session.messages
    .slice(-(MAX_HISTORY_TURNS * 2))
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
}

// ============================================================
// Формат истории для Gemini
// ============================================================

function buildGeminiContents(session) {
  return session.messages
    .slice(-(MAX_HISTORY_TURNS * 2))
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: m.content,
        },
      ],
    }));
}

// ============================================================
// Управление сессией
// ============================================================

function getOrCreateSession(phone) {
  const now = Date.now();
  let session = conversationStore.get(phone);

  if (!session || now - session.lastTs > HISTORY_TTL_MS) {
    session = {
      phone,
      messages: [],
      lang: "ru",
      leadScore: 0,
      crmNotified: false,
      lastTs: now,
    };

    conversationStore.set(phone, session);
  } else {
    session.lastTs = now;
  }

  return session;
}

function appendToHistory(phone, role, content) {
  const session = conversationStore.get(phone);
  if (!session) return;

  session.messages.push({
    role,
    content,
  });

  if (session.messages.length > MAX_HISTORY_TURNS * 2 + 2) {
    session.messages = [
      session.messages[0],
      ...session.messages.slice(-(MAX_HISTORY_TURNS * 2)),
    ];
  }
}

function getSessionLang(phone) {
  return conversationStore.get(phone)?.lang || "ru";
}

// ============================================================
// Определение языка
// ru / kz / uz / tj
// ============================================================

function detectLanguage(text) {
  const lower = text.toLowerCase();

  if (
    /[әіңғүұқөһ]/.test(lower) ||
    /\b(сәлем|рахмет|қайда|жүк|вагон|қанша|жіберу|баға|мерзім|керек)\b/.test(lower)
  ) {
    return "kz";
  }

  if (
    /[ʻʼ]/.test(text) ||
    /\b(salom|rahmat|qayerda|narx|yuk|vagon|jo'natish|xizmat|kerak)\b/.test(lower)
  ) {
    return "uz";
  }

  if (
    /[ӣғқҳҷ]/.test(lower) ||
    /\b(салом|рахмат|куҷо|нарх|бор|вагон|фиристодан|хизмат|лозим)\b/.test(lower)
  ) {
    return "tj";
  }

  return "ru";
}

// ============================================================
// Запрос живого менеджера
// ============================================================

function wantsHumanAgent(text) {
  const lower = text.toLowerCase();

  return /\b(менеджер|оператор|человек|живой|хочу позвонить|соедини|перезвони|мне нужен человек|не с ботом|не бот|свяжитесь|позвоните)\b/.test(lower);
}

// ============================================================
// Оценка лида
// ============================================================

function updateLeadScore(phone, userText, aiReply) {
  const session = conversationStore.get(phone);
  if (!session) return;

  const lower = userText.toLowerCase();

  if (/\b(цена|стоимость|сколько стоит|тариф|расчет|расчёт|посчитай)\b/.test(lower)) {
    session.leadScore++;
  }

  if (/\b(маршрут|откуда|куда|направление|станция)\b/.test(lower)) {
    session.leadScore++;
  }

  if (/\b(вагон|контейнер|хоппер|крытый|платформа|зерновоз)\b/.test(lower)) {
    session.leadScore++;
  }

  if (/\b(контракт|договор|заявка|оформить|отправить)\b/.test(lower)) {
    session.leadScore++;
  }

  if (/\b(срочно|срочная|быстро|сегодня|завтра|дата отправки)\b/.test(lower)) {
    session.leadScore++;
  }

  if (/\b(тонн|тонна|кг|кило|объем|объём|вес|кубов)\b/.test(lower)) {
    session.leadScore++;
  }

  console.log(`[LEAD] phone=${phone} score=${session.leadScore}`);
}

function markLeadHot(phone) {
  const session = conversationStore.get(phone);
  if (session) {
    session.leadScore = 10;
  }
}

// ============================================================
// CRM / уведомление менеджеру
// Можно подключить AMOCRM_WEBHOOK_URL или свой webhook
// ============================================================

async function notifyCRM(phone, session) {
  const summary = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" | ");

  console.log(
    `[CRM] HOT LEAD phone=${phone} lang=${session.lang} summary="${summary}"`
  );

  const CRM_WEBHOOK = process.env.CRM_WEBHOOK_URL;

  if (!CRM_WEBHOOK) {
    return;
  }

  try {
    await fetch(CRM_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone,
        lang: session.lang,
        leadScore: session.leadScore,
        messages: summary,
        createdAt: new Date().toISOString(),
      }),
    });

    console.log("[CRM] Lead sent to CRM webhook");

  } catch (error) {
    console.error("CRM webhook error:", error);
  }
}

// ============================================================
// Системный промпт
// ============================================================

function getSystemPrompt(lang = "ru") {
  const langInstruction =
    {
      ru: "Отвечай ТОЛЬКО на русском языке.",
      kz: "Жауапты ТЕК қазақ тілінде бер.",
      uz: "Faqat O'zbek tilida javob ber.",
      tj: "Танҳо ба забони тоҷикӣ ҷавоб деҳ.",
    }[lang] || "Отвечай ТОЛЬКО на русском языке.";

  return `
Ты AI-менеджер компании, которая оказывает услуги железнодорожных грузоперевозок.

ЯЗЫК: ${langInstruction}

Компания специализируется на:
- экспорте грузов из Казахстана в Узбекистан, Таджикистан, Афганистан;
- железнодорожных перевозках сельскохозяйственной продукции: пшеница, ячмень, кукуруза, рис, сахар, масло, льняное семя, хлопковое семя и другие грузы;
- подборе типа вагона: крытый вагон, хоппер/зерновоз, платформа;
- предварительном расчёте тарифов;
- оформлении контрактов и документов: СТ-1, фитосанитарный сертификат, ТН ВЭД, экспортная декларация, инвойс;
- отслеживании вагонов через системы КТЖ.

Твоя роль:
Ты вежливый, уверенный и профессиональный менеджер по железнодорожным перевозкам.
Твоя задача — понять потребность клиента, задать уточняющие вопросы и подготовить заявку для передачи менеджеру.

Стиль:
- отвечай кратко, понятно и по-деловому;
- не используй Markdown: никаких **, ##, таблиц;
- не называй себя ботом, AI или языковой моделью;
- не давай точных цен без маршрута, веса, типа груза и даты;
- не гарантируй наличие вагонов без проверки менеджером;
- если данных мало, задай 1–2 уточняющих вопроса;
- если клиент просит точный расчёт, договор или отправку груза — предложи передать заявку менеджеру;
- заканчивай ответ вопросом или мягким призывом к действию.

Данные, которые нужно собрать:
1. Какой груз нужно перевезти
2. Откуда: город или станция отправления в Казахстане
3. Куда: страна, город или станция назначения
4. Вес груза в тоннах
5. Тип вагона, если клиент знает
6. Желаемая дата отправки
7. Нужна ли помощь с документами
8. Имя клиента и компания
9. Контактный номер для менеджера

Маршруты и сроки справочно:
- Казахстан → Узбекистан: 3–5 суток
- Казахстан → Таджикистан: 5–8 суток
- Казахстан → Афганистан: 10–18 суток

Типы вагонов:
- Крытый вагон: 60–68 тонн, подходит для зерна в мешках, сахара, масла в упаковке
- Хоппер/зерновоз: 60–75 тонн, подходит для пшеницы, ячменя, кукурузы и других сыпучих грузов
- Платформа: подходит для паллет, оборудования и нестандартных грузов

Документы справочно:
- СТ-1 — сертификат происхождения, часто требуется для Узбекистана и Таджикистана
- Фитосанитарный сертификат — нужен для зерновых и масличных культур
- ТН ВЭД справочно: пшеница 1001, ячмень 1003, сахар 1701, масло подсолнечное 1512
- Экспортную декларацию оформляет таможенный брокер
- Инвойс и счёт-фактура готовятся по данным клиента

Передача менеджеру:
Когда клиент указал маршрут и груз или просит расчёт, напиши:
"Могу передать заявку менеджеру для точного расчёта. Напишите, пожалуйста, ваше имя, компанию и удобный номер для связи."

Рабочее время менеджера:
09:00–18:00, Алматы.
`.trim();
}

// ============================================================
// Отправка сообщения в WhatsApp
// ============================================================

async function sendWhatsAppMessage(to, body) {
  if (!WHATSAPP_TOKEN) {
    console.error("WHATSAPP_TOKEN is missing");
    return;
  }

  if (!PHONE_NUMBER_ID) {
    console.error("PHONE_NUMBER_ID is missing");
    return;
  }

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("WhatsApp send error:", JSON.stringify(data));
      return;
    }

    console.log(`[OUT] sent to=${to} len=${body.length}`);
    console.log("[OUT_META]", JSON.stringify(data));

  } catch (error) {
    console.error("sendWhatsAppMessage failed:", error);
  }
}

// ============================================================
// Ответы без AI
// ============================================================

function getUnsupportedTypeReply(lang = "ru") {
  const texts = {
    ru: "Спасибо за сообщение. Пока лучше всего обрабатываю текст. Напишите, пожалуйста, какой груз нужно перевезти и по какому маршруту?",
    kz: "Хабарыңыз үшін рахмет. Әзірге мәтіндік хабарларды жақсы өңдеймін. Қандай жүк және қай бағыт бойынша тасымалдау керек екенін жазыңыз.",
    uz: "Xabaringiz uchun rahmat. Hozircha matnli xabarlarni yaxshiroq tushunaman. Qanday yuk va qaysi yo'nalish bo'yicha tashish kerakligini yozing.",
    tj: "Ташаккур барои паём. Ҳоло матнро беҳтар коркард мекунам. Лутфан нависед, кадом бор ва аз куҷо ба куҷо интиқол дода шавад.",
  };

  return texts[lang] || texts.ru;
}

function getHandoffReply(lang = "ru") {
  const texts = {
    ru: "Понял, передаю вас менеджеру. Чтобы ускорить расчёт, напишите, пожалуйста, ваше имя, компанию и удобный номер для связи.",
    kz: "Түсіндім, сізді менеджерге бағыттаймын. Есептеуді жылдамдату үшін атыңызды, компанияңызды және байланыс нөміріңізді жазыңыз.",
    uz: "Tushundim, sizni menejerga yo'naltiraman. Hisob-kitobni tezlashtirish uchun ismingiz, kompaniyangiz va aloqa raqamingizni yozing.",
    tj: "Фаҳмидам, шуморо ба менеҷер равона мекунам. Барои тезтар ҳисоб кардан, ном, ширкат ва рақами тамосро нависед.",
  };

  return texts[lang] || texts.ru;
}

function fallbackReply(lang = "ru") {
  const texts = {
    ru:
      "Спасибо за сообщение. Сейчас я могу принять вашу заявку для менеджера.\n\n" +
      "Напишите, пожалуйста:\n" +
      "1. Какой груз нужно перевезти?\n" +
      "2. Откуда и куда?\n" +
      "3. Вес в тоннах?\n" +
      "4. Желаемая дата отправки?\n" +
      "5. Ваше имя и номер для связи?",

    kz:
      "Хабарыңыз үшін рахмет. Қазір өтінішіңізді менеджерге қабылдай аламын.\n\n" +
      "Жазыңыз, өтінемін:\n" +
      "1. Қандай жүк тасымалдау керек?\n" +
      "2. Қайдан және қайда?\n" +
      "3. Салмағы қанша тонна?\n" +
      "4. Жөнелту күні?\n" +
      "5. Атыңыз және байланыс нөміріңіз?",

    uz:
      "Xabaringiz uchun rahmat. Hozir arizangizni menejer uchun qabul qila olaman.\n\n" +
      "Iltimos, yozing:\n" +
      "1. Qanday yuk tashish kerak?\n" +
      "2. Qayerdan va qayerga?\n" +
      "3. Og'irligi necha tonna?\n" +
      "4. Jo'natish sanasi?\n" +
      "5. Ismingiz va aloqa raqamingiz?",

    tj:
      "Ташаккур барои паём. Ҳоло метавонам дархости шуморо барои менеҷер қабул кунам.\n\n" +
      "Лутфан нависед:\n" +
      "1. Кадом борро интиқол додан лозим?\n" +
      "2. Аз куҷо ва ба куҷо?\n" +
      "3. Вазн чанд тонна аст?\n" +
      "4. Санаи фиристодан?\n" +
      "5. Ном ва рақами тамос?",
  };

  return texts[lang] || texts.ru;
}

// ============================================================
// Очистка и ограничение ответа
// ============================================================

function cleanReply(text) {
  return text
    .replace(/\*\*/g, "")
    .replace(/#{1,6}\s/g, "")
    .replace(/\|/g, " ")
    .trim();
}

function limitWhatsAppText(text) {
  const MAX_LENGTH = 1600;

  if (text.length <= MAX_LENGTH) {
    return text;
  }

  const truncated = text.substring(0, MAX_LENGTH);

  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?")
  );

  if (lastSentenceEnd > MAX_LENGTH * 0.7) {
    return truncated.substring(0, lastSentenceEnd + 1);
  }

  return truncated + "...";
}
