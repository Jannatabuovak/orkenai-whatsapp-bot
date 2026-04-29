// ============================================================
// WhatsApp AI Agent — Railway Freight Export
// Vercel API Route: /api/webhook.js
// Компания: ж/д грузоперевозки, экспорт из Казахстана
// ИИ: Claude → Gemini → fallback
// CRM: CRM_WEBHOOK_URL / AMOCRM_WEBHOOK_URL / Make / n8n / webhook.site
// ============================================================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL || process.env.AMOCRM_WEBHOOK_URL;

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// ============================================================
// Память диалогов
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
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
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

    const contactName = value.contacts?.[0]?.profile?.name || "";

    console.log(`[CONTACT] phone=${from} name="${contactName}"`);

    if (messageId && processedMessages.has(messageId)) {
      console.log(`Duplicate message ignored: ${messageId}`);
      return;
    }

    if (messageId) {
      processedMessages.add(messageId);

      if (processedMessages.size > 500) {
        const first = processedMessages.values().next().value;
        processedMessages.delete(first);
      }
    }

    const session = getOrCreateSession(from);

    session.whatsappPhone = from;
    session.whatsappName = contactName || session.whatsappName || "";

    if (message.type !== "text") {
      await sendWhatsAppMessage(from, getUnsupportedTypeReply(session.lang));
      return;
    }

    const userText = message.text?.body?.trim();

    if (!userText) {
      console.log("Empty text message");
      return;
    }

    console.log(`[IN] from=${from} text="${userText}"`);

    if (session.messages.length === 0) {
      session.lang = detectLanguage(userText);
    }

    appendToHistory(from, "user", userText);

    // ========================================================
    // РУЧНОЙ ТЕСТ CRM
    // Напишите боту: тест crm
    // ========================================================

    if (/^тест\s*crm$/i.test(userText) || /^test\s*crm$/i.test(userText)) {
      console.log("[CRM_TEST] Manual CRM test started");

      markLeadHot(from);

      const sentToCrm = await notifyCRM(from, session, "manual_crm_test");

      const reply = sentToCrm
        ? "Тест CRM выполнен: заявка отправлена в webhook. Проверьте webhook.site — должен появиться POST."
        : "Тест CRM не прошёл. Проверьте Vercel Logs: возможно, CRM_WEBHOOK_URL не указан или webhook вернул ошибку.";

      appendToHistory(from, "assistant", reply);
      await sendWhatsAppMessage(from, reply);
      return;
    }

    // ========================================================
    // Если клиент просит менеджера / договор / контракт
    // ========================================================

    if (wantsHumanAgent(userText)) {
      const reply = getHandoffReply(session.lang);

      appendToHistory(from, "assistant", reply);
      markLeadHot(from);

      const sentToCrm = await notifyCRM(from, session, "human_handoff");

      if (sentToCrm) {
        session.crmNotified = true;
      }

      await sendWhatsAppMessage(from, reply);
      return;
    }

    // ========================================================
    // AI-ответ
    // ========================================================

    const aiReply = await askAI(session);

    appendToHistory(from, "assistant", aiReply);

    updateLeadScore(from, userText);

    const aiSaysHandoff =
      /передаю.*заявк|передать.*заявк|заявк.*переда|передаю.*менеджер|менеджер.*свяжется|точн.*расч[её]т|оформ.*заявк|проверит тариф|наличие.*вагон/i.test(
        aiReply
      );

    console.log("[CRM_CHECK]", {
      phone: from,
      leadScore: session.leadScore,
      aiSaysHandoff,
      crmNotified: session.crmNotified,
      hasCrmUrl: Boolean(CRM_WEBHOOK_URL),
    });

    if ((session.leadScore >= 3 || aiSaysHandoff) && !session.crmNotified) {
      const sentToCrm = await notifyCRM(
        from,
        session,
        "hot_lead_or_ai_handoff"
      );

      if (sentToCrm) {
        session.crmNotified = true;
      }
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
  if (ANTHROPIC_API_KEY) {
    console.log("[AI] Trying Claude...");

    const claudeReply = await askClaude(session);

    if (claudeReply) {
      console.log("[AI_PROVIDER] Claude");
      return claudeReply;
    }

    console.warn("[AI] Claude unavailable. Trying Gemini...");
  } else {
    console.log("[AI] Claude key missing. Skipping Claude.");
  }

  const geminiReply = await askGemini(session);

  if (geminiReply) {
    console.log("[AI_PROVIDER] Gemini");
    return geminiReply;
  }

  console.warn("[AI_PROVIDER] Fallback");
  return fallbackReply(session.lang);
}

