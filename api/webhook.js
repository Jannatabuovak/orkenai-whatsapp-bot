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
