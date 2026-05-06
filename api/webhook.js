// ============================================================
// WhatsApp AI Agent — Railway Freight Export + Kazakhstan Domestic
// Vercel API Route: /api/webhook.js
// Компания: ж/д грузоперевозки по Казахстану и на экспорт
// ИИ: Claude → Gemini → fallback
// CRM: CRM_WEBHOOK_URL / AMOCRM_WEBHOOK_URL / Make / n8n / webhook.site
// Excel/Sheets: EXCEL_WEBHOOK_URL / GOOGLE_SHEETS_WEBHOOK_URL
// ============================================================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL || process.env.AMOCRM_WEBHOOK_URL;

const EXCEL_WEBHOOK_URL =
  process.env.EXCEL_WEBHOOK_URL || process.env.GOOGLE_SHEETS_WEBHOOK_URL;

const EXCEL_SECRET = process.env.EXCEL_SECRET || "";

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

    // ========================================================
    // Обработка интерактивных кнопок и списков
    // ========================================================

    if (message.type === "interactive") {
      await handleInteractiveReply(from, message, session);
      return;
    }

    if (message.type !== "text") {
      const reply = getUnsupportedTypeReply(session.lang);

      appendToHistory(from, "assistant", reply);

      await saveToExcel(from, session, "bot_reply", {
        aiReply: reply,
        reason: "unsupported_message_type",
      });

      await sendWhatsAppMessage(from, reply);
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

    updateLeadDataFromText(session, userText);
    console.log("[LEAD_DATA]", JSON.stringify(session.leadData));

    await saveToExcel(from, session, "incoming_message", {
      userText,
      reason: "incoming_message",
    });

    // ========================================================
    // РУЧНОЙ ТЕСТ CRM
    // Напишите боту: тест crm
    // ========================================================

    if (/^тест\s*crm$/i.test(userText) || /^test\s*crm$/i.test(userText)) {
      console.log("[CRM_TEST] Manual CRM test started");

      markLeadHot(from);

      const sentToCrm = await notifyCRM(from, session, "manual_crm_test");

      const reply = sentToCrm
        ? "Тест CRM выполнен: заявка отправлена в webhook. Проверьте webhook.site или вашу CRM-систему — должен появиться POST."
        : "Тест CRM не прошёл. Проверьте Vercel Logs: возможно, CRM_WEBHOOK_URL не указан или webhook вернул ошибку.";

      appendToHistory(from, "assistant", reply);

      await saveToExcel(from, session, "bot_reply", {
        userText,
        aiReply: reply,
        reason: "manual_crm_test",
      });

      await sendWhatsAppMessage(from, reply);
      return;
    }

    // ========================================================
    // РУЧНОЙ ТЕСТ EXCEL / GOOGLE SHEETS
    // Напишите боту: тест excel
    // ========================================================

    if (/^тест\s*(excel|эксель|sheet|sheets|таблица)$/i.test(userText)) {
      console.log("[EXCEL_TEST] Manual Excel test started");

      markLeadHot(from);

      const saved = await saveToExcel(from, session, "manual_excel_test", {
        userText,
        reason: "manual_excel_test",
      });

      const reply = saved
        ? "Тест Excel выполнен: диалог и заявка сохранены в таблицу."
        : "Тест Excel не прошёл. Проверьте EXCEL_WEBHOOK_URL, EXCEL_SECRET и Apps Script.";

      appendToHistory(from, "assistant", reply);

      await saveToExcel(from, session, "bot_reply", {
        userText,
        aiReply: reply,
        reason: "manual_excel_test_reply",
      });

      await sendWhatsAppMessage(from, reply);
      return;
    }

    // ========================================================
    // Если клиент явно просит человека / звонок
    // Бот всё равно отвечает как менеджер, но заявку фиксирует
    // ========================================================

    if (wantsHumanAgent(userText)) {
      const reply = getHandoffReply(session.lang);

      appendToHistory(from, "assistant", reply);
      markLeadHot(from);

      await saveToExcel(from, session, "lead", {
        userText,
        aiReply: reply,
        reason: "human_callback_request",
      });

      const sentToCrm = await notifyCRM(from, session, "human_callback_request");

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

    await saveToExcel(from, session, "bot_reply", {
      userText,
      aiReply,
      reason: "bot_reply",
    });

    updateLeadScore(from, userText);

    const aiSaysLeadReady =
      /заявк.*зафикс|оформляю.*заявк|беру.*в\s+работ|подготов.*расч[её]т|провер.*тариф|наличие.*вагон|проверю.*тариф|расч[её]т.*подготов/i.test(
        aiReply
      );

    console.log("[CRM_CHECK]", {
      phone: from,
      leadScore: session.leadScore,
      aiSaysLeadReady,
      crmNotified: session.crmNotified,
      hasCrmUrl: Boolean(CRM_WEBHOOK_URL),
      hasExcelUrl: Boolean(EXCEL_WEBHOOK_URL),
      leadData: session.leadData,
    });

    if ((session.leadScore >= 3 || aiSaysLeadReady) && !session.leadSaved) {
      const reason = "hot_lead_or_lead_ready";

      const savedLead = await saveToExcel(from, session, "lead", {
        userText,
        aiReply,
        reason,
      });

      if (savedLead) {
        session.leadSaved = true;
      }

      const sentToCrm = await notifyCRM(from, session, reason);

      if (sentToCrm) {
        session.crmNotified = true;
      }
    }

    await sendWhatsAppMessage(from, aiReply);

    // После первого ответа бота — показать главное меню кнопок
    const assistantCount = session.messages.filter(m => m.role === "assistant").length;
    if (assistantCount === 1) {
      await sendWelcomeButtons(from, session.lang);
    }
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
// Формат истории
// ============================================================

function buildClaudeMessages(session) {
  return session.messages
    .slice(-(MAX_HISTORY_TURNS * 2))
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
}

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
      leadSaved: false,
      lastTs: now,

      leadData: {
        routeType: "",
        cargo: "",
        origin: "",
        destination: "",
        weight: "",
        wagonType: "",
        shippingDate: "",
        documentsHelp: "",
        clientName: "",
        company: "",
      },
    };

    conversationStore.set(phone, session);
  } else {
    session.lastTs = now;

    if (!session.leadData) {
      session.leadData = {
        routeType: "",
        cargo: "",
        origin: "",
        destination: "",
        weight: "",
        wagonType: "",
        shippingDate: "",
        documentsHelp: "",
        clientName: "",
        company: "",
      };
    }

    if (typeof session.leadSaved === "undefined") {
      session.leadSaved = false;
    }
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
// Память по заявке
// ============================================================

function updateLeadDataFromText(session, text) {
  if (!session.leadData) {
    session.leadData = {
      routeType: "",
      cargo: "",
      origin: "",
      destination: "",
      weight: "",
      wagonType: "",
      shippingDate: "",
      documentsHelp: "",
      clientName: "",
      company: "",
    };
  }

  const lower = text.toLowerCase();

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк|внутри\s+рк/.test(lower)) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану";
  }

  const cargoMatch = lower.match(
    /(пшениц[ауы]?|ячмен[ья]?|кукуруз[ауы]?|рис|сахар|масл[оа]|подсолнечн[а-я\s]*масл[оа]|лен|льнян[а-я\s]*сем[яе]|хлопков[а-я\s]*сем[яе]|зерно|мук[ауы]?|цемент|уголь|металл|оборудовани[ея]|паллет[а-я]*|стройматериал[а-я]*|техника|груз)/
  );

  if (cargoMatch) {
    session.leadData.cargo = cargoMatch[0];
  }

  const weightMatch = lower.match(
    /(\d+[.,]?\d*)\s*(тонн|тонна|тонны|т|кг|килограмм|килограммов)/
  );

  if (weightMatch) {
    session.leadData.weight = `${weightMatch[1]} ${weightMatch[2]}`;
  }

  if (/хоппер|зерновоз/.test(lower)) {
    session.leadData.wagonType = "хоппер / зерновоз";
  } else if (/крыт/.test(lower)) {
    session.leadData.wagonType = "крытый вагон";
  } else if (/платформ/.test(lower)) {
    session.leadData.wagonType = "платформа";
  } else if (/контейнер/.test(lower)) {
    session.leadData.wagonType = "контейнер";
  } else if (/не\s+знаю|не\s+знаем|подскажите\s+вагон|какой\s+вагон/.test(lower)) {
    session.leadData.wagonType = "нужно подобрать тип вагона";
  }

  if (/послезавтра/.test(lower)) {
    session.leadData.shippingDate = "послезавтра";
  } else if (/завтра/.test(lower)) {
    session.leadData.shippingDate = "завтра";
  } else if (/сегодня/.test(lower)) {
    session.leadData.shippingDate = "сегодня";
  } else if (/следующ[а-я]+\s+недел/.test(lower)) {
    session.leadData.shippingDate = "на следующей неделе";
  } else {
    const dateMatch = lower.match(/(\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?)/);

    if (dateMatch) {
      session.leadData.shippingDate = dateMatch[1];
    }
  }

  const routeMatch = text.match(
    /(?:из|от)\s+(.+?)\s+(?:в|до|на)\s+(.+?)(?:[.,!?;]|$)/i
  );

  if (routeMatch) {
    session.leadData.origin = cleanPlaceName(routeMatch[1]);
    session.leadData.destination = cleanPlaceName(routeMatch[2]);
  }

  fillKnownCityRoute(session, lower);
  detectRouteType(session, lower);

  const lastAssistant = getLastAssistantMessage(session);
  const assistantAskedDocs = /документ|ст-1|ст1|фито|сертификат|деклараци|инвойс|тн\s*вэд/i.test(
    lastAssistant
  );

  if (
    assistantAskedDocs &&
    /^(нет|не нужно|не надо|без документов|документы не нужны|нет спасибо|нет, спасибо)$/i.test(
      text.trim()
    )
  ) {
    session.leadData.documentsHelp = "не нужна помощь с документами";
  } else if (
    /помощь\s+с\s+документами\s+не\s+нужн|документы\s+не\s+нужны|без\s+документов/.test(
      lower
    )
  ) {
    session.leadData.documentsHelp = "не нужна помощь с документами";
  } else if (
    /нужн[аоы]?\s+.*документ|ст-1|ст1|фито|фитосанитар|сертификат|деклараци|инвойс|тн\s*вэд/.test(
      lower
    )
  ) {
    session.leadData.documentsHelp = "нужна помощь с документами";
  }

  const nameMatch = text.match(
    /(?:меня зовут|я\s+|имя\s+)([А-ЯЁA-ZӘІҢҒҮҰҚӨҺ][а-яёa-zәіңғүұқөһ]{2,20})/i
  );

  if (nameMatch) {
    session.leadData.clientName = nameMatch[1];
  } else if (!session.leadData.clientName && session.whatsappName) {
    session.leadData.clientName = session.whatsappName;
  }

  const companyMatch = text.match(
    /(?:компания|тоо|ип|ТОО|ИП)\s+([А-ЯЁA-Z0-9а-яёa-zәіңғүұқөһ\s"«»._-]{2,60})/i
  );

  if (companyMatch) {
    session.leadData.company = companyMatch[0].trim();
  }
}

function fillKnownCityRoute(session, lower) {
  const cityMap = [
    ["алматы", "Алматы"],
    ["астана", "Астана"],
    ["нур-султан", "Астана"],
    ["караганда", "Караганда"],
    ["қарағанды", "Караганда"],
    ["шымкент", "Шымкент"],
    ["актобе", "Актобе"],
    ["ақтөбе", "Актобе"],
    ["атырау", "Атырау"],
    ["актау", "Актау"],
    ["ақтау", "Актау"],
    ["костанай", "Костанай"],
    ["қостанай", "Костанай"],
    ["павлодар", "Павлодар"],
    ["семей", "Семей"],
    ["усть-каменогорск", "Усть-Каменогорск"],
    ["оскемен", "Усть-Каменогорск"],
    ["өскемен", "Усть-Каменогорск"],
    ["тараз", "Тараз"],
    ["кызылорда", "Кызылорда"],
    ["қызылорда", "Кызылорда"],
    ["кокшетау", "Кокшетау"],
    ["көкшетау", "Кокшетау"],
    ["петропавловск", "Петропавловск"],
    ["уральск", "Уральск"],
    ["орал", "Уральск"],
    ["туркестан", "Туркестан"],
    ["ташкент", "Ташкент"],
    ["душанбе", "Душанбе"],
    ["афганистан", "Афганистан"],
    ["узбекистан", "Узбекистан"],
    ["таджикистан", "Таджикистан"],
  ];

  for (const [raw, nice] of cityMap) {
    const cityRegexFrom = new RegExp(`(?:из|от)\\s+${escapeRegExp(raw)}\\b`, "i");
    const cityRegexTo = new RegExp(`(?:в|до|на)\\s+${escapeRegExp(raw)}\\b`, "i");

    if (!session.leadData.origin && cityRegexFrom.test(lower)) {
      session.leadData.origin = nice;
    }

    if (!session.leadData.destination && cityRegexTo.test(lower)) {
      session.leadData.destination = nice;
    }
  }
}

function detectRouteType(session, lower = "") {
  const origin = normalizeForCompare(session.leadData.origin);
  const destination = normalizeForCompare(session.leadData.destination);

  const kzCities = [
    "алматы",
    "астана",
    "караганда",
    "шымкент",
    "актобе",
    "атырау",
    "актау",
    "костанай",
    "павлодар",
    "семей",
    "усть-каменогорск",
    "тараз",
    "кызылорда",
    "кокшетау",
    "петропавловск",
    "уральск",
    "туркестан",
  ];

  const exportPlaces = [
    "ташкент",
    "узбекистан",
    "душанбе",
    "таджикистан",
    "афганистан",
  ];

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк|внутри\s+рк/.test(lower)) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану";
    return;
  }

  if (exportPlaces.some((place) => destination.includes(place))) {
    session.leadData.routeType = "экспортная / международная перевозка";
    return;
  }

  if (
    kzCities.some((city) => origin.includes(city)) &&
    kzCities.some((city) => destination.includes(city))
  ) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану";
    return;
  }

  if (!session.leadData.routeType && destination) {
    session.leadData.routeType = "тип маршрута нужно уточнить";
  }
}