// ============================================================
// Claude
// ============================================================

async function askClaude(session) {
  if (!ANTHROPIC_API_KEY) {
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
        max_tokens: 450,
        temperature: 0.25,
        system: getSystemPrompt(session),
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
              text: getSystemPrompt(session),
            },
          ],
        },
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 450,
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
      return null;
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
      whatsappPhone: phone,
      whatsappName: "",
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

// ============================================================
// Определение языка
// ============================================================

function detectLanguage(text) {
  const lower = text.toLowerCase();

  if (
    /[әіңғүұқөһ]/.test(lower) ||
    /\b(сәлем|рахмет|қайда|жүк|вагон|қанша|жіберу|баға|мерзім|керек)\b/.test(
      lower
    )
  ) {
    return "kz";
  }

  if (
    /[ʻʼ]/.test(text) ||
    /\b(salom|rahmat|qayerda|narx|yuk|vagon|jo'natish|xizmat|kerak)\b/.test(
      lower
    )
  ) {
    return "uz";
  }

  if (
    /[ӣғқҳҷ]/.test(lower) ||
    /\b(салом|рахмат|куҷо|нарх|бор|вагон|фиристодан|хизмат|лозим)\b/.test(
      lower
    )
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

  return /\b(менеджер|оператор|человек|живой|хочу позвонить|соедини|перезвони|мне нужен человек|не с ботом|не бот|свяжитесь|позвоните|договор|контракт)\b/.test(
    lower
  );
}

// ============================================================
// Оценка лида
// ============================================================

function updateLeadScore(phone, userText) {
  const session = conversationStore.get(phone);

  if (!session) return;

  const lower = userText.toLowerCase();

  let added = 0;

  if (
    /\b(цена|стоимость|сколько стоит|тариф|расчет|расчёт|посчитай)\b/.test(
      lower
    )
  ) {
    added++;
  }

  if (
    /\b(маршрут|откуда|куда|направление|станция|алматы|ташкент|душанбе|афганистан|узбекистан|таджикистан)\b/.test(
      lower
    )
  ) {
    added++;
  }

  if (/\b(вагон|контейнер|хоппер|крытый|платформа|зерновоз)\b/.test(lower)) {
    added++;
  }

  if (
    /\b(контракт|договор|заявка|оформить|отправить|перевезти)\b/.test(lower)
  ) {
    added++;
  }

  if (/\b(срочно|срочная|быстро|сегодня|завтра|дата отправки)\b/.test(lower)) {
    added++;
  }

  if (/\b(тонн|тонна|кг|кило|объем|объём|вес|кубов)\b/.test(lower)) {
    added++;
  }

  session.leadScore += added;

  console.log(`[LEAD] phone=${phone} added=${added} score=${session.leadScore}`);
}

function markLeadHot(phone) {
  const session = conversationStore.get(phone);

  if (session) {
    session.leadScore = 10;
  }
}

// ============================================================
// CRM / AmoCRM / Make / n8n / webhook.site
// ============================================================

async function notifyCRM(phone, session, reason = "lead") {
  const summary = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" | ");

  const leadPayload = {
    source: "WhatsApp Bot",
    reason,
    phone,
    whatsapp_phone: session.whatsappPhone || phone,
    whatsapp_name: session.whatsappName || "",
    lang: session.lang,
    leadScore: session.leadScore || 0,
    messages: summary,
    title: `Заявка WhatsApp: ${summary.slice(0, 100)}`,
    createdAt: new Date().toISOString(),
  };

  console.log(
    `[CRM] HOT LEAD phone=${phone} score=${session.leadScore} reason=${reason} hasCrmUrl=${Boolean(
      CRM_WEBHOOK_URL
    )}`
  );

  if (!CRM_WEBHOOK_URL) {
    console.warn("[CRM] CRM_WEBHOOK_URL is missing. Lead was not sent.");
    return false;
  }

  try {
    const response = await fetch(CRM_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(leadPayload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("[CRM] Webhook error:", response.status, responseText);
      return false;
    }

    console.log("[CRM] Lead sent to CRM webhook");
    console.log("[CRM_RESPONSE]", responseText);

    return true;
  } catch (error) {
    console.error("[CRM] Webhook request failed:", error);
    return false;
  }
}

// ============================================================
// Системный промпт
// ============================================================

function getSystemPrompt(session = {}) {
  const lang = session.lang || "ru";

  const langInstruction =
    {
      ru: "Отвечай ТОЛЬКО на русском языке.",
      kz: "Жауапты ТЕК қазақ тілінде бер.",
      uz: "Faqat O'zbek tilida javob ber.",
      tj: "Танҳо ба забони тоҷикӣ ҷавоб деҳ.",
    }[lang] || "Отвечай ТОЛЬКО на русском языке.";

  const profileName = session.whatsappName || "";
  const phone = session.whatsappPhone || session.phone || "";

  return `
Ты виртуальный менеджер компании, которая оказывает услуги железнодорожных грузоперевозок.

ЯЗЫК: ${langInstruction}

Данные из WhatsApp:
- WhatsApp-номер клиента уже определён автоматически: ${phone || "номер будет взят из webhook"}
- Имя из WhatsApp-профиля: ${profileName || "не передано"}
- Номер телефона повторно НЕ спрашивай.
- Не выводи номер клиента в ответе без необходимости.
- Если имя из профиля выглядит нормальным, можешь использовать его аккуратно.
- Если имени нет, попроси только имя и компанию.

Компания специализируется на:
- экспорте грузов из Казахстана в Узбекистан, Таджикистан, Афганистан;
- железнодорожных перевозках сельскохозяйственной продукции: пшеница, ячмень, кукуруза, рис, сахар, масло, льняное семя, хлопковое семя и другие грузы;
- подборе типа вагона: крытый вагон, хоппер/зерновоз, платформа;
- предварительном расчёте тарифов;
- оформлении контрактов и документов: СТ-1, фитосанитарный сертификат, ТН ВЭД, экспортная декларация, инвойс;
- отслеживании вагонов через системы КТЖ.

Твоя роль:
Ты общаешься как внимательный менеджер по железнодорожным перевозкам.
Клиент должен чувствовать, что его поняли, а не что он получил шаблонный ответ.
Не говори, что ты бот, AI или языковая модель без необходимости.
Если клиент прямо спросит "вы бот?" или "это человек?", честно ответь:
"Я виртуальный помощник компании, помогаю быстро собрать заявку. Точный расчёт подтвердит менеджер."

Стиль общения:
- отвечай естественно, спокойно и по-деловому;
- не начинай каждый ответ одинаково;
- не пиши "чем могу помочь", если клиент уже описал задачу;
- сначала кратко подтверди, что понял запрос;
- используй детали клиента: груз, маршрут, вес, дату, тип вагона;
- задавай только 1–2 уточняющих вопроса за раз;
- не используй Markdown;
- не давай точных цен без проверки маршрута, веса, груза, даты и наличия вагона;
- не гарантируй наличие вагонов без проверки менеджером;
- не спрашивай номер телефона повторно;
- в конце ответа мягко веди клиента к следующему шагу.

Данные, которые нужно собрать:
1. Какой груз нужно перевезти
2. Откуда: город или станция отправления в Казахстане
3. Куда: страна, город или станция назначения
4. Вес груза в тоннах
5. Тип вагона, если клиент знает
6. Желаемая дата отправки
7. Нужна ли помощь с документами
8. Имя клиента и компания, если этого ещё нет
9. Номер телефона не спрашивай: WhatsApp-номер уже сохранён автоматически

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
Когда клиент указал груз, маршрут, вес или просит расчёт, не проси номер телефона повторно.
Напиши естественно:
"Понял, данные для предварительной заявки уже есть. Ваш WhatsApp-номер сохранён, поэтому менеджер сможет связаться с вами напрямую. Напишите, пожалуйста, ваше имя и компанию — передам заявку на точный расчёт."

Если клиент уже написал имя и компанию, ответь:
"Спасибо, заявку передаю менеджеру. Он проверит тариф, наличие подходящего вагона и свяжется с вами для точного расчёта."

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
    ru: "Спасибо, сообщение получил. Сейчас лучше всего обрабатываю текст. Напишите, пожалуйста, какой груз нужно перевезти и по какому маршруту.",
    kz: "Хабарыңызды алдым. Әзірге мәтіндік хабарларды жақсы өңдеймін. Қандай жүк және қай бағыт бойынша тасымалдау керек екенін жазыңыз.",
    uz: "Xabaringizni oldim. Hozircha matnli xabarlarni yaxshiroq tushunaman. Qanday yuk va qaysi yo'nalish bo'yicha tashish kerakligini yozing.",
    tj: "Паёматонро гирифтам. Ҳоло матнро беҳтар коркард мекунам. Лутфан нависед, кадом бор ва аз куҷо ба куҷо интиқол дода шавад.",
  };

  return texts[lang] || texts.ru;
}

function getHandoffReply(lang = "ru") {
  const texts = {
    ru: "Понял, передаю заявку менеджеру. Ваш WhatsApp-номер уже сохранён, повторно его писать не нужно. Напишите, пожалуйста, только ваше имя и компанию, чтобы менеджер быстрее подготовил расчёт.",
    kz: "Түсіндім, өтінімді менеджерге беремін. WhatsApp-нөміріңіз сақталды, оны қайта жазудың қажеті жоқ. Есептеуді тездету үшін атыңыз бен компанияңызды жазыңыз.",
    uz: "Tushundim, arizani menejerga yo'naltiraman. WhatsApp raqamingiz saqlandi, uni qayta yozish shart emas. Hisob-kitobni tezlashtirish uchun ismingiz va kompaniyangizni yozing.",
    tj: "Фаҳмидам, дархостро ба менеҷер мерасонам. Рақами WhatsApp-и шумо сабт шуд, дубора навиштан лозим нест. Барои тезтар омода кардани ҳисоб, ном ва ширкататонро нависед.",
  };

  return texts[lang] || texts.ru;
}

function fallbackReply(lang = "ru") {
  const texts = {
    ru:
      "Спасибо, сообщение получил. Могу принять вашу заявку и передать менеджеру.\n\n" +
      "Напишите, пожалуйста:\n" +
      "1. Какой груз нужно перевезти?\n" +
      "2. Откуда и куда?\n" +
      "3. Вес в тоннах?\n" +
      "4. Желаемая дата отправки?\n" +
      "5. Ваше имя и компанию.\n\n" +
      "WhatsApp-номер уже сохранён, повторно его писать не нужно.",

    kz:
      "Хабарыңызды алдым. Өтінімді қабылдап, менеджерге бере аламын.\n\n" +
      "Жазыңыз, өтінемін:\n" +
      "1. Қандай жүк тасымалдау керек?\n" +
      "2. Қайдан және қайда?\n" +
      "3. Салмағы қанша тонна?\n" +
      "4. Жөнелту күні?\n" +
      "5. Атыңыз және компанияңыз.\n\n" +
      "WhatsApp-нөміріңіз сақталды, қайта жазудың қажеті жоқ.",

    uz:
      "Xabaringizni oldim. Arizangizni qabul qilib, menejerga yubora olaman.\n\n" +
      "Iltimos, yozing:\n" +
      "1. Qanday yuk tashish kerak?\n" +
      "2. Qayerdan va qayerga?\n" +
      "3. Og'irligi necha tonna?\n" +
      "4. Jo'natish sanasi?\n" +
      "5. Ismingiz va kompaniyangiz.\n\n" +
      "WhatsApp raqamingiz saqlandi, uni qayta yozish shart emas.",

    tj:
      "Паёматонро гирифтам. Метавонам дархостро қабул карда, ба менеҷер расонам.\n\n" +
      "Лутфан нависед:\n" +
      "1. Кадом борро интиқол додан лозим?\n" +
      "2. Аз куҷо ва ба куҷо?\n" +
      "3. Вазн чанд тонна аст?\n" +
      "4. Санаи фиристодан?\n" +
      "5. Ном ва ширкати шумо.\n\n" +
      "Рақами WhatsApp-и шумо сабт шуд, дубора навиштан лозим нест.",
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function limitWhatsAppText(text) {
  const MAX_LENGTH = 1400;

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
