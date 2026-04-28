// ============================================================
// WhatsApp AI Agent — Railway Freight Export
// Компания: ж/д грузоперевозки, экспорт из Казахстана
// ИИ: Claude (primary) → Gemini (fallback)
// ============================================================

const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ============================================================
// Хранилище истории диалогов (в памяти; для продакшена
// замените на Redis / KV-store — память сбрасывается при рестарте)
// ============================================================
const conversationStore = new Map(); // phone → { messages, lang, leadScore, lastTs }

const HISTORY_TTL_MS   = 30 * 60 * 1000; // 30 минут без активности — сброс
const MAX_HISTORY_TURNS = 10;             // максимум пар user/assistant в памяти

// ============================================================
// Webhook entry point
// ============================================================
export default async function handler(req, res) {
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
    // Сразу отвечаем 200 — Meta не будет делать повторные запросы
    res.status(200).send("EVENT_RECEIVED");
    handleIncomingWebhook(req).catch((err) =>
      console.error("Unhandled webhook error:", err)
    );
    return;
  }

  return res.status(405).send("Method Not Allowed");
}

// ============================================================
// Основная обработка входящего сообщения
// ============================================================
async function handleIncomingWebhook(req) {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    // Статус доставки — игнорируем
    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from    = message.from;

    // Только текстовые сообщения
    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        getUnsupportedTypeReply(getSessionLang(from))
      );
      return;
    }

    const userText = message.text?.body?.trim();
    if (!userText) return;

    console.log(`[IN] from=${from} text="${userText}"`);

    // Получаем / инициализируем сессию
    const session = getOrCreateSession(from);

    // Определяем язык по первому сообщению (или обновляем)
    if (session.messages.length === 0 || session.lang === "ru") {
      const detectedLang = detectLanguage(userText);
      if (detectedLang !== "ru" || session.messages.length === 0) {
        session.lang = detectedLang;
      }
    }

    // Добавляем сообщение пользователя в историю
    appendToHistory(from, "user", userText);

    // Проверяем: хочет ли клиент живого менеджера
    if (wantsHumanAgent(userText)) {
      const reply = getHandoffReply(session.lang);
      appendToHistory(from, "assistant", reply);
      markLeadHot(from);
      await sendWhatsAppMessage(from, reply);
      return;
    }

    // Запрос к ИИ с историей
    const aiReply = await askAI(session);
    appendToHistory(from, "assistant", aiReply);

    // Оценка лида по ответу/запросу
    updateLeadScore(from, userText, aiReply);

    // Если лид горячий — добавляем CRM-заметку в лог (здесь можно вставить API AmoCRM)
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

  console.warn("Both AI unavailable. Using fallback.");
  return fallbackReply(session.lang);
}

// ── Claude ──────────────────────────────────────────────────
async function askClaude(session) {
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing");
    return null;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       CLAUDE_MODEL,
        max_tokens:  700,
        temperature: 0.3,
        system:      getSystemPrompt(session.lang),
        messages:    buildClaudeMessages(session),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", JSON.stringify(data));
      return null;
    }

    const reply = data.content?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(reply) : null;

  } catch (error) {
    console.error("Claude request failed:", error);
    return null;
  }
}

// ── Gemini ──────────────────────────────────────────────────
async function askGemini(session) {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing");
    return null;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: getSystemPrompt(session.lang) }],
        },
        generationConfig: {
          temperature:     0.3,
          maxOutputTokens: 700,
          // Запрещаем markdown-форматирование в ответе
          responseMimeType: "text/plain",
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
        contents: buildGeminiContents(session),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", JSON.stringify(data));
      return null;
    }

    // Обработка блокировки по safety
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY" || finishReason === "RECITATION") {
      console.warn("Gemini blocked response, reason:", finishReason);
      return fallbackReply(session.lang);
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(reply) : null;

  } catch (error) {
    console.error("Gemini request failed:", error);
    return null;
  }
}

// ============================================================
// Форматирование истории для каждой API
// ============================================================