function getLastAssistantMessage(session) {
  const assistantMessages = session.messages.filter((m) => m.role === "assistant");
  return assistantMessages.length
    ? assistantMessages[assistantMessages.length - 1].content || ""
    : "";
}

function cleanPlaceName(value) {
  return String(value || "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(
      /\b(вес|нужен|нужна|нужно|отправка|отправить|сегодня|завтра|послезавтра|хоппер|крытый|платформа|контейнер|вагон|тонн|тонна|тонны|кг|килограмм|стоимость|цена|посчитайте|расч[её]т).*$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLeadDataSummary(session) {
  const data = session.leadData || {};

  const known = [];
  const missing = [];

  if (data.routeType) known.push(`тип маршрута: ${data.routeType}`);
  else missing.push("тип маршрута");

  if (data.cargo) known.push(`груз: ${data.cargo}`);
  else missing.push("груз");

  if (data.origin) known.push(`откуда: ${data.origin}`);
  else missing.push("откуда");

  if (data.destination) known.push(`куда: ${data.destination}`);
  else missing.push("куда");

  if (data.weight) known.push(`вес: ${data.weight}`);
  else missing.push("вес");

  if (data.wagonType) known.push(`тип вагона: ${data.wagonType}`);
  else missing.push("тип вагона");

  if (data.shippingDate) known.push(`дата отправки: ${data.shippingDate}`);
  else missing.push("дата отправки");

  if (data.documentsHelp) known.push(`документы: ${data.documentsHelp}`);
  else missing.push("нужна ли помощь с документами");

  if (data.clientName) known.push(`имя клиента: ${data.clientName}`);
  else missing.push("имя клиента");

  if (data.company) known.push(`компания: ${data.company}`);
  else missing.push("компания");

  return {
    knownText: known.length ? known.join("; ") : "пока нет заполненных данных",
    missingText: missing.length ? missing.join(", ") : "нет, основные данные собраны",
  };
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
// Запрос человека / звонка
// ============================================================

function wantsHumanAgent(text) {
  const lower = text.toLowerCase();

  return /\b(оператор|человек|живой|хочу позвонить|соедини|перезвони|мне нужен человек|не с ботом|не бот|свяжитесь|позвоните)\b/.test(
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
    /\b(маршрут|откуда|куда|направление|станция|по казахстану|внутри казахстана|алматы|астана|караганда|шымкент|актобе|атырау|актау|костанай|павлодар|семей|усть-каменогорск|тараз|кызылорда|кокшетау|петропавловск|уральск|туркестан|ташкент|душанбе|афганистан|узбекистан|таджикистан)\b/.test(
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
    leadData: session.leadData || {},
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
// Сохранение диалога и заявки в Excel / Google Sheets
// ============================================================

async function saveToExcel(phone, session, eventType, options = {}) {
  if (!EXCEL_WEBHOOK_URL) {
    console.warn("[EXCEL] EXCEL_WEBHOOK_URL is missing. Nothing saved.");
    return false;
  }

  const dialogText = session.messages
    .map((m) => {
      const role = m.role === "assistant" ? "Бот" : "Клиент";
      return `${role}: ${m.content}`;
    })
    .join("\n");

  const userMessages = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" | ");

  const payload = {
    secret: EXCEL_SECRET,
    eventType,
    timestamp: new Date().toISOString(),

    phone,
    whatsapp_phone: session.whatsappPhone || phone,
    whatsapp_name: session.whatsappName || "",

    lang: session.lang,
    leadScore: session.leadScore || 0,
    leadData: session.leadData || {},

    userText: options.userText || "",
    aiReply: options.aiReply || "",
    reason: options.reason || "",

    messages: userMessages,
    dialogText,
  };

  console.log("[EXCEL] Saving event:", eventType);

  try {
    const response = await fetch(EXCEL_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("[EXCEL] Save error:", response.status, responseText);
      return false;
    }

    console.log("[EXCEL] Saved successfully");
    console.log("[EXCEL_RESPONSE]", responseText);

    return true;
  } catch (error) {
    console.error("[EXCEL] Request failed:", error);
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
  const leadMemory = buildLeadDataSummary(session);

  return `
Ты менеджер компании, которая оказывает услуги железнодорожных грузоперевозок по Казахстану и на экспорт.

ЯЗЫК: ${langInstruction}

Данные из WhatsApp:
- WhatsApp-номер клиента уже определён автоматически: ${phone || "номер будет взят из webhook"}
- Имя из WhatsApp-профиля: ${profileName || "не передано"}
- Номер телефона повторно НЕ спрашивай.
- Не выводи номер клиента в ответе без необходимости.
- Если имя из профиля выглядит нормальным, можешь использовать его аккуратно.
- Если имени нет, попроси только имя и компанию.

Память по текущей заявке:
- Уже известно: ${leadMemory.knownText}
- Ещё не хватает: ${leadMemory.missingText}

Критически важное правило:
- Не задавай повторно вопросы по данным, которые уже есть в блоке "Уже известно".
- Если груз, маршрут, вес, тип вагона или дата уже известны — не спрашивай их снова.
- Если клиент уже ответил "нет" по документам — больше не спрашивай про документы.
- Если не хватает нескольких данных, спроси максимум 1–2 самых важных.
- Если основные данные уже собраны, не продолжай расспросы, а зафиксируй заявку и переходи к расчёту.
- Не говори клиенту "передам менеджеру", "менеджер свяжется", "соединяю с менеджером".
- Общайся так, будто ты сам принимаешь заявку и сам ведёшь клиента.

Компания специализируется на:
- железнодорожных грузоперевозках по Казахстану: между городами, станциями, складами, элеваторами, производственными площадками;
- экспортных перевозках из Казахстана в Узбекистан, Таджикистан, Афганистан и другие направления;
- перевозках сельскохозяйственной продукции: пшеница, ячмень, кукуруза, рис, сахар, масло, льняное семя, хлопковое семя и другие грузы;
- перевозках промышленных, паллетированных, тарных, сыпучих и нестандартных грузов;
- подборе типа вагона: крытый вагон, хоппер/зерновоз, платформа, контейнер;
- предварительном расчёте тарифа по маршруту, весу, типу груза и дате отправки;
- оформлении заявок, договоров, счетов и сопроводительных документов;
- отслеживании вагонов через системы КТЖ.

Важно по типу маршрута:
Если маршрут внутри Казахстана, не называй перевозку экспортной.
Если клиент пишет "по Казахстану", "из Алматы в Астану", "из Шымкента в Караганду" и т.п., веди диалог как по внутренней перевозке.
Для внутренних перевозок не спрашивай автоматически СТ-1, экспортную декларацию и ТН ВЭД.
СТ-1, экспортная декларация и таможенные вопросы актуальны только для международных/экспортных направлений.

Твоя роль:
Ты общаешься как менеджер по железнодорожным перевозкам: уверенно, спокойно, по делу и от первого лица.
Используй формулировки:
- "зафиксировал заявку"
- "проверю тариф"
- "подготовлю расчёт"
- "уточню наличие подходящего вагона"
- "оформляю заявку"
- "беру в работу"
- "по этим данным можно подготовить расчёт"

Не используй формулировки:
- "передам менеджеру"
- "менеджер свяжется"
- "соединяю с менеджером"
- "ожидайте звонка менеджера"

Клиент должен чувствовать, что общается с ответственным специалистом, а не получает шаблонный ответ.
Не говори, что ты бот, AI или языковая модель без необходимости.
Если клиент прямо спросит "вы бот?" или "это человек?", честно ответь:
"Я виртуальный помощник компании, помогаю быстро принять заявку и подготовить расчёт. Все данные фиксирую для обработки."

Стиль общения:
- отвечай естественно, спокойно и по-деловому;
- не начинай каждый ответ одинаково;
- не пиши "чем могу помочь", если клиент уже описал задачу;
- сначала кратко подтверди, что понял запрос;
- используй детали клиента: груз, маршрут, вес, дату, тип вагона;
- задавай только 1–2 уточняющих вопроса за раз;
- перед каждым вопросом проверь блок "Память по текущей заявке";
- не повторяй вопрос, если ответ уже есть в памяти заявки;
- если клиент уже дал данные, лучше подтверди их и переходи к следующему шагу;
- не используй Markdown;
- не давай точных цен без проверки маршрута, веса, груза, даты и наличия вагона;
- не гарантируй наличие вагонов без проверки;
- не спрашивай номер телефона повторно;
- в конце ответа мягко веди клиента к следующему шагу.

Данные, которые нужно собрать:
1. Какой груз нужно перевезти
2. Откуда: город или станция отправления
3. Куда: город, станция или страна назначения
4. Вес груза в тоннах
5. Тип вагона, если клиент знает
6. Желаемая дата отправки
7. Для внутренних перевозок: нужна ли помощь с договором, счётом, заявкой и сопроводительными документами
8. Для экспортных перевозок: нужна ли помощь с экспортными документами
9. Имя клиента и компания, если этого ещё нет
10. Номер телефона не спрашивай: WhatsApp-номер уже сохранён автоматически

Маршруты и сроки справочно:
- Внутри Казахстана: срок зависит от станции отправления, станции назначения, наличия вагона и графика движения; точный срок определяется после проверки.
- Казахстан → Узбекистан: 3–5 суток
- Казахстан → Таджикистан: 5–8 суток
- Казахстан → Афганистан: 10–18 суток

Если маршрут внутренний по Казахстану, отвечай так:
"Понял, это внутренняя перевозка по Казахстану. Для точного расчёта нужны станция/город отправления, станция/город назначения, груз, вес, тип вагона и желаемая дата отправки."

Типы вагонов:
- Крытый вагон: 60–68 тонн, подходит для зерна в мешках, сахара, масла в упаковке, тарных и паллетированных грузов
- Хоппер/зерновоз: 60–75 тонн, подходит для пшеницы, ячменя, кукурузы и других сыпучих грузов
- Платформа: подходит для паллет, оборудования, техники и нестандартных грузов
- Контейнер: подходит для отдельных видов тарных, сборных и контейнерных грузов

Документы справочно:
Для внутренних перевозок по Казахстану:
- не говори про СТ-1 и экспортную декларацию как обязательные документы;
- уточняй только, нужна ли помощь с договором, счётом, заявкой и сопроводительными документами;
- если груз специфический, скажи, что требования по документам уточняются после проверки груза и маршрута.

Для экспортных перевозок:
- СТ-1 — сертификат происхождения, часто требуется для Узбекистана и Таджикистана
- Фитосанитарный сертификат может потребоваться для зерновых и масличных грузов
- ТН ВЭД справочно: пшеница 1001, ячмень 1003, сахар 1701, масло подсолнечное 1512
- Экспортную декларацию оформляет таможенный брокер
- Инвойс и счёт-фактура готовятся по данным клиента

Оформление заявки:
Когда клиент указал груз, маршрут, вес или просит расчёт, не проси номер телефона повторно.
Не говори "передам менеджеру" и "менеджер свяжется".
Говори от первого лица как менеджер.

Если не хватает имени и компании, напиши естественно:
"Понял, основные данные для расчёта уже есть. Ваш WhatsApp-номер сохранён. Напишите, пожалуйста, ваше имя и компанию — я зафиксирую заявку и подготовлю расчёт."

Если имя и компания уже есть, ответь:
"Спасибо, заявку зафиксировал. Проверю тариф, наличие подходящего вагона и подготовлю точный расчёт по вашему маршруту."

Если клиент просит договор или оформление, ответь:
"Хорошо, оформляю заявку. По вашему маршруту проверю тариф, наличие вагона и подготовлю данные для договора."

Рабочее время:
09:00–18:00, Алматы.
`.trim();
}

// ============================================================
// Интерактивные кнопки: приветственное меню
// ============================================================

async function sendWelcomeButtons(to, lang = "ru") {
  const texts = {
    ru: {
      body: "Выберите раздел — отвечу быстро и по делу:",
      wagons: "🚂 Вагоны и тарифы",
      routes: "🌍 Маршруты и сроки",
      docs:   "📋 Документы",
    },
    kz: {
      body: "Бөлімді таңдаңыз — жылдам жауап беремін:",
      wagons: "🚂 Вагон және тариф",
      routes: "🌍 Бағыт және мерзім",
      docs:   "📋 Құжаттар",
    },
    uz: {
      body: "Bo'limni tanlang — tez javob beraman:",
      wagons: "🚂 Vagon va tariflar",
      routes: "🌍 Yo'nalish va muddatlar",
      docs:   "📋 Hujjatlar",
    },
    tj: {
      body: "Бахшро интихоб кунед — зуд ҷавоб медиҳам:",
      wagons: "🚂 Вагон ва тарифҳо",
      routes: "🌍 Масир ва мӯҳлатҳо",
      docs:   "📋 Ҳуҷҷатҳо",
    },
  };

  const t = texts[lang] || texts.ru;

  await sendInteractiveButtons(to, t.body, [
    { id: "menu_wagons", title: t.wagons },
    { id: "menu_routes", title: t.routes },
    { id: "menu_docs",   title: t.docs },
  ]);
}

// ============================================================
// Обработка нажатий кнопок и выбора из списка
// ============================================================

async function handleInteractiveReply(from, message, session) {
  try {
    const btnReply  = message.interactive?.button_reply;
    const listReply = message.interactive?.list_reply;

    const replyId    = btnReply?.id    || listReply?.id    || "";
    const replyTitle = btnReply?.title || listReply?.title || "";

    console.log(`[INTERACTIVE] from=${from} id="${replyId}" title="${replyTitle}"`);

    // ── Главные категории ──────────────────────────────────
    if (replyId === "menu_wagons") {
      await sendWagonList(from, session.lang);
      return;
    }

    if (replyId === "menu_routes") {
      await sendRouteList(from, session.lang);
      return;
    }

    if (replyId === "menu_docs") {
      await sendDocsList(from, session.lang);
      return;
    }

    // ── Кнопка «Рассчитать тариф» ──────────────────────────
    if (replyId === "btn_calculate") {
      const text = {
        ru: "Хочу рассчитать тариф на перевозку",
        kz: "Тасымал тарифін есептегім келеді",
        uz: "Tashish tarifini hisoblashni xohlayman",
        tj: "Мехоҳам тарифи интиқолро ҳисоб кунам",
      }[session.lang] || "Хочу рассчитать тариф на перевозку";

      appendToHistory(from, "user", text);
      const aiReply = await askAI(session);
      appendToHistory(from, "assistant", aiReply);
      await sendWhatsAppMessage(from, aiReply);
      return;
    }

    // ── Быстрые FAQ-ответы ─────────────────────────────────
    const faqAnswer = getQuickFaqAnswer(replyId, session.lang);

    if (faqAnswer) {
      appendToHistory(from, "user", replyTitle);
      appendToHistory(from, "assistant", faqAnswer);

      await saveToExcel(from, session, "faq_reply", {
        userText: replyTitle,
        aiReply: faqAnswer,
        reason: replyId,
      });

      await sendWhatsAppMessage(from, faqAnswer);

      // После FAQ-ответа — предложить рассчитать тариф
      const calcLabel = {
        ru: "📊 Рассчитать тариф",
        kz: "📊 Тариф есептеу",
        uz: "📊 Tarifni hisoblash",
        tj: "📊 Ҳисоби тариф",
      }[session.lang] || "📊 Рассчитать тариф";

      const menuLabel = {
        ru: "↩ Главное меню",
        kz: "↩ Басты мәзір",
        uz: "↩ Asosiy menyu",
        tj: "↩ Менюи асосӣ",
      }[session.lang] || "↩ Главное меню";

      await sendInteractiveButtons(from,
        { ru: "Что хотите сделать дальше?", kz: "Әрі қарай не жасайсыз?", uz: "Keyingi qadam?", tj: "Баъд чӣ?" }[session.lang] || "Что дальше?",
        [
          { id: "btn_calculate", title: calcLabel },
          { id: "menu_back",     title: menuLabel },
        ]
      );
      return;
    }

    // ── Возврат в главное меню ──────────────────────────────
    if (replyId === "menu_back") {
      await sendWelcomeButtons(from, session.lang);
      return;
    }

    // ── Неизвестная кнопка — пустить через AI ──────────────
    appendToHistory(from, "user", replyTitle);
    const aiReply = await askAI(session);
    appendToHistory(from, "assistant", aiReply);
    await sendWhatsAppMessage(from, aiReply);

  } catch (error) {
    console.error("handleInteractiveReply error:", error);
  }
}

// ============================================================
// Список вопросов: Вагоны и тарифы
// ============================================================

async function sendWagonList(to, lang = "ru") {
  const body = {
    ru: "Выберите вопрос о вагонах:",
    kz: "Вагон туралы сұрақты таңдаңыз:",
    uz: "Vagon haqida savol tanlang:",
    tj: "Саволро дар бораи вагон интихоб кунед:",
  }[lang] || "Выберите вопрос о вагонах:";

  const btn = {
    ru: "Открыть список", kz: "Тізімді ашу", uz: "Ro'yxatni ochish", tj: "Рӯйхатро кушоед",
  }[lang] || "Открыть список";

  await sendInteractiveList(to, body, btn, [
    {
      title: { ru: "Стоимость и вместимость", kz: "Баға және сыйымдылық", uz: "Narx va sig'im", tj: "Нарх ва иқтидор" }[lang] || "Стоимость и вместимость",
      rows: [
        { id: "faq_wagon_price",    title: { ru: "💰 Цена жабық вагона",      kz: "💰 Жабық вагон бағасы",   uz: "💰 Yopiq vagon narxi",       tj: "💰 Нархи вагони пӯшида"  }[lang] || "💰 Цена вагона" },
        { id: "faq_wagon_capacity", title: { ru: "📦 Вместимость вагона",      kz: "📦 Вагонның сыйымдылығы", uz: "📦 Vagon sig'imi",            tj: "📦 Иқтидори вагон"       }[lang] || "📦 Вместимость" },
        { id: "faq_wagon_types",    title: { ru: "🚃 Типы вагонов",            kz: "🚃 Вагон түрлері",         uz: "🚃 Vagon turlari",           tj: "🚃 Намудҳои вагон"       }[lang] || "🚃 Типы вагонов" },
      ],
    },
    {
      title: { ru: "Бронирование и оплата", kz: "Брондау және төлем", uz: "Bron va to'lov", tj: "Бронирование ва пардохт" }[lang] || "Бронирование и оплата",
      rows: [
        { id: "faq_wagon_booking",  title: { ru: "📅 Нужно ли бронировать?",  kz: "📅 Алдын ала брондау?",   uz: "📅 Oldindan bron kerakmi?",  tj: "📅 Оё бронирование лозим?" }[lang] || "📅 Бронирование" },
        { id: "faq_payment",        title: { ru: "💳 Порядок оплаты",          kz: "💳 Төлем тәртібі",         uz: "💳 To'lov tartibi",          tj: "💳 Тартиби пардохт"      }[lang] || "💳 Оплата" },
        { id: "faq_min_order",      title: { ru: "📏 Минимальный объём",       kz: "📏 Ең аз тапсырыс",        uz: "📏 Minimal hajm",            tj: "📏 Ҳаҷми ҳадди аққал"   }[lang] || "📏 Мин. объём" },
      ],
    },
  ]);
}

// ============================================================
// Список вопросов: Маршруты и сроки
// ============================================================

async function sendRouteList(to, lang = "ru") {
  const body = {
    ru: "Выберите направление или вопрос:",
    kz: "Бағытты немесе сұрақты таңдаңыз:",
    uz: "Yo'nalish yoki savolni tanlang:",
    tj: "Масир ё саволро интихоб кунед:",
  }[lang] || "Выберите направление:";

  const btn = {
    ru: "Открыть список", kz: "Тізімді ашу", uz: "Ro'yxatni ochish", tj: "Рӯйхатро кушоед",
  }[lang] || "Открыть список";

  await sendInteractiveList(to, body, btn, [
    {
      title: { ru: "Сроки доставки", kz: "Жеткізу мерзімдері", uz: "Yetkazish muddatlari", tj: "Мӯҳлатҳои расонидан" }[lang] || "Сроки доставки",
      rows: [
        { id: "faq_route_kz_uz", title: { ru: "🇺🇿 КЗ → Узбекистан (срок)",    kz: "🇺🇿 ҚЗ → Өзбекстан (мерзім)",   uz: "🇺🇿 QZ → O'zbekiston (muddat)",  tj: "🇺🇿 ҚЗ → Ӯзбекистон (мӯҳлат)"  }[lang] || "🇺🇿 КЗ → Узбекистан" },
        { id: "faq_route_kz_tj", title: { ru: "🇹🇯 КЗ → Таджикистан (срок)",   kz: "🇹🇯 ҚЗ → Тәжікстан (мерзім)",  uz: "🇹🇯 QZ → Tojikiston (muddat)",   tj: "🇹🇯 ҚЗ → Тоҷикистон (мӯҳлат)"  }[lang] || "🇹🇯 КЗ → Таджикистан" },
        { id: "faq_route_kz_af", title: { ru: "🇦🇫 КЗ → Афганистан (срок)",   kz: "🇦🇫 ҚЗ → Ауғанстан (мерзім)",  uz: "🇦🇫 QZ → Afgʻoniston (muddat)", tj: "🇦🇫 ҚЗ → Афғонистон (мӯҳлат)"  }[lang] || "🇦🇫 КЗ → Афганистан" },
      ],
    },
    {
      title: { ru: "Логистика", kz: "Логистика", uz: "Logistika", tj: "Логистика" }[lang] || "Логистика",
      rows: [
        { id: "faq_stations",  title: { ru: "🏭 Станции загрузки",         kz: "🏭 Жүк тиеу станциялары",   uz: "🏭 Yuklash stansiyalari",       tj: "🏭 Истгоҳҳои боргирӣ"         }[lang] || "🏭 Станции загрузки" },
        { id: "faq_tracking",  title: { ru: "📡 Отслеживание груза",        kz: "📡 Жүкті қадағалау",        uz: "📡 Yukni kuzatish",             tj: "📡 Пайгирии бор"              }[lang] || "📡 Отслеживание" },
        { id: "faq_goods",     title: { ru: "📦 Какие товары везём",        kz: "📦 Қандай тауарлар?",       uz: "📦 Qanday tovarlar?",           tj: "📦 Кадом молҳо?"              }[lang] || "📦 Товары" },
      ],
    },
  ]);
}

// ============================================================
// Список вопросов: Документы
// ============================================================

async function sendDocsList(to, lang = "ru") {
  const body = {
    ru: "Выберите вопрос по документам:",
    kz: "Құжаттар бойынша сұрақты таңдаңыз:",
    uz: "Hujjatlar bo'yicha savol tanlang:",
    tj: "Саволро оид ба ҳуҷҷатҳо интихоб кунед:",
  }[lang] || "Выберите вопрос по документам:";

  const btn = {
    ru: "Открыть список", kz: "Тізімді ашу", uz: "Ro'yxatni ochish", tj: "Рӯйхатро кушоед",
  }[lang] || "Открыть список";

  await sendInteractiveList(to, body, btn, [
    {
      title: { ru: "Сертификаты и разрешения", kz: "Сертификаттар", uz: "Sertifikatlar", tj: "Сертификатҳо" }[lang] || "Сертификаты",
      rows: [
        { id: "faq_doc_st1",         title: { ru: "📜 СТ-1 сертификат",          kz: "📜 СТ-1 сертификаты",       uz: "📜 ST-1 sertifikati",          tj: "📜 Сертификати СТ-1"          }[lang] || "📜 СТ-1" },
        { id: "faq_doc_phyto",       title: { ru: "🌿 Фитосанитарный сертификат", kz: "🌿 Фитосанитарлық сертификат", uz: "🌿 Fitosanitariya sertifikati", tj: "🌿 Гувоҳномаи фитосанитарӣ" }[lang] || "🌿 Фитосанитарный" },
        { id: "faq_doc_quality",     title: { ru: "✅ Сертификат качества",       kz: "✅ Сапа сертификаты",       uz: "✅ Sifat sertifikati",         tj: "✅ Гувоҳномаи сифат"         }[lang] || "✅ Сертификат качества" },
      ],
    },
    {
      title: { ru: "Таможня и экспорт", kz: "Кеден және экспорт", uz: "Bojxona va eksport", tj: "Гумрук ва содирот" }[lang] || "Таможня и экспорт",
      rows: [
        { id: "faq_doc_declaration", title: { ru: "📋 Экспортная декларация",    kz: "📋 Экспорттық декларация",  uz: "📋 Eksport deklaratsiyasi",    tj: "📋 Декларацияи содиротӣ"     }[lang] || "📋 Экспортная декларация" },
        { id: "faq_doc_tnved",       title: { ru: "🔢 ТН ВЭД коды",             kz: "🔢 ТН СЭҚ кодтары",        uz: "🔢 TN VED kodlari",            tj: "🔢 Рамзҳои ТН ВЭД"          }[lang] || "🔢 ТН ВЭД" },
        { id: "faq_doc_customs",     title: { ru: "🏛 Таможенное оформление",    kz: "🏛 Кедендік рәсімдеу",      uz: "🏛 Bojxona rasmiylashuvi",     tj: "🏛 Расмикунонии гумрукӣ"     }[lang] || "🏛 Таможня" },
      ],
    },
    {
      title: { ru: "Договор и счета", kz: "Шарт және шот", uz: "Shartnoma va hisob", tj: "Шартнома ва ҳисоб" }[lang] || "Договор и счета",
      rows: [
        { id: "faq_doc_contract",    title: { ru: "🤝 Контракт и инвойс",        kz: "🤝 Контракт және инвойс",   uz: "🤝 Kontrakt va invoice",       tj: "🤝 Шартнома ва инвойс"       }[lang] || "🤝 Контракт" },
        { id: "faq_doc_packaging",   title: { ru: "📦 Требования к упаковке",    kz: "📦 Қаптама талаптары",      uz: "📦 Qadoqlash talablari",       tj: "📦 Талабот ба бастабандӣ"    }[lang] || "📦 Упаковка" },
        { id: "faq_doc_time",        title: { ru: "⏱ Срок оформления",          kz: "⏱ Рәсімдеу мерзімі",       uz: "⏱ Rasmiylashtirish muddati",  tj: "⏱ Мӯҳлати расмикунонӣ"     }[lang] || "⏱ Срок оформления" },
      ],
    },
  ]);
}

// ============================================================
// Быстрые FAQ-ответы на кнопки
// ============================================================

function getQuickFaqAnswer(id, lang = "ru") {
  const answers = {

    // ── Вагоны ──────────────────────────────────────────────
    faq_wagon_price: {
      ru: "Цена жабық вагона зависит от маршрута, груза и текущих тарифов КТЖ.\n\nОриентировочно стоимость аренды крытого вагона на экспортных маршрутах — от $800 до $2000+, в зависимости от расстояния и загрузки.\n\nДля точного расчёта нужны: груз, маршрут (откуда–куда), вес и желаемая дата отправки.",
      kz: "Жабық вагонның бағасы маршрутқа, жүкке және ҚТЖ тарифіне байланысты.\n\nЖуықша баға: экспорттық бағыттар бойынша $800–$2000+.\n\nДәл есептеу үшін керек: жүк, бағыт, салмақ, жөнелту күні.",
      uz: "Yopiq vagon narxi marshrut, yuk va KTZ tarifiga bog'liq.\n\nYo'nalishga qarab taxminiy narx: $800–$2000+.\n\nAniq hisoblash uchun kerak: yuk, marshrut, og'irlik, jo'natish sanasi.",
      tj: "Нархи вагони пӯшида ба масир, бор ва тарифи КТЖ вобаста аст.\n\nТахминан: $800–$2000+ барои масирҳои содиротӣ.\n\nБарои ҳисоби дақиқ лозим аст: бор, масир, вазн, санаи фиристодан.",
    },

    faq_wagon_capacity: {
      ru: "Вместимость вагонов:\n\n🚃 Крытый вагон — 60–68 тонн (зерно в мешках, сахар, масло, паллеты)\n🌾 Хоппер / зерновоз — 60–75 тонн (пшеница, ячмень, кукуруза насыпью)\n🔩 Платформа — до 70 тонн (оборудование, техника, нестандартные грузы)\n📦 Контейнер 40 ft — до 28 тонн (сборные, тарные грузы)\n\nЕсли не знаете тип вагона — подберём под ваш груз.",
      kz: "Вагондардың сыйымдылығы:\n\n🚃 Жабық вагон — 60–68 тонна\n🌾 Хоппер / зерновоз — 60–75 тонна\n🔩 Платформа — 70 тоннаға дейін\n📦 Контейнер 40 фут — 28 тоннаға дейін\n\nВагон түрін білмесеңіз — жүкке қарай таңдаймыз.",
      uz: "Vagonlarning sig'imi:\n\n🚃 Yopiq vagon — 60–68 tonna\n🌾 Hopper / donvoz — 60–75 tonna\n🔩 Platforma — 70 tonnagacha\n📦 Konteyner 40 ft — 28 tonnagacha\n\nVagon turini bilmasangiz — yukka qarab tanlaymiz.",
      tj: "Иқтидори вагонҳо:\n\n🚃 Вагони пӯшида — 60–68 тонна\n🌾 Хоппер / ғалладон — 60–75 тонна\n🔩 Платформа — то 70 тонна\n📦 Контейнер 40 фут — то 28 тонна\n\nАгар намуди вагонро надонед — мо интихоб мекунем.",
    },

    faq_wagon_types: {
      ru: "Типы вагонов, с которыми работаем:\n\n🚃 Крытый вагон — для зерна в мешках, сахара, масла в таре, паллетированных грузов\n🌾 Хоппер / зерновоз — для пшеницы, ячменя, кукурузы и других сыпучих насыпью\n🔩 Платформа — для техники, оборудования, нестандартных грузов\n📦 Контейнер — для сборных, тарных и контейнерных грузов\n\nПодберём оптимальный тип под ваш груз и маршрут.",
      kz: "Жұмыс жасайтын вагон түрлері:\n\n🚃 Жабық вагон — қаптамалы астық, қант, май\n🌾 Хоппер / зерновоз — себілетін астық\n🔩 Платформа — техника, жабдық\n📦 Контейнер — жинақты жүктер\n\nЖүкке сай оңтайлы вагон түрін таңдаймыз.",
      uz: "Biz ishlatiladigan vagon turlari:\n\n🚃 Yopiq vagon — qoplardagi don, shakar, moy, palletlar\n🌾 Hopper / donvoz — bug'doy, arpa, makkajo'xori nasypyu\n🔩 Platforma — texnika, uskunalar\n📦 Konteyner — yig'ma yuklar\n\nYukingizga mos vagon turini tanlaymiz.",
      tj: "Намудҳои вагоне, ки кор мекунем:\n\n🚃 Вагони пӯшида — ғалла дар халта, шакар, равған\n🌾 Хоппер / ғалладон — гандум, ҷав, ҷуворимакка\n🔩 Платформа — техника, таҷҳизот\n📦 Контейнер — борҳои омехта\n\nНамуди муносибро барои бори шумо интихоб мекунем.",
    },

    faq_wagon_booking: {
      ru: "Вагоны желательно бронировать заранее — особенно в сезон (апрель–октябрь).\n\nЧем раньше подаётся заявка, тем выше шанс получить нужный тип вагона в нужную дату.\n\nОбычно бронирование подтверждается после согласования маршрута, груза и оплаты. Уточните дату — посмотрю наличие.",
      kz: "Вагондарды алдын ала брондаған дұрыс — әсіресе маусымда (сәуір–қазан).\n\nӨтінім ерте берілсе, қажетті вагонды алу мүмкіндігі жоғары.\n\nЖөнелту күнін айтыңыз — қолжетімділікті тексеремін.",
      uz: "Vagonlarni oldindan bron qilish tavsiya etiladi — ayniqsa mavsum paytida (aprel–oktyabr).\n\nAriza qanchalik erta berilsa, kerakli vagonni olish ehtimoli shunchalik yuqori.\n\nJo'natish sanasini ayting — mavjudligini tekshiraman.",
      tj: "Вагонҳоро аз пеш бронирование кардан маъқул аст — хусусан дар мавсум (апрел–октябр).\n\nҲарчи зудтар дархост дода шавад, ҳамон қадар имкони гирифтани вагон зиёдтар аст.\n\nСанаи фиристоданро гӯед — мавҷудиятро месанҷам.",
    },

    faq_payment: {
      ru: "Порядок оплаты:\n\n💳 Обычно: предоплата 50–100% до отправки вагона.\n🏦 Оплата по безналичному расчёту на расчётный счёт компании.\n📑 После оплаты — выставляется счёт-фактура и оформляется договор.\n\nТочные условия оплаты обсуждаются индивидуально. Напишите объём и маршрут — подготовлю детали.",
      kz: "Төлем тәртібі:\n\n💳 Әдетте: вагон жіберілмес бұрын 50–100% алдын ала төлем.\n🏦 Қолма-қол емес есеп арқылы төленеді.\n📑 Төлемнен кейін шот-фактура және шарт рәсімделеді.\n\nТолық шарттарды маршрут пен көлемді айтқаннан кейін дайындаймын.",
      uz: "To'lov tartibi:\n\n💳 Odatda: jo'natishdan oldin 50–100% oldindan to'lov.\n🏦 Naqd pulsiz hisob orqali to'lanadi.\n📑 To'lovdan keyin hisob-faktura va shartnoma rasmiylashtiriladi.\n\nBatafsil shartlarni marshrut va hajmni bilgandan keyin tayyorlayman.",
      tj: "Тартиби пардохт:\n\n💳 Одатан: 50–100% пешпардохт пеш аз фиристодани вагон.\n🏦 Пардохт тавассути ҳисоби бонкӣ.\n📑 Пас аз пардохт — ҳисоб-фактура ва шартнома расмӣ мешавад.\n\nШартҳои дақиқро пас аз донистани масир ва ҳаҷм омода мекунам.",
    },

    faq_min_order: {
      ru: "Минимальный объём — один вагон.\n\n🌾 Хоппер / зерновоз: от 60 тонн\n🚃 Крытый вагон: от 60 тонн\n\nЕсли груза меньше — уточните объём, подберём оптимальное решение: возможно подходит контейнер или сборный вариант.",
      kz: "Ең аз тапсырыс — бір вагон.\n\n🌾 Хоппер: 60 тоннадан\n🚃 Жабық вагон: 60 тоннадан\n\nЖүк аз болса — көлемін айтыңыз, оңтайлы шешім табамыз.",
      uz: "Minimal hajm — bitta vagon.\n\n🌾 Hopper: 60 tonnadan\n🚃 Yopiq vagon: 60 tonnadan\n\nYuk kamroq bo'lsa — hajmni ayting, optimal echim topamiz.",
      tj: "Ҳаҷми ҳадди аққал — як вагон.\n\n🌾 Хоппер: аз 60 тонна\n🚃 Вагони пӯшида: аз 60 тонна\n\nАгар бор камтар бошад — ҳаҷмро гӯед, роҳи муносиб меёбем.",
    },

    // ── Маршруты ────────────────────────────────────────────
    faq_route_kz_uz: {
      ru: "🇺🇿 Казахстан → Узбекистан\n\n⏱ Срок: 3–5 суток в среднем (зависит от станции отправления и назначения).\n📍 Популярные маршруты: Алматы / Шымкент / Туркестан → Ташкент / Самарканд / Фергана.\n📋 Документы: обычно требуется СТ-1 (сертификат происхождения), для зерновых — фитосанитарный сертификат.\n\nКакой груз и откуда планируете?",
      kz: "🇺🇿 Қазақстан → Өзбекстан\n\n⏱ Мерзім: орташа 3–5 тәулік.\n📍 Танымал бағыттар: Алматы / Шымкент → Ташкент / Самарқанд.\n📋 Құжаттар: СТ-1, астық үшін — фитосанитарлық сертификат.\n\nҚандай жүк және қайдан жоспарлап отырсыз?",
      uz: "🇺🇿 Qozog'iston → O'zbekiston\n\n⏱ Muddat: o'rtacha 3–5 kun.\n📍 Mashhur yo'nalishlar: Olma-Ota / Shymkent → Toshkent / Samarqand.\n📋 Hujjatlar: ST-1, donlar uchun — fitosanitariya sertifikati.\n\nQanday yuk va qayerdan?",
      tj: "🇺🇿 Қазоқистон → Ӯзбекистон\n\n⏱ Мӯҳлат: миёнаи 3–5 шабонарӯз.\n📍 Масирҳои маъмул: Олма-Ато / Шымкент → Тошканд / Самарқанд.\n📋 Ҳуҷҷатҳо: СТ-1, барои ғалла — гувоҳномаи фитосанитарӣ.\n\nЧӣ намуди бор ва аз куҷо?",
    },

    faq_route_kz_tj: {
      ru: "🇹🇯 Казахстан → Таджикистан\n\n⏱ Срок: 5–8 суток в среднем.\n📍 Маршрут идёт через Узбекистан (транзит).\n📋 Документы: СТ-1, для зерновых — фитосанитарный сертификат, экспортная декларация.\n\nТранзит через Узбекистан потребует дополнительного согласования — уточняем маршрут индивидуально.",
      kz: "🇹🇯 Қазақстан → Тәжікстан\n\n⏱ Мерзім: орташа 5–8 тәулік.\n📍 Маршрут Өзбекстан арқылы өтеді (транзит).\n📋 Құжаттар: СТ-1, фитосанитарлық сертификат, экспорттық декларация.\n\nТранзиттік рәсімдеу жеке талқыланады.",
      uz: "🇹🇯 Qozog'iston → Tojikiston\n\n⏱ Muddat: o'rtacha 5–8 kun.\n📍 Marshrut O'zbekiston orqali o'tadi (tranzit).\n📋 Hujjatlar: ST-1, fitosanitariya sertifikati, eksport deklaratsiyasi.\n\nTranzit rasmiylashuvi individual muhokama qilinadi.",
      tj: "🇹🇯 Қазоқистон → Тоҷикистон\n\n⏱ Мӯҳлат: миёнаи 5–8 шабонарӯз.\n📍 Масир тавассути Ӯзбекистон (транзит).\n📋 Ҳуҷҷатҳо: СТ-1, гувоҳномаи фитосанитарӣ, декларацияи содиротӣ.\n\nТранзит алоҳида мувофиқа карда мешавад.",
    },

    faq_route_kz_af: {
      ru: "🇦🇫 Казахстан → Афганистан\n\n⏱ Срок: 10–18 суток в среднем.\n📍 Маршрут идёт через Узбекистан, далее через пограничный переход (Хайратон).\n📋 Документы: СТ-1, фитосанитарный сертификат, экспортная декларация, транзитные документы.\n\nЭто наше ключевое направление — работаем регулярно. Уточните груз и объём.",
      kz: "🇦🇫 Қазақстан → Ауғанстан\n\n⏱ Мерзім: орташа 10–18 тәулік.\n📍 Маршрут Өзбекстан арқылы, Хайратон шекара өткелі арқылы.\n📋 Құжаттар: СТ-1, фитосанитарлық сертификат, декларация, транзиттік құжаттар.\n\nБасты бағытымыздың бірі — тұрақты жұмыс жасаймыз.",
      uz: "🇦🇫 Qozog'iston → Afgʻoniston\n\n⏱ Muddat: o'rtacha 10–18 kun.\n📍 Marshrut O'zbekiston orqali, Xayraton chegara o'tkazib yuborish punkti.\n📋 Hujjatlar: ST-1, fitosanitariya sertifikati, deklaratsiya, tranzit hujjatlar.\n\nAsosiy yo'nalishimiz — muntazam ishlayapmiz.",
      tj: "🇦🇫 Қазоқистон → Афғонистон\n\n⏱ Мӯҳлат: миёнаи 10–18 шабонарӯз.\n📍 Масир тавассути Ӯзбекистон, гузаргоҳи Ҳайратон.\n📋 Ҳуҷҷатҳо: СТ-1, гувоҳномаи фитосанитарӣ, декларатсия, ҳуҷҷатҳои транзитӣ.\n\nМасири асосии мо — кор мекунем мунтазам.",
    },

    faq_stations: {
      ru: "Станции загрузки зависят от вашего груза и маршрута.\n\n📍 Работаем со станциями по всему Казахстану: Алматы, Шымкент, Туркестан, Астана, Костанай, Павлодар, Актобе, Атырау, Усть-Каменогорск, Семей, Кызылорда и другие.\n\nНапишите, откуда планируете грузить — уточню ближайшие подходящие станции.",
      kz: "Жүк тиеу станциялары жүк пен бағытқа байланысты.\n\n📍 Қазақстан бойынша барлық негізгі станциялармен жұмыс жасаймыз: Алматы, Шымкент, Астана, Павлодар және т.б.\n\nҚайдан жүк тиегіңіз келетінін айтыңыз — жақын станцияларды нақтылаймын.",
      uz: "Yuklash stansiyalari yukingiz va marshrutingizga bog'liq.\n\n📍 Qozog'istonning barcha asosiy stansiyalari bilan ishlaymiz: Olma-Ota, Shymkent, Nur-Sultan, Pavlodar va boshqalar.\n\nQayerdan yuklashni rejalashtirganingizni ayting — yaqin stansiyalarni aniqlayman.",
      tj: "Истгоҳҳои боргирӣ ба бор ва масири шумо вобаста аст.\n\n📍 Бо ҳамаи истгоҳҳои асосии Қазоқистон кор мекунем: Олма-Ато, Шымкент, Нур-Султон, Павлодар ва ғайра.\n\nАз куҷо боргирӣ мекунед — гӯед, истгоҳи наздикро равшан мекунам.",
    },

    faq_tracking: {
      ru: "📡 Да, отслеживание груза доступно.\n\nВагоны можно отследить через систему КТЖ (Қазақстан Темір Жолы) — по номеру вагона.\n\nПосле отправки предоставляем номер вагона и помогаем с мониторингом движения груза на маршруте.",
      kz: "📡 Иә, жүкті қадағалау мүмкін.\n\nВагондарды ҚТЖ жүйесі арқылы — вагон нөмірі бойынша — қадағалауға болады.\n\nЖөнелтілгеннен кейін вагон нөмірін береміз және қозғалысты бақылауға көмектесеміз.",
      uz: "📡 Ha, yukni kuzatish mumkin.\n\nVagonlarni KTZ tizimi orqali — vagon raqami bo'yicha — kuzatish mumkin.\n\nJo'natilgandan keyin vagon raqamini beramiz va harakat monitoringida yordam beramiz.",
      tj: "📡 Бале, пайгирии бор имконпазир аст.\n\nВагонҳоро тавассути системаи КТЖ — тибқи рақами вагон — пайгирӣ кардан мумкин.\n\nПас аз фиристодан рақами вагонро медиҳем ва дар назорати ҳаракат кӯмак мекунем.",
    },

    faq_goods: {
      ru: "Работаем с широким спектром грузов:\n\n🌾 Зерновые: пшеница, ячмень, кукуруза, рис, льняное семя, хлопковое семя\n🍬 Продовольствие: сахар, подсолнечное масло, мука\n📦 Тарные и паллетированные грузы\n🏗 Промышленные: цемент, металл, оборудование, техника\n\nЕсли не уверены, подходит ли ваш груз — напишите, уточним.",
      kz: "Жүктердің кең ауқымымен жұмыс жасаймыз:\n\n🌾 Астық: бидай, арпа, жүгері, күріш, зығыр, мақта тұқымы\n🍬 Тамақ: қант, күнбағыс майы, ұн\n📦 Қаптамалы жүктер\n🏗 Өнеркәсіптік: цемент, металл, жабдық\n\nЖүкіңіз туралы жазыңыз — тексеріп береміз.",
      uz: "Keng doiradagi yuklarni tashiymiz:\n\n🌾 Donli: bug'doy, arpa, makkajo'xori, guruch, zig'ir, paxta urug'i\n🍬 Oziq-ovqat: shakar, o'simlik yogi, un\n📦 Tarali va palletlangan yuklar\n🏗 Sanoat: sement, metall, uskunalar\n\nYukingiz haqida yozing — tekshiramiz.",
      tj: "Мо бо доираи васеи борҳо кор мекунем:\n\n🌾 Ғалла: гандум, ҷав, ҷуворимакка, биринҷ, тухмии зағир, тухмии пахта\n🍬 Хӯрок: шакар, равғани офтобпараст, орд\n📦 Борҳои тарадӣ ва паллетӣ\n🏗 Саноатӣ: сементу металл ва таҷҳизот\n\nДар бораи бори худ нависед — месанҷем.",
    },

    // ── Документы ───────────────────────────────────────────
    faq_doc_st1: {
      ru: "📜 СТ-1 — сертификат происхождения товара.\n\n✅ Для Узбекистана и Таджикистана — как правило, требуется.\n🌾 Особенно важен для зерновых, сахара, масла.\n🏛 Оформляется через Торгово-промышленную палату (ТПП) Казахстана.\n⏱ Срок оформления: 1–3 рабочих дня.\n\nМы помогаем с подготовкой документов. Уточните груз и направление — скажу, нужен ли СТ-1 именно для вас.",
      kz: "📜 СТ-1 — тауар шығу тегін растайтын сертификат.\n\n✅ Өзбекстан мен Тәжікстанға — әдетте талап етіледі.\n🏛 Қазақстан ТПП арқылы рәсімделеді.\n⏱ Дайындалу мерзімі: 1–3 жұмыс күні.\n\nЖүкті және бағытты айтыңыз — сізге керек пе, жоқ па, айтамын.",
      uz: "📜 ST-1 — tovar kelib chiqishi sertifikati.\n\n✅ O'zbekiston va Tojikiston uchun — odatda talab qilinadi.\n🏛 Qozog'iston TPP orqali rasmiylashtiriladi.\n⏱ Muddati: 1–3 ish kuni.\n\nYuk va yo'nalishni ayting — sizga kerakligini aniqlayman.",
      tj: "📜 СТ-1 — гувоҳномаи пайдоиши мол.\n\n✅ Барои Ӯзбекистон ва Тоҷикистон — одатан лозим аст.\n🏛 Тавассути ТТП Қазоқистон расмӣ мешавад.\n⏱ Мӯҳлат: 1–3 рӯзи корӣ.\n\nБор ва масирро гӯед — зарур аст ё не, мегӯям.",
    },

    faq_doc_phyto: {
      ru: "🌿 Фитосанитарный сертификат (Фито).\n\n📋 Требуется для: пшеницы, ячменя, кукурузы, риса, льняного и хлопкового семени и других растительных грузов.\n🏛 Выдаётся Комитетом государственной инспекции в АПК (КазАгро / МСХ РК).\n⏱ Оформление: 1–3 рабочих дня + время на лабораторный анализ.\n\nНужен ли фитосанитарный сертификат — зависит от вашего груза и страны назначения. Уточните — помогу разобраться.",
      kz: "🌿 Фитосанитарлық сертификат.\n\n📋 Керек: бидай, арпа, жүгері, күріш, зығыр, мақта тұқымы.\n🏛 КазАгро / ҚР АШМ арқылы берілді.\n⏱ Рәсімдеу: 1–3 жұмыс күні + зертханалық талдау.\n\nСізге керек пе — жүкті айтыңыз, нақтылаймын.",
      uz: "🌿 Fitosanitariya sertifikati.\n\n📋 Kerak: bug'doy, arpa, makkajo'xori, guruch, zig'ir, paxta urug'i.\n🏛 KazAgro / QR QXV orqali beriladi.\n⏱ Muddat: 1–3 ish kuni + laboratoriya tahlili.\n\nSizga kerakligini bilish uchun yukni ayting.",
      tj: "🌿 Гувоҳномаи фитосанитарӣ.\n\n📋 Лозим аст барои: гандум, ҷав, ҷуворимакка, биринҷ, тухмии зағир, тухмии пахта.\n🏛 Тавассути КазАгро / ВКХ ҶТ дода мешавад.\n⏱ Мӯҳлат: 1–3 рӯзи корӣ + таҳлили озмоишгоҳӣ.\n\nБарои донистани зарурат — бори худро гӯед.",
    },

    faq_doc_quality: {
      ru: "✅ Сертификат качества (ветеринарный, качества зерна и др.) зависит от конкретного груза и требований страны назначения.\n\n🌾 Для зерновых: сертификат качества зерна выдаётся зерновой лабораторией или элеватором.\n🐄 Для продуктов животного происхождения: ветеринарный сертификат.\n\nУточните ваш груз — скажу, какие именно сертификаты потребуются.",
      kz: "✅ Сапа сертификаты жүкке және тағайындалған елдің талаптарына байланысты.\n\n🌾 Астық үшін: астық зертханасы немесе элеватор береді.\n\nЖүкті айтыңыз — қандай сертификаттар қажет екенін нақтылаймын.",
      uz: "✅ Sifat sertifikati yukka va manzil mamlakatining talablariga bog'liq.\n\n🌾 Donlar uchun: don laboratoriyasi yoki elevator beradi.\n\nYukni ayting — qanday sertifikatlar kerakligini aniqlayman.",
      tj: "✅ Гувоҳномаи сифат ба бор ва талаботи кишвари мақсад вобаста аст.\n\n🌾 Барои ғалла: озмоишгоҳи ғалла ё элеватор медиҳад.\n\nБорро гӯед — кадом гувоҳномаҳо лозим аст мегӯям.",
    },

    faq_doc_declaration: {
      ru: "📋 Экспортная декларация.\n\n🏛 Оформляется таможенным брокером в Казахстане.\n💼 Мы работаем с проверенными брокерами — помогаем подготовить и подать декларацию.\n📄 Для декларации нужны: инвойс, контракт, ТН ВЭД код, данные о грузе и транспорте.\n⏱ Срок: 1–2 рабочих дня при наличии всех документов.\n\nПомогу организовать оформление — уточните груз и маршрут.",
      kz: "📋 Экспорттық декларация.\n\n🏛 Қазақстандағы кедендік брокер арқылы рәсімделеді.\n💼 Сенімді брокерлермен жұмыс жасаймыз — дайындауға көмектесеміз.\n⏱ Мерзімі: барлық құжаттар болса 1–2 жұмыс күні.\n\nЖүк пен бағытты айтыңыз — рәсімдеуді ұйымдастырамын.",
      uz: "📋 Eksport deklaratsiyasi.\n\n🏛 Qozog'istondagi bojxona brokeri tomonidan rasmiylashtiriladi.\n💼 Ishonchli brokerlar bilan ishlaymiz — tayyorlashda yordam beramiz.\n⏱ Muddat: barcha hujjatlar bo'lsa 1–2 ish kuni.\n\nYuk va yo'nalishni ayting — rasmiylashtirishni tashkil etaman.",
      tj: "📋 Декларацияи содиротӣ.\n\n🏛 Тавассути брокери гумрукии Қазоқистон расмӣ мешавад.\n💼 Бо брокерони боваркунанда кор мекунем — дар тайёр кардан кӯмак мекунем.\n⏱ Мӯҳлат: агар ҳамаи ҳуҷҷатҳо бошанд — 1–2 рӯзи корӣ.\n\nБор ва масирро гӯед — расмикунониро ташкил мекунам.",
    },

    faq_doc_tnved: {
      ru: "🔢 ТН ВЭД коды (основные для наших грузов):\n\n🌾 Пшеница — 1001\n🌾 Ячмень — 1003\n🌾 Кукуруза — 1005\n🌾 Рис — 1006\n🍬 Сахар — 1701\n🫙 Масло подсолнечное — 1512\n🌱 Льняное семя — 1204\n🌿 Хлопковое семя — 1207\n\nТочный код определяется по виду и характеристикам вашего груза. Уточните — помогу подобрать правильный код.",
      kz: "🔢 ТН СЭҚ кодтары (негізгі жүктер):\n\n🌾 Бидай — 1001\n🌾 Арпа — 1003\n🌾 Жүгері — 1005\n🌾 Күріш — 1006\n🍬 Қант — 1701\n🫙 Күнбағыс майы — 1512\n🌱 Зығыр тұқымы — 1204\n🌿 Мақта тұқымы — 1207\n\nДәл кодты жүктің түріне қарай анықтаймыз.",
      uz: "🔢 TN VED kodlari (asosiy yuklar uchun):\n\n🌾 Bug'doy — 1001\n🌾 Arpa — 1003\n🌾 Makkajo'xori — 1005\n🌾 Guruch — 1006\n🍬 Shakar — 1701\n🫙 O'simlik yogi — 1512\n🌱 Zig'ir urug'i — 1204\n🌿 Paxta urug'i — 1207\n\nAniq kodni yukingizning turiga qarab aniqlaymiz.",
      tj: "🔢 Рамзҳои ТН ВЭД (барои борҳои асосӣ):\n\n🌾 Гандум — 1001\n🌾 Ҷав — 1003\n🌾 Ҷуворимакка — 1005\n🌾 Биринҷ — 1006\n🍬 Шакар — 1701\n🫙 Равғани офтобпараст — 1512\n🌱 Тухмии зағир — 1204\n🌿 Тухмии пахта — 1207\n\nРамзи дақиқро тибқи намуди бор муайян мекунем.",
    },

    faq_doc_customs: {
      ru: "🏛 Таможенное оформление для экспорта из Казахстана.\n\n📄 Необходимые документы:\n1. Контракт (договор купли-продажи)\n2. Инвойс\n3. ТН ВЭД код\n4. Экспортная декларация\n5. СТ-1 (для Узбекистана и Таджикистана)\n6. Фитосанитарный сертификат (для зерновых)\n7. Транспортные документы (накладная)\n\n⏱ Срок оформления: при наличии всех документов — 1–3 рабочих дня.\n\nПомогаем организовать весь пакет документов. Уточните груз и маршрут.",
      kz: "🏛 Қазақстаннан экспортқа арналған кедендік рәсімдеу.\n\n📄 Қажетті құжаттар:\n1. Контракт\n2. Инвойс\n3. ТН СЭҚ коды\n4. Экспорттық декларация\n5. СТ-1\n6. Фитосанитарлық сертификат\n7. Тасымалдау құжаттары\n\n⏱ Мерзімі: барлық құжаттар болса 1–3 жұмыс күні.\n\nЖүк пен бағытты айтыңыз — барлық құжаттарды ұйымдастырамыз.",
      uz: "🏛 Qozog'istondan eksport uchun bojxona rasmiylashuvi.\n\n📄 Kerakli hujjatlar:\n1. Kontrakt\n2. Invoice\n3. TN VED kodi\n4. Eksport deklaratsiyasi\n5. ST-1\n6. Fitosanitariya sertifikati\n7. Transport hujjatlari\n\n⏱ Muddat: barcha hujjatlar bo'lsa 1–3 ish kuni.\n\nYuk va yo'nalishni ayting — hujjatlar paketini tashkil etaman.",
      tj: "🏛 Расмикунонии гумрукӣ барои содирот аз Қазоқистон.\n\n📄 Ҳуҷҷатҳои лозимӣ:\n1. Шартнома\n2. Инвойс\n3. Рамзи ТН ВЭД\n4. Декларацияи содиротӣ\n5. СТ-1\n6. Гувоҳномаи фитосанитарӣ\n7. Ҳуҷҷатҳои нақлиётӣ\n\n⏱ Мӯҳлат: агар ҳама ҳуҷҷатҳо бошанд — 1–3 рӯзи корӣ.\n\nБор ва масирро гӯед — ҳамаи ҳуҷҷатҳоро ташкил мекунем.",
    },

    faq_doc_contract: {
      ru: "🤝 Контракт и инвойс.\n\n📑 Контракт (договор) оформляем на каждую отправку — включает маршрут, груз, объём, цену, условия оплаты и сроки.\n🔢 Номер контракта присваивается автоматически при оформлении заявки.\n📄 Инвойс (invoice) готовим по данным клиента — наименование товара, объём, цена, реквизиты сторон.\n🧾 Шот-фактура (счёт-фактура) выставляется для казахстанских клиентов в соответствии с НК РК.\n\nВсе документы готовим в рамках одной заявки. Уточните детали — приступим к оформлению.",
      kz: "🤝 Контракт және инвойс.\n\n📑 Контракт (шарт) әрбір жөнелтілімге рәсімделеді.\n🔢 Контракт нөмірі өтінімді тіркеу кезінде автоматты түрде беріледі.\n📄 Инвойс клиент деректері бойынша дайындалады.\n🧾 Шот-фактура ҚР СК талаптарына сай беріледі.\n\nБарлық құжаттарды бір өтінім шеңберінде дайындаймыз.",
      uz: "🤝 Kontrakt va invoice.\n\n📑 Kontrakt har bir jo'natma uchun rasmiylashtiriladi.\n🔢 Kontrakt raqami ariza rasmiy bo'lganda avtomatik beriladi.\n📄 Invoice mijoz ma'lumotlari asosida tayyorlanadi.\n🧾 Hisob-faktura QR NK talablariga muvofiq beriladi.\n\nBarcha hujjatlarni bitta ariza doirasida tayyorlaymiz.",
      tj: "🤝 Шартнома ва инвойс.\n\n📑 Шартнома барои ҳар як интиқол расмӣ мешавад.\n🔢 Рақами шартнома ҳангоми сабти дархост автоматӣ дода мешавад.\n📄 Инвойс тибқи маълумоти муштарӣ омода мешавад.\n🧾 Ҳисоб-фактура мутобиқи НК ҶТ дода мешавад.\n\nҲамаи ҳуҷҷатҳоро дар доираи як дархост тайёр мекунем.",
    },

    faq_doc_packaging: {
      ru: "📦 Требования к упаковке зависят от типа вагона и груза:\n\n🚃 Крытый вагон: зерно в мешках (50 кг, полипропилен), масло в ёмкостях, сахар в мешках, паллетированные грузы с крепёжными ремнями.\n🌾 Хоппер / зерновоз: насыпной груз без упаковки (пшеница, ячмень, кукуруза).\n📦 Контейнер: тарные, паллетированные грузы, возможна насыпь в биг-бэгах.\n\nЕсли не уверены по упаковке — уточните груз, подскажу.",
      kz: "📦 Қаптама талаптары вагон түрі мен жүкке байланысты:\n\n🚃 Жабық вагон: қаптамалы астық, май, қант, паллеттер.\n🌾 Хоппер: үйілмелі жүк (қаптамасыз).\n📦 Контейнер: қаптамалы жүктер, биг-бэгтер.\n\nЖүк туралы айтыңыз — қаптама талаптарын нақтылаймын.",
      uz: "📦 Qadoqlash talablari vagon turi va yukka bog'liq:\n\n🚃 Yopiq vagon: qoplardagi don, moy, shakar, palletlar.\n🌾 Hopper: nasypyu yuk (qadoqsiz).\n📦 Konteyner: tarali yuklar, big-beglar.\n\nYukni ayting — qadoqlash talablarini aniqlayman.",
      tj: "📦 Талабот ба бастабандӣ ба намуди вагон ва бор вобаста аст:\n\n🚃 Вагони пӯшида: ғалла дар халта, равған, шакар, паллетҳо.\n🌾 Хоппер: бори фурӯхта (бе бастабандӣ).\n📦 Контейнер: борҳои тарадӣ, биг-бэгҳо.\n\nБорро гӯед — талаботро равшан мекунам.",
    },

    faq_doc_time: {
      ru: "⏱ Сроки оформления документов:\n\n📜 СТ-1: 1–3 рабочих дня\n🌿 Фитосанитарный сертификат: 1–3 рабочих дня + лабораторный анализ (2–5 дней)\n📋 Экспортная декларация: 1–2 рабочих дня\n🤝 Контракт / Инвойс: 1 рабочий день\n🏛 Таможенное оформление (полный пакет): 3–7 рабочих дней\n\n⚡ При срочной отправке — уточните дату, постараемся ускорить процесс.",
      kz: "⏱ Құжаттарды рәсімдеу мерзімдері:\n\n📜 СТ-1: 1–3 жұмыс күні\n🌿 Фитосанитарлық: 1–3 күн + зертхана (2–5 күн)\n📋 Декларация: 1–2 жұмыс күні\n🤝 Контракт / Инвойс: 1 жұмыс күні\n🏛 Толық пакет: 3–7 жұмыс күні\n\n⚡ Шұғыл жіберілсе — күнді айтыңыз, жеделдетуге тырысамыз.",
      uz: "⏱ Hujjatlarni rasmiylashtirish muddatlari:\n\n📜 ST-1: 1–3 ish kuni\n🌿 Fitosanitariya: 1–3 kun + laboratoriya (2–5 kun)\n📋 Deklaratsiya: 1–2 ish kuni\n🤝 Kontrakt / Invoice: 1 ish kuni\n🏛 To'liq paket: 3–7 ish kuni\n\n⚡ Shoshilinch jo'natish uchun sanani ayting — tezlashtirishga harakat qilamiz.",
      tj: "⏱ Мӯҳлатҳои расмикунонии ҳуҷҷатҳо:\n\n📜 СТ-1: 1–3 рӯзи корӣ\n🌿 Фитосанитарӣ: 1–3 рӯз + озмоишгоҳ (2–5 рӯз)\n📋 Декларатсия: 1–2 рӯзи корӣ\n🤝 Шартнома / Инвойс: 1 рӯзи корӣ\n🏛 Баста пурра: 3–7 рӯзи корӣ\n\n⚡ Барои фиристодани фаврӣ — санаро гӯед, кӯшиш мекунем зудтар анҷом диҳем.",
    },
  };

  const entry = answers[id];
  if (!entry) return null;
  return entry[lang] || entry.ru;
}

// ============================================================
// Отправка интерактивных кнопок (до 3 кнопок)
// ============================================================

async function sendInteractiveButtons(to, bodyText, buttons) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return;

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

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
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((btn) => ({
              type: "reply",
              reply: {
                id: btn.id,
                title: btn.title.substring(0, 20),
              },
            })),
          },
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) console.error("sendInteractiveButtons error:", JSON.stringify(data));
    else console.log(`[BUTTONS] sent to=${to} count=${buttons.length}`);
  } catch (error) {
    console.error("sendInteractiveButtons failed:", error);
  }
}

// ============================================================
// Отправка интерактивного списка (до 10 пунктов)
// ============================================================

async function sendInteractiveList(to, bodyText, buttonLabel, sections) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return;

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

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
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonLabel.substring(0, 20),
            sections: sections.map((section) => ({
              title: (section.title || "").substring(0, 24),
              rows: section.rows.map((row) => ({
                id: row.id,
                title: (row.title || "").substring(0, 24),
                description: (row.description || "").substring(0, 72),
              })),
            })),
          },
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) console.error("sendInteractiveList error:", JSON.stringify(data));
    else console.log(`[LIST] sent to=${to} sections=${sections.length}`);
  } catch (error) {
    console.error("sendInteractiveList failed:", error);
  }
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
    ru: "Понял, беру заявку в работу. Ваш WhatsApp-номер уже сохранён, повторно его писать не нужно. Напишите, пожалуйста, только ваше имя и компанию — зафиксирую данные и подготовлю расчёт.",
    kz: "Түсіндім, өтінімді жұмысқа алдым. WhatsApp-нөміріңіз сақталды, оны қайта жазудың қажеті жоқ. Есептеуді дайындау үшін атыңыз бен компанияңызды жазыңыз.",
    uz: "Tushundim, arizani ishga oldim. WhatsApp raqamingiz saqlandi, uni qayta yozish shart emas. Hisob-kitobni tayyorlash uchun ismingiz va kompaniyangizni yozing.",
    tj: "Фаҳмидам, дархостро ба кор гирифтам. Рақами WhatsApp-и шумо сабт шуд, дубора навиштан лозим нест. Барои омода кардани ҳисоб, ном ва ширкататонро нависед.",
  };

  return texts[lang] || texts.ru;
}

function fallbackReply(lang = "ru") {
  const texts = {
    ru:
      "Спасибо, сообщение получил. Могу зафиксировать заявку и подготовить её к расчёту.\n\n" +
      "Напишите, пожалуйста:\n" +
      "1. Какой груз нужно перевезти?\n" +
      "2. Откуда и куда?\n" +
      "3. Вес в тоннах?\n" +
      "4. Желаемая дата отправки?\n" +
      "5. Ваше имя и компанию.\n\n" +
      "WhatsApp-номер уже сохранён, повторно его писать не нужно.",

    kz:
      "Хабарыңызды алдым. Өтінімді тіркеп, есептеуге дайындай аламын.\n\n" +
      "Жазыңыз, өтінемін:\n" +
      "1. Қандай жүк тасымалдау керек?\n" +
      "2. Қайдан және қайда?\n" +
      "3. Салмағы қанша тонна?\n" +
      "4. Жөнелту күні?\n" +
      "5. Атыңыз және компанияңыз.\n\n" +
      "WhatsApp-нөміріңіз сақталды, қайта жазудың қажеті жоқ.",

    uz:
      "Xabaringizni oldim. Arizangizni qayd qilib, hisob-kitobga tayyorlay olaman.\n\n" +
      "Iltimos, yozing:\n" +
      "1. Qanday yuk tashish kerak?\n" +
      "2. Qayerdan va qayerga?\n" +
      "3. Og'irligi necha tonna?\n" +
      "4. Jo'natish sanasi?\n" +
      "5. Ismingiz va kompaniyangiz.\n\n" +
      "WhatsApp raqamingiz saqlandi, uni qayta yozish shart emas.",

    tj:
      "Паёматонро гирифтам. Метавонам дархостро сабт карда, барои ҳисоб омода кунам.\n\n" +
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