// Claude: массив { role, content } — только последние N пар
function buildClaudeMessages(session) {
  return session.messages.slice(-(MAX_HISTORY_TURNS * 2));
}

// Gemini: role "user" / "model" (не "assistant"), тот же формат
function buildGeminiContents(session) {
  const msgs = session.messages.slice(-(MAX_HISTORY_TURNS * 2));
  return msgs.map((m) => ({
    role:  m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

// ============================================================
// Управление сессией
// ============================================================
function getOrCreateSession(phone) {
  const now = Date.now();
  let session = conversationStore.get(phone);

  // Новая сессия или TTL истёк
  if (!session || now - session.lastTs > HISTORY_TTL_MS) {
    session = {
      phone,
      messages:    [],
      lang:        "ru",
      leadScore:   0,
      crmNotified: false,
      lastTs:      now,
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
  session.messages.push({ role, content });

  // Обрезаем историю чтобы не переполнять память
  if (session.messages.length > MAX_HISTORY_TURNS * 2 + 2) {
    // Сохраняем первое сообщение (приветствие) и удаляем старые середины
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
// Определение языка (русский, казахский, узбекский, таджикский)
// ============================================================
function detectLanguage(text) {
  const lower = text.toLowerCase();

  // Казахский — характерные слова и буквы
  if (/[әіңғүұқөһ]/.test(lower) ||
      /\b(сәлем|рахмет|қайда|жүк|вагон|қанша|жіберу|баға|мерзім)\b/.test(lower)) {
    return "kz";
  }
  // Узбекский
  if (/[ʻʼ]/.test(text) ||
      /\b(salom|rahmat|qayerda|narx|yuk|vagon|jo'natish|xizmat|kerak)\b/.test(lower)) {
    return "uz";
  }
  // Таджикский
  if (/[ӣғқҳҷ]/.test(lower) ||
      /\b(салом|рахмат|куҷо|нарх|бор|вагон|фиристодан|хизмат|лозим)\b/.test(lower)) {
    return "tj";
  }
  return "ru";
}

// ============================================================
// Определение: хочет ли клиент живого менеджера
// ============================================================
function wantsHumanAgent(text) {
  const lower = text.toLowerCase();
  return /\b(менеджер|оператор|человек|живой|хочу позвонить|соедини|перезвони|мне нужен человек|не с ботом|не бот)\b/.test(lower);
}

// ============================================================
// Оценка лида (простая эвристика)
// ============================================================
function updateLeadScore(phone, userText, aiReply) {
  const session = conversationStore.get(phone);
  if (!session) return;

  const lower = userText.toLowerCase();

  // +1 за каждый признак горячего лида
  if (/\b(цена|стоимость|сколько стоит|тариф|расчет|посчитай)\b/.test(lower)) session.leadScore++;
  if (/\b(маршрут|откуда|куда|направление|станция)\b/.test(lower)) session.leadScore++;
  if (/\b(вагон|контейнер|хоппер|крытый|платформа)\b/.test(lower)) session.leadScore++;
  if (/\b(контракт|договор|заявка|оформить|отправить)\b/.test(lower)) session.leadScore++;
  if (/\b(срочно|срочная|быстро|сегодня|завтра|дата отправки)\b/.test(lower)) session.leadScore++;
  if (/\b(тонн|кг|кило|объем|вес|кубов)\b/.test(lower)) session.leadScore++;

  console.log(`[LEAD] phone=${phone} score=${session.leadScore}`);
}

function markLeadHot(phone) {
  const session = conversationStore.get(phone);
  if (session) session.leadScore = 10;
}

// ============================================================
// Уведомление CRM (заглушка — вставьте ваш API AmoCRM / webhook)
// ============================================================
async function notifyCRM(phone, session) {
  const summary = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" | ");

  console.log(`[CRM] HOT LEAD — phone=${phone} lang=${session.lang} summary="${summary}"`);

  // Пример: отправка в AmoCRM через вебхук
  // const CRM_WEBHOOK = process.env.AMOCRM_WEBHOOK_URL;
  // if (CRM_WEBHOOK) {
  //   await fetch(CRM_WEBHOOK, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({ phone, lang: session.lang, messages: summary }),
  //   });
  // }
}

// ============================================================
// Системный промпт (мультиязычный)
// ============================================================
function getSystemPrompt(lang = "ru") {
  const langInstruction = {
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
- железнодорожных перевозках сельскохозяйственной продукции (пшеница, ячмень, кукуруза, рис, сахар, масло, льняное семя, хлопковое семя и др.);
- подборе типа вагона (крытый, хоппер/зерновоз, платформа);
- расчёте тарифов, оформлении контрактов, документации (СТ-1, фитосанитарный сертификат, ТН ВЭД, экспортная декларация, инвойс);
- отслеживании вагонов через систему КТЖ.

РОЛЬ: Ты вежливый, уверенный и профессиональный менеджер. Твоя задача — понять потребность клиента, задать уточняющие вопросы и подготовить заявку для передачи менеджеру.

СТИЛЬ:
- пиши кратко (до 5–7 предложений), понятно, по-деловому;
- не используй Markdown-форматирование (никаких **, ##, таблиц);
- максимум 1 эмодзи на сообщение, только если уместно;
- не называй себя ботом или языковой моделью;
- не давай точных цен без данных — только диапазон или запрашивай детали;
- не гарантируй наличие вагонов без проверки менеджером;
- по документам (ТН ВЭД, кеден, СТ-1) — давай справочную информацию и добавляй «уточните у специалиста»;
- после 3-го вопроса подряд от клиента предлагай передать заявку менеджеру;
- заканчивай каждый ответ вопросом или призывом к действию.

ДАННЫЕ ДЛЯ СБОРА (задавай по 1–2 вопроса за раз, не все сразу):
1. Что нужно перевезти (груз, ТН ВЭД если есть)
2. Откуда (станция / город в Казахстане)
3. Куда (страна, станция назначения)
4. Вес груза (тонн)
5. Тип вагона (крытый / хоппер / не знает)
6. Желаемая дата отправки
7. Нужна ли помощь с документами
8. Имя клиента и компания
9. Контактный номер для менеджера

МАРШРУТЫ И СРОКИ (справочно):
- Казахстан → Узбекистан: 3–5 суток
- Казахстан → Таджикистан: 5–8 суток
- Казахстан → Афганистан: 10–18 суток

ТИПЫ ВАГОНОВ:
- Крытый: 60–68 т, для зерна в мешках, сахара, масла в упаковке
- Хоппер (зерновоз): 60–75 т, для сыпучих (пшеница, ячмень, кукуруза)
- Платформа: для паллет и нестандартных грузов

ДОКУМЕНТЫ (справочно):
- СТ-1 — сертификат происхождения, обязателен для Узбекистана и Таджикистана, оформляет ТПП РК, срок 1–2 дня
- Фито — фитосанитарный сертификат, обязателен на зерно и масличные, срок 1–3 дня
- ТН ВЭД: пшеница 1001, ячмень 1003, сахар 1701, масло подсолнечное 1512
- Экспортную декларацию оформляет таможенный брокер
- Инвойс и счёт-фактуру выставляем мы

ПЕРЕДАЧА МЕНЕДЖЕРУ: Когда клиент запрашивает точный расчёт, упоминает объём и маршрут, или просит контракт — подтверди, что заявка принята, и сообщи, что менеджер свяжется в течение 30 минут (09:00–18:00, Алматы UTC+5).
`.trim();
}

// ============================================================
// Отправка сообщения в WhatsApp
// ============================================================
async function sendWhatsAppMessage(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("WHATSAPP_TOKEN or PHONE_NUMBER_ID is missing");
    return;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      console.error("WhatsApp send error:", JSON.stringify(err));
    } else {
      console.log(`[OUT] sent to=${to} len=${body.length}`);
    }
  } catch (error) {
    console.error("sendWhatsAppMessage failed:", error);
  }
}

// ============================================================
// Вспомогательные тексты (мультиязычные)
// ============================================================
function getUnsupportedTypeReply(lang = "ru") {
  const texts = {
    ru: "Спасибо за сообщение. Пока лучше всего обрабатываю текст. Напишите, что вас интересует: груз, маршрут, тип вагона или документы?",
    kz: "Хабарыңыз үшін рахмет. Мәтіндік хабарларды жақсы өңдеймін. Жүк, маршрут, вагон түрі немесе құжаттар туралы жазыңыз.",
    uz: "Xabringiz uchun rahmat. Hozircha matnli xabarlarni yaxshiroq tushunaman. Yuk, marshrut, vagon turi yoki hujjatlar haqida yozing.",
    tj: "Ташаккур барои паём. Ҳоло матнро беҳтар коркард мекунам. Дар бораи бор, масир, навъи вагон ё ҳуҷҷатҳо нависед.",
  };
  return texts[lang] || texts.ru;
}

function getHandoffReply(lang = "ru") {
  const texts = {
    ru: "Понял, соединяю вас с менеджером. Он напишет в ближайшее время. Если хотите ускорить — укажите ваше имя и компанию.",
    kz: "Түсіндім, сізді менеджермен байланыстырып жатырмын. Ол жақын арада хабарласады. Жеделдету үшін атыңыз бен компанияңызды жазыңыз.",
    uz: "Tushundim, sizni menejer bilan bog'layapman. U yaqin vaqtda yozadi. Tezlashtirishni istasangiz — ism va kompaniyangizni yozing.",
    tj: "Фаҳмидам, шуморо бо менеҷер пайваст мекунам. Ӯ дар наздикӣ менависад. Барои суръат бахшидан — ном ва ширкататонро нависед.",
  };
  return texts[lang] || texts.ru;
}

function fallbackReply(lang = "ru") {
  const texts = {
    ru: `Спасибо за сообщение.

AI-помощник временно недоступен, но я могу принять вашу заявку.

Напишите, пожалуйста:
1. Какой груз нужно перевезти?
2. Откуда и куда?
3. Вес и объём?
4. Желаемая дата отправки?
5. Ваше имя и номер для связи.

Менеджер перезвонит в рабочее время (09:00–18:00, Алматы).`,
    kz: `Хабарыңыз үшін рахмет.

AI-көмекші уақытша қолжетімді емес, бірақ өтінішіңізді қабылдай аламын.

Жазыңыз:
1. Қандай жүк тасымалдау керек?
2. Қайдан және қайда?
3. Салмағы және көлемі?
4. Жөнелту мерзімі?
5. Атыңыз және байланыс нөміріңіз.`,
    uz: `Xabringiz uchun rahmat.

AI-yordamchi vaqtincha mavjud emas, lekin arizangizni qabul qila olaman.

Iltimos, yozing:
1. Qanday yuk tashish kerak?
2. Qayerdan va qayerga?
3. Og'irligi va hajmi?
4. Jo'natish sanasi?
5. Ismingiz va aloqa raqamingiz.`,
    tj: `Ташаккур барои паём.

Ёрдамчии AI муваққатан дастнорас аст, аммо аризаи шуморо қабул карда метавонам.

Лутфан нависед:
1. Кадом борро интиқол додан лозим?
2. Аз куҷо ва ба куҷо?
3. Вазн ва ҳаҷм?
4. Санаи равона кардан?
5. Номи шумо ва рақами тамос.`,
  };
  return texts[lang] || texts.ru;
}

// ============================================================
// Ограничение длины сообщения WhatsApp (max 4096 символов)
// Обрезаем по последнему предложению в пределах лимита
// ============================================================
function limitWhatsAppText(text) {
  const MAX_LENGTH = 1600;
  if (text.length <= MAX_LENGTH) return text;

  const truncated  = text.substring(0, MAX_LENGTH);
  const lastPeriod = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?")
  );

  if (lastPeriod > MAX_LENGTH * 0.7) {
    return truncated.substring(0, lastPeriod + 1);
  }
  return truncated + "...";
}
