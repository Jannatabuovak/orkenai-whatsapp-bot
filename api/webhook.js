// ============================================================
// WhatsApp AI Agent — Железнодорожные грузоперевозки
// Компания: Шымкент, Казахстан
// Стиль: разговорный, без кнопок, поддержка аудио
// ИИ: Claude → Gemini → fallback
// CRM: AmoCRM API v4 (прямая интеграция, без посредников)
// ============================================================

const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN    = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY; // для Whisper (необязательно)

// AmoCRM — прямая интеграция
const AMO_DOMAIN      = process.env.AMO_DOMAIN;       // yourcompany.amocrm.ru (без https://)
const AMO_TOKEN       = process.env.AMO_TOKEN;         // долгосрочный access_token
const AMO_PIPELINE_ID = process.env.AMO_PIPELINE_ID;  // ID воронки (необязательно)

// Excel / Google Sheets через webhook (необязательно)
const EXCEL_WEBHOOK_URL = process.env.EXCEL_WEBHOOK_URL || process.env.GOOGLE_SHEETS_WEBHOOK_URL;
const EXCEL_SECRET      = process.env.EXCEL_SECRET || "";

const MANAGER_PHONE_DOCS  = process.env.MANAGER_PHONE_DOCS  || "87714041276"; // документы
const MANAGER_PHONE_CARGO = process.env.MANAGER_PHONE_CARGO || "87777266948"; // остальное

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// ============================================================
// Память диалогов
// ============================================================

const conversationStore = new Map();
const processedMessages = new Set();

const HISTORY_TTL_MS    = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 10;

// ============================================================
// ДИАГНОСТИКА ПРИ ЗАПУСКЕ
// ============================================================
console.log("[INIT] Проверка переменных окружения:");
console.log(`  ✓ VERIFY_TOKEN: ${VERIFY_TOKEN ? "✅ установлена" : "❌ НЕ установлена"}`);
console.log(`  ✓ WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? "✅ установлена" : "❌ НЕ установлена"}`);
console.log(`  ✓ PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? "✅ установлена" : "❌ НЕ установлена"}`);
console.log(`  ✓ ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "✅ установлена" : "❌ НЕ установлена"}`);
console.log(`  ✓ GEMINI_API_KEY: ${GEMINI_API_KEY ? "✅ установлена" : "❌ НЕ установлена"}`);
console.log(`  ✓ AMO_DOMAIN: ${AMO_DOMAIN ? `✅ ${AMO_DOMAIN}` : "❌ НЕ установлена (AmoCRM недоступна)"}`);
console.log(`  ✓ AMO_TOKEN: ${AMO_TOKEN ? "✅ установлена" : "❌ НЕ установлена (AmoCRM недоступна)"}`);
console.log(`  ✓ EXCEL_WEBHOOK_URL: ${EXCEL_WEBHOOK_URL ? "✅ установлена" : "❌ НЕ установлена"}`);

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
    const body  = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) { console.log("No value in webhook body"); return; }
    if (value.statuses) { console.log("Status event ignored"); return; }

    const messages = value.messages;
    if (!messages || messages.length === 0) { console.log("No messages"); return; }

    const message     = messages[0];
    const messageId   = message.id;
    const from        = message.from;
    if (!from) return;

    const contactName = value.contacts?.[0]?.profile?.name || "";
    console.log(`[CONTACT] phone=${from} name="${contactName}"`);

    if (messageId && processedMessages.has(messageId)) {
      console.log(`Duplicate ignored: ${messageId}`);
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
    session.whatsappName  = contactName || session.whatsappName || "";

    // ── Аудио / голосовое сообщение ───────────────────────────
    if (message.type === "audio" || message.type === "voice") {
      await handleAudioMessage(from, message, session);
      return;
    }

    // ── Неподдерживаемые типы ─────────────────────────────────
    if (message.type !== "text") {
      const reply = getUnsupportedTypeReply(session.lang);
      appendToHistory(from, "assistant", reply);
      await saveToExcel(from, session, "bot_reply", { aiReply: reply, reason: "unsupported_type" });
      await sendWhatsAppMessage(from, reply);
      return;
    }

    // ── Текст ─────────────────────────────────────────────────
    const userText = message.text?.body?.trim();
    if (!userText) return;

    console.log(`[IN] from=${from} text="${userText}"`);

    if (session.messages.length === 0) {
      session.lang = detectLanguage(userText);
    }

    await processUserText(from, session, userText);

  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

// ============================================================
// Обработка аудио/голосового сообщения
// ============================================================

async function handleAudioMessage(from, message, session) {
  const mediaId = message.audio?.id || message.voice?.id;

  if (!mediaId) {
    await sendWhatsAppMessage(from, getAudioErrorReply(session.lang));
    return;
  }

  console.log(`[AUDIO] from=${from} mediaId=${mediaId}`);
  await sendWhatsAppMessage(from, getAudioAckReply(session.lang));

  try {
    const mediaUrl = await getWhatsAppMediaUrl(mediaId);
    if (!mediaUrl) { await sendWhatsAppMessage(from, getAudioErrorReply(session.lang)); return; }

    const audioBuffer = await downloadWhatsAppMedia(mediaUrl);
    if (!audioBuffer) { await sendWhatsAppMessage(from, getAudioErrorReply(session.lang)); return; }

    let transcript = null;
    if (OPENAI_API_KEY)  transcript = await transcribeWithWhisper(audioBuffer, session.lang);
    if (!transcript && GEMINI_API_KEY) transcript = await transcribeWithGemini(audioBuffer, session.lang);

    if (!transcript) { await sendWhatsAppMessage(from, getAudioTranscribeErrorReply(session.lang)); return; }

    console.log(`[AUDIO_TRANSCRIPT] from=${from} text="${transcript}"`);
    await sendWhatsAppMessage(from, getTranscriptNoticeReply(session.lang, transcript));

    if (session.messages.length === 0) session.lang = detectLanguage(transcript);
    await processUserText(from, session, transcript);

  } catch (error) {
    console.error("Audio handling error:", error);
    await sendWhatsAppMessage(from, getAudioErrorReply(session.lang));
  }
}

async function getWhatsAppMediaUrl(mediaId) {
  if (!WHATSAPP_TOKEN) return null;
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    if (!resp.ok) { console.error(`getWhatsAppMediaUrl error: ${resp.status}`); return null; }
    const data = await resp.json();
    return data.url || null;
  } catch (err) { console.error("getWhatsAppMediaUrl failed:", err); return null; }
}

async function downloadWhatsAppMedia(mediaUrl) {
  if (!WHATSAPP_TOKEN) return null;
  try {
    const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    if (!resp.ok) { console.error(`downloadWhatsAppMedia error: ${resp.status}`); return null; }
    return Buffer.from(await resp.arrayBuffer());
  } catch (err) { console.error("downloadWhatsAppMedia failed:", err); return null; }
}

async function transcribeWithWhisper(audioBuffer, lang) {
  if (!OPENAI_API_KEY) return null;
  try {
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
    formData.append("model", "whisper-1");
    if (lang === "kz") formData.append("language", "kk");
    else if (lang === "ru") formData.append("language", "ru");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });
    if (!resp.ok) { console.error("Whisper error:", JSON.stringify(await resp.json())); return null; }
    const text = (await resp.json()).text?.trim();
    console.log("[WHISPER] transcript:", text);
    return text || null;
  } catch (err) { console.error("transcribeWithWhisper failed:", err); return null; }
}

async function transcribeWithGemini(audioBuffer, lang) {
  if (!GEMINI_API_KEY) return null;
  try {
    const langHint = lang === "kz"
      ? "Аудио қазақ немесе орыс тілінде болуы мүмкін. Дәл транскрипция жаса."
      : "Аудио может быть на русском или казахском языке. Транскрибируй точно.";

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: "audio/ogg", data: audioBuffer.toString("base64") } },
            { text: `${langHint} Выдай только транскрипцию без пояснений и без кавычек.` },
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
        }),
      }
    );
    if (!resp.ok) { console.error("Gemini transcribe error:", JSON.stringify(await resp.json())); return null; }
    const text = (await resp.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log("[GEMINI_AUDIO] transcript:", text);
    return text || null;
  } catch (err) { console.error("transcribeWithGemini failed:", err); return null; }
}

// ============================================================
// Обработка текста (единая логика для текста и аудио)
// ============================================================

async function processUserText(from, session, userText) {
  console.log(`\n╔════════════════════════════════════════════`);
  console.log(`║ 📱 Обработка сообщения от ${from}`);
  console.log(`║ Текст: "${userText.substring(0, 60)}..."`);
  console.log(`╚════════════════════════════════════════════\n`);

  appendToHistory(from, "user", userText);
  updateLeadDataFromText(session, userText);
  console.log("[LEAD_DATA]", JSON.stringify(session.leadData));

  await saveToExcel(from, session, "incoming_message", { userText, reason: "incoming_message" });

  // Синхронизировать входящее сообщение в AmoCRM (добавить примечание)
  await syncMessageToAmoCRM(from, session, userText, "incoming_message");

  // ── Ручной тест AmoCRM ────────────────────────────────────
  if (/^тест\s*crm$/i.test(userText) || /^test\s*crm$/i.test(userText)) {
    const ok = await syncToAmoCRM(from, session, "manual_crm_test");
    const reply = ok
      ? "Тест AmoCRM выполнен: контакт и лид созданы. Проверьте свой аккаунт."
      : "Тест не прошёл. Проверьте AMO_DOMAIN и AMO_TOKEN в настройках Vercel.";
    appendToHistory(from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // ── Ручной тест Excel ─────────────────────────────────────
  if (/^тест\s*(excel|эксель|sheet|sheets|таблица)$/i.test(userText)) {
    const saved = await saveToExcel(from, session, "manual_excel_test", { userText, reason: "manual_excel_test" });
    const reply = saved
      ? "Тест Excel выполнен: данные сохранены в таблицу."
      : "Тест не прошёл. Проверьте EXCEL_WEBHOOK_URL.";
    appendToHistory(from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // ── Просьба позвонить / человека ─────────────────────────
  if (wantsHumanAgent(userText)) {
    const reply = getHandoffReply(session.lang);
    appendToHistory(from, "assistant", reply);
    markLeadHot(from);
    await saveToExcel(from, session, "lead", { userText, aiReply: reply, reason: "human_callback_request" });
    await syncToAmoCRM(from, session, "human_callback_request");
    session.crmNotified = true;
    await notifyManager(from, session, "human_callback_request", userText);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // ── AI-ответ ─────────────────────────────────────────────
  const aiReply = await askAI(session);
  appendToHistory(from, "assistant", aiReply);

  await saveToExcel(from, session, "bot_reply", { userText, aiReply, reason: "bot_reply" });

  updateLeadScore(from, userText);

  const aiSaysLeadReady = /заявк.*зафикс|оформляю.*заявк|беру.*в\s+работ|подготов.*расч[её]т|провер.*тариф|наличие.*вагон|проверю.*тариф|расч[её]т.*подготов/i.test(aiReply);

  if ((session.leadScore >= 3 || aiSaysLeadReady) && !session.leadSaved) {
    const savedLead = await saveToExcel(from, session, "lead", { userText, aiReply, reason: "hot_lead" });
    if (savedLead) session.leadSaved = true;

    const sentToCrm = await syncToAmoCRM(from, session, "hot_lead");
    if (sentToCrm) session.crmNotified = true;

    await notifyManager(from, session, "hot_lead", userText);
  }

  await sendWhatsAppMessage(from, aiReply);
}

// ============================================================
// ИИ: Claude → Gemini → fallback
// ============================================================

async function askAI(session) {
  if (ANTHROPIC_API_KEY) {
    const reply = await askClaude(session);
    if (reply) { console.log("[AI_PROVIDER] Claude"); return reply; }
    console.warn("[AI] Claude недоступен, пробую Gemini...");
  }
  const geminiReply = await askGemini(session);
  if (geminiReply) { console.log("[AI_PROVIDER] Gemini"); return geminiReply; }
  console.warn("[AI_PROVIDER] Fallback");
  return fallbackReply(session.lang);
}

async function askClaude(session) {
  if (!ANTHROPIC_API_KEY) return null;
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
        max_tokens: 500,
        temperature: 0.35,
        system: getSystemPrompt(session),
        messages: buildClaudeMessages(session),
      }),
    });
    const data = await response.json();
    if (!response.ok) { console.error("Claude API error:", JSON.stringify(data)); return null; }
    const reply = data.content?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(cleanReply(reply)) : null;
  } catch (err) { console.error("Claude request failed:", err); return null; }
}

async function askGemini(session) {
  if (!GEMINI_API_KEY) return null;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: getSystemPrompt(session) }] },
          generationConfig: { temperature: 0.35, maxOutputTokens: 500, responseMimeType: "text/plain" },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
          ],
          contents: buildGeminiContents(session),
        }),
      }
    );
    const data = await response.json();
    if (!response.ok) { console.error("Gemini API error:", JSON.stringify(data)); return null; }
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY" || finishReason === "RECITATION") { console.warn("Gemini blocked:", finishReason); return null; }
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(cleanReply(reply)) : null;
  } catch (err) { console.error("Gemini request failed:", err); return null; }
}

function buildClaudeMessages(session) {
  return session.messages.slice(-(MAX_HISTORY_TURNS * 2)).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
}

function buildGeminiContents(session) {
  return session.messages.slice(-(MAX_HISTORY_TURNS * 2)).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

// ============================================================
// AMOCRM — прямая интеграция (API v4)
// ============================================================

// Базовый запрос к AmoCRM
async function amoFetch(path, method = "GET", body = null) {
  if (!AMO_DOMAIN || !AMO_TOKEN) {
    console.warn("[AMO] ⚠️ AMO_DOMAIN или AMO_TOKEN не установлены");
    return null;
  }
  try {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${AMO_TOKEN}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const fullUrl = `https://${AMO_DOMAIN}/api/v4${path}`;
    const resp = await fetch(fullUrl, opts);
    if (resp.status === 204) {
      console.log(`[AMO] ${method} ${path} → 204 No Content (успех)`);
      return true;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[AMO] ❌ ${method} ${path} → ${resp.status}`);
      console.error(`[AMO]    Ошибка: ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    console.log(`[AMO] ${method} ${path} → 200 OK`);
    return data;
  } catch (err) {
    console.error(`[AMO] ❌ Запрос упал: ${path}`);
    console.error(`[AMO]    ${err.message}`);
    return null;
  }
}

// Поиск контакта по номеру телефона
async function amoFindContact(phone) {
  const cleaned = phone.replace(/\D/g, "");
  const data = await amoFetch(`/contacts?query=${cleaned}&with=leads&limit=1`);
  return data?._embedded?.contacts?.[0] ?? null;
}

// Создать контакт
async function amoCreateContact({ name, phone, company }) {
  try {
    console.log(`[AMO]    📋 POST /contacts (${name}, ${phone})`);
    const cfv = [{ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] }];
    if (company) cfv.push({ field_code: "COMPANY", values: [{ value: company }] });

    const data = await amoFetch("/contacts", "POST", [{ name: name || phone, custom_fields_values: cfv }]);
    if (!data) {
      console.error(`[AMO]    ❌ API ошибка при создании контакта`);
      return null;
    }
    const contact = data?._embedded?.contacts?.[0];
    if (contact) console.log(`[AMO]    ✅ Контакт #${contact.id} создан`);
    return contact ?? null;
  } catch (err) {
    console.error(`[AMO]    ❌ Ошибка создания контакта:`, err.message);
    return null;
  }
}

// Создать лид и привязать к контакту
async function amoCreateLead({ title, contactId, leadData }) {
  try {
    console.log(`[AMO]    📋 POST /leads (${title})`);
    const body = [{
      name: title,
      tags_to_add: [{ name: "WhatsApp" }],
      _embedded: { contacts: [{ id: contactId }] },
      ...(AMO_PIPELINE_ID ? { pipeline_id: Number(AMO_PIPELINE_ID) } : {}),
    }];

    const data = await amoFetch("/leads", "POST", body);
    if (!data) {
      console.error(`[AMO]    ❌ API ошибка при создании лида`);
      return null;
    }
    const lead = data?._embedded?.leads?.[0];
    if (lead) console.log(`[AMO]    ✅ Лид #${lead.id} создан`);
    return lead ?? null;
  } catch (err) {
    console.error(`[AMO]    ❌ Ошибка создания лида:`, err.message);
    return null;
  }
}

// Добавить примечание с полной перепиской
async function amoAddNote(leadId, text) {
  try {
    console.log(`[AMO] 📝 Добавление примечания к лиду #${leadId}...`);
    const data = await amoFetch(`/leads/${leadId}/notes`, "POST", [{
      entity_id: leadId,
      note_type: "common",
      params: { text },
    }]);
    if (!data) {
      console.error(`[AMO] ❌ Не удалось добавить примечание (API вернула null)`);
      return null;
    }
    const note = data?._embedded?.notes?.[0];
    if (note) console.log(`[AMO] ✅ Примечание #${note.id} добавлено`);
    return note ?? null;
  } catch (err) {
    console.error(`[AMO] ❌ Ошибка добавления примечания:`, err.message);
    return null;
  }
}

// Найти последний открытый лид контакта
async function amoFindLeadByContact(contactId) {
  // Берём контакт с его лидами
  const data = await amoFetch(`/contacts/${contactId}?with=leads`);
  const leads = data?._embedded?.leads;
  if (!leads?.length) return null;
  // Берём самый последний
  return leads[leads.length - 1];
}

// Синхронизация каждого входящего сообщения (добавляет примечание к существующему лиду)
async function syncMessageToAmoCRM(phone, session, userText, reason) {
  try {
    if (!AMO_DOMAIN || !AMO_TOKEN) {
      console.warn(`[AMO] Пропуск синхронизации (${reason}): AMO_DOMAIN или AMO_TOKEN не установлены`);
      return;
    }

    const leadData = session.leadData || {};
    const clientName = leadData.clientName || session.whatsappName || phone;

    // 1. Найти контакт
    let contact = await amoFindContact(phone);
    if (!contact) {
      console.log(`[AMO] ℹ️ Контакт для ${phone} ещё не создан (будет создан при горячей заявке)`);
      return;
    }

    // 2. Найти существующий лид
    let lead = await amoFindLeadByContact(contact.id);
    if (!lead) {
      console.log(`[AMO] ℹ️ Лид для контакта #${contact.id} ещё не создан (будет создан при горячей заявке)`);
      return;
    }

    // 3. Добавить примечание с входящим сообщением
    const noteText = `[${new Date().toLocaleString('ru-RU')}] Клиент: ${userText}`;
    const noteAdded = await amoAddNote(lead.id, noteText);
    if (noteAdded) {
      console.log(`[AMO] ✅ Примечание добавлено к лиду #${lead.id}`);
    } else {
      console.error(`[AMO] ❌ Не удалось добавить примечание к лиду #${lead.id}`);
    }
  } catch (err) {
    console.error("[AMO] ❌ syncMessageToAmoCRM error:", err);
  }
}

// Главная функция синхронизации с AmoCRM
async function syncToAmoCRM(phone, session, reason = "lead") {
  try {
    if (!AMO_DOMAIN || !AMO_TOKEN) {
      console.error("[AMO] ❌ Синхронизация пропущена: AMO_DOMAIN или AMO_TOKEN не установлены");
      return false;
    }

    console.log(`[AMO] 🔄 Синхронизация начата (причина: ${reason})...`);
    const leadData   = session.leadData || {};
    const clientName = leadData.clientName || session.whatsappName || phone;
    const company    = leadData.company || "";

    // 1. Найти или создать контакт
    console.log(`[AMO] 1️⃣ Поиск/создание контакта для ${phone}...`);
    let contact = await amoFindContact(phone);
    let contactCreated = false;
    if (!contact) {
      console.log(`[AMO]    ↳ Контакт не найден, создаю новый...`);
      contact = await amoCreateContact({ name: clientName, phone, company });
      contactCreated = true;
    }
    if (!contact) {
      console.error("[AMO] ❌ Не удалось создать контакт");
      return false;
    }
    console.log(`[AMO]    ✅ Контакт #${contact.id} (${contactCreated ? "создан" : "найден"})`);

    // 2. Найти существующий лид или создать новый
    console.log(`[AMO] 2️⃣ Поиск/создание лида...`);
    let lead = null;
    if (!contactCreated) {
      lead = await amoFindLeadByContact(contact.id);
    }
    if (!lead) {
      console.log(`[AMO]    ↳ Лид не найден, создаю новый...`);
      lead = await amoCreateLead({
        title: buildLeadTitle(leadData, clientName),
        contactId: contact.id,
        leadData,
      });
    }
    if (!lead) {
      console.error("[AMO] ❌ Не удалось создать лид");
      return false;
    }
    console.log(`[AMO]    ✅ Лид #${lead.id}`);

    // 3. Добавить примечание с данными заявки и последними сообщениями
    console.log(`[AMO] 3️⃣ Добавление полной информации заявки...`);
    const noteText = buildAmoNote(session, reason, leadData);
    const noteResult = await amoAddNote(lead.id, noteText);
    if (!noteResult) {
      console.error("[AMO] ⚠️ Примечание не добавлено, но лид создан");
      return true;
    }

    console.log(
      `[AMO] ✅ Готово: контакт #${contact.id}, лид #${lead.id}, причина: ${reason}`
    );
    return true;
  } catch (err) {
    console.error("[AMO] ❌ syncToAmoCRM error:", err.message);
    return false;
  }
}

// Название лида
function buildLeadTitle(leadData, clientName) {
  const parts = [];
  if (leadData.cargo)       parts.push(leadData.cargo);
  if (leadData.origin)      parts.push(leadData.origin);
  if (leadData.destination) parts.push("→ " + leadData.destination);
  return parts.length ? parts.join(" ") : `WhatsApp: ${clientName}`;
}

// Текст примечания — данные заявки + полная переписка с метками времени
function buildAmoNote(session, reason, leadData) {
  const lines = [];
  lines.push(`📱 WhatsApp заявка [${reason}]`);
  lines.push(`Телефон: +${session.whatsappPhone || session.phone}`);
  if (session.whatsappName) lines.push(`Имя в WA: ${session.whatsappName}`);
  lines.push(`Язык: ${session.lang || "ru"} | Score: ${session.leadScore || 0}`);
  lines.push("");

  if (leadData.cargo)         lines.push(`Груз: ${leadData.cargo}`);
  if (leadData.routeType)     lines.push(`Тип маршрута: ${leadData.routeType}`);
  if (leadData.origin)        lines.push(`Откуда: ${leadData.origin}`);
  if (leadData.destination)   lines.push(`Куда: ${leadData.destination}`);
  if (leadData.weight)        lines.push(`Вес: ${leadData.weight}`);
  if (leadData.wagonType)     lines.push(`Вагон: ${leadData.wagonType}`);
  if (leadData.shippingDate)  lines.push(`Дата отправки: ${leadData.shippingDate}`);
  if (leadData.documentsHelp) lines.push(`Документы: ${leadData.documentsHelp}`);
  if (leadData.company)       lines.push(`Компания: ${leadData.company}`);
  lines.push("");

  lines.push("─── Полная переписка (все сообщения) ───");
  for (const m of session.messages) {
    const who = m.role === "assistant" ? "Бот" : "Клиент";
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('ru-RU') : "--:--:--";
    lines.push(`[${time}] ${who}: ${m.content}`);
  }

  return lines.join("\n");
}

// ============================================================
// Excel / Google Sheets
// ============================================================

async function saveToExcel(phone, session, eventType, options = {}) {
  if (!EXCEL_WEBHOOK_URL) {
    console.warn("[EXCEL] ❌ EXCEL_WEBHOOK_URL не установлена - данные не сохраняются");
    return false;
  }

  const dialogText   = session.messages.map((m) => {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('ru-RU') : "--:--:--";
    return `[${time}] ${m.role === "assistant" ? "Бот" : "Клиент"}: ${m.content}`;
  }).join("\n");
  const userMessages = session.messages.filter((m) => m.role === "user").map((m) => m.content).join(" | ");

  const payload = {
    secret: EXCEL_SECRET, eventType,
    timestamp: new Date().toISOString(),
    phone,
    whatsapp_phone: session.whatsappPhone || phone,
    whatsapp_name:  session.whatsappName  || "",
    lang:           session.lang,
    leadScore:      session.leadScore || 0,
    leadData:       session.leadData  || {},
    userText:       options.userText  || "",
    aiReply:        options.aiReply   || "",
    reason:         options.reason    || "",
    messages:       userMessages,
    dialogText,
  };

  try {
    console.log(`[EXCEL] 📤 Отправка данных (${eventType})...`);
    const resp = await fetch(EXCEL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`[EXCEL] ❌ Ошибка ${resp.status}: не удалось отправить данные`);
      return false;
    }
    console.log(`[EXCEL] ✅ Данные сохранены (${eventType})`);
    return true;
  } catch (err) {
    console.error("[EXCEL] ❌ Ошибка запроса:", err.message);
    return false;
  }
}

// ============================================================
// Управление сессией
// ============================================================

function getOrCreateSession(phone) {
  const now     = Date.now();
  let   session = conversationStore.get(phone);

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
        routeType: "", cargo: "", origin: "", destination: "",
        weight: "", wagonType: "", shippingDate: "",
        documentsHelp: "", clientName: "", company: "",
      },
    };
    conversationStore.set(phone, session);
  } else {
    session.lastTs = now;
    if (!session.leadData) {
      session.leadData = {
        routeType: "", cargo: "", origin: "", destination: "",
        weight: "", wagonType: "", shippingDate: "",
        documentsHelp: "", clientName: "", company: "",
      };
    }
    if (typeof session.leadSaved === "undefined") session.leadSaved = false;
  }

  return session;
}

function appendToHistory(phone, role, content) {
  const session = conversationStore.get(phone);
  if (!session) {
    console.error(`[HISTORY] ⚠️ Сессия ${phone} не найдена`);
    return;
  }
  session.messages.push({ role, content, timestamp: new Date().toISOString() });
  console.log(`[HISTORY] 💬 ${role === "assistant" ? "Бот" : "Клиент"}: "${content.substring(0, 50)}..."`);
  if (session.messages.length > MAX_HISTORY_TURNS * 2 + 2) {
    session.messages = [session.messages[0], ...session.messages.slice(-(MAX_HISTORY_TURNS * 2))];
  }
}

// ============================================================
// Память по заявке
// ============================================================

function updateLeadDataFromText(session, text) {
  if (!session.leadData) {
    session.leadData = {
      routeType: "", cargo: "", origin: "", destination: "",
      weight: "", wagonType: "", shippingDate: "",
      documentsHelp: "", clientName: "", company: "",
    };
  }

  const lower = text.toLowerCase();

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк|внутри\s+рк|қазақстан\s+бойынша|ішінде/.test(lower)) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану";
  }

  const cargoMatch = lower.match(
    /(пшениц[ауы]?|ячмен[ья]?|кукуруз[ауы]?|рис|сахар|масл[оа]|подсолнечн[а-я\s]*масл[оа]|лен|льнян[а-я\s]*сем[яе]|хлопков[а-я\s]*сем[яе]|зерно|мук[ауы]?|цемент|уголь|металл|оборудовани[ея]|паллет[а-я]*|стройматериал[а-я]*|техника|груз|бидай|арпа|жүгері|күріш|қант|май)/
  );
  if (cargoMatch) session.leadData.cargo = cargoMatch[0];

  const weightMatch = lower.match(/(\d+[.,]?\d*)\s*(тонн|тонна|тонны|т\b|кг|килограмм|килограммов|тонна|тонналық)/);
  if (weightMatch) session.leadData.weight = `${weightMatch[1]} ${weightMatch[2]}`;

  if (/хоппер|зерновоз/.test(lower))             session.leadData.wagonType = "хоппер / зерновоз";
  else if (/крыт/.test(lower))                    session.leadData.wagonType = "крытый вагон";
  else if (/платформ/.test(lower))                session.leadData.wagonType = "платформа";
  else if (/контейнер/.test(lower))               session.leadData.wagonType = "контейнер";
  else if (/не\s*знаю|какой\s+вагон/.test(lower)) session.leadData.wagonType = "нужно подобрать";

  if (/послезавтра/.test(lower))                  session.leadData.shippingDate = "послезавтра";
  else if (/завтра/.test(lower))                  session.leadData.shippingDate = "завтра";
  else if (/сегодня/.test(lower))                 session.leadData.shippingDate = "сегодня";
  else if (/следующ[а-я]+\s+недел/.test(lower))   session.leadData.shippingDate = "на следующей неделе";
  else {
    const dateMatch = lower.match(/(\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?)/);
    if (dateMatch) session.leadData.shippingDate = dateMatch[1];
  }

  const routeMatch = text.match(/(?:из|от)\s+(.+?)\s+(?:в|до|на)\s+(.+?)(?:[.,!?;]|$)/i);
  if (routeMatch) {
    session.leadData.origin      = cleanPlaceName(routeMatch[1]);
    session.leadData.destination = cleanPlaceName(routeMatch[2]);
  }

  fillKnownCityRoute(session, lower);
  detectRouteType(session, lower);

  const lastAssistant      = getLastAssistantMessage(session);
  const assistantAskedDocs = /документ|ст-1|ст1|фито|сертификат|деклараци|инвойс|тн\s*вэд/i.test(lastAssistant);

  if (assistantAskedDocs && /^(нет|не нужно|не надо|без документов|нет спасибо|жоқ)$/i.test(text.trim())) {
    session.leadData.documentsHelp = "не нужна помощь с документами";
  } else if (/помощь\s+с\s+документами\s+не\s+нужн|документы\s+не\s+нужны|без\s+документов/.test(lower)) {
    session.leadData.documentsHelp = "не нужна помощь с документами";
  } else if (/нужн[аоы]?\s+.*документ|ст-1|фито|сертификат|деклараци|инвойс|тн\s*вэд/.test(lower)) {
    session.leadData.documentsHelp = "нужна помощь с документами";
  }

  const nameMatch = text.match(/(?:меня зовут|я\s+|имя\s+|менің атым\s+|мені\s+)([А-ЯЁA-ZӘІҢҒҮҰҚӨҺ][а-яёa-zәіңғүұқөһ]{2,20})/i);
  if (nameMatch) session.leadData.clientName = nameMatch[1];
  else if (!session.leadData.clientName && session.whatsappName) {
    session.leadData.clientName = session.whatsappName;
  }

  const companyMatch = text.match(/(?:компания|тоо|ип|ТОО|ИП|ЖШС)\s+([А-ЯЁA-Z0-9а-яёa-zәіңғүұқөһ\s"«»._-]{2,60})/i);
  if (companyMatch) session.leadData.company = companyMatch[0].trim();
}

function fillKnownCityRoute(session, lower) {
  const cityMap = [
    ["алматы","Алматы"],["астана","Астана"],["нур-султан","Астана"],["нұр-сұлтан","Астана"],
    ["шымкент","Шымкент"],["шимкент","Шымкент"],["туркестан","Туркестан"],["түркістан","Туркестан"],
    ["кызылорда","Кызылорда"],["қызылорда","Кызылорда"],["тараз","Тараз"],["жамбыл","Тараз"],
    ["актобе","Актобе"],["ақтөбе","Актобе"],["атырау","Атырау"],["актау","Актау"],["ақтау","Актау"],
    ["костанай","Костанай"],["қостанай","Костанай"],["павлодар","Павлодар"],["семей","Семей"],
    ["усть-каменогорск","Усть-Каменогорск"],["оскемен","Усть-Каменогорск"],["өскемен","Усть-Каменогорск"],
    ["кокшетау","Кокшетау"],["көкшетау","Кокшетау"],["петропавловск","Петропавловск"],
    ["уральск","Уральск"],["орал","Уральск"],["ташкент","Ташкент"],["душанбе","Душанбе"],
    ["афганистан","Афганистан"],["узбекистан","Узбекистан"],["таджикистан","Таджикистан"],
    ["mazar","Мазари-Шариф"],["мазари-шариф","Мазари-Шариф"],["хайратон","Хайратон"],["термез","Термез"],
  ];

  for (const [raw, nice] of cityMap) {
    const fromRe = new RegExp(`(?:из|от)\\s+${escapeRegExp(raw)}\\b`, "i");
    const toRe   = new RegExp(`(?:в|до|на)\\s+${escapeRegExp(raw)}\\b`, "i");
    if (!session.leadData.origin      && fromRe.test(lower)) session.leadData.origin      = nice;
    if (!session.leadData.destination && toRe.test(lower))   session.leadData.destination = nice;
  }
}

function detectRouteType(session, lower = "") {
  const origin      = normalizeForCompare(session.leadData.origin);
  const destination = normalizeForCompare(session.leadData.destination);

  const kzCities = [
    "алматы","астана","шымкент","туркестан","кызылорда","тараз","актобе",
    "атырау","актау","костанай","павлодар","семей","усть-каменогорск","кокшетау","петропавловск","уральск",
  ];
  const exportPlaces = ["ташкент","узбекистан","душанбе","таджикистан","афганистан","мазари-шариф","хайратон","термез"];

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк|қазақстан\s+бойынша/.test(lower)) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану"; return;
  }
  if (exportPlaces.some((p) => destination.includes(p))) {
    session.leadData.routeType = "экспортная / международная перевозка"; return;
  }
  if (kzCities.some((c) => origin.includes(c)) && kzCities.some((c) => destination.includes(c))) {
    session.leadData.routeType = "внутренняя перевозка по Казахстану"; return;
  }
  if (!session.leadData.routeType && destination) {
    session.leadData.routeType = "тип маршрута нужно уточнить";
  }
}

function getLastAssistantMessage(session) {
  const msgs = session.messages.filter((m) => m.role === "assistant");
  return msgs.length ? msgs[msgs.length - 1].content || "" : "";
}

function cleanPlaceName(value) {
  return String(value || "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\b(вес|нужен|нужна|нужно|отправка|отправить|сегодня|завтра|послезавтра|хоппер|крытый|платформа|контейнер|вагон|тонн|тонна|тонны|кг|килограмм|стоимость|цена|посчитайте|расч[её]т).*$/i, "")
    .replace(/\s+/g, " ").trim();
}

function normalizeForCompare(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLeadDataSummary(session) {
  const data = session.leadData || {};
  const known = [], missing = [];

  if (data.routeType)     known.push(`тип маршрута: ${data.routeType}`);    else missing.push("тип маршрута");
  if (data.cargo)         known.push(`груз: ${data.cargo}`);                 else missing.push("груз");
  if (data.origin)        known.push(`откуда: ${data.origin}`);              else missing.push("откуда");
  if (data.destination)   known.push(`куда: ${data.destination}`);           else missing.push("куда");
  if (data.weight)        known.push(`вес: ${data.weight}`);                 else missing.push("вес");
  if (data.wagonType)     known.push(`тип вагона: ${data.wagonType}`);       else missing.push("тип вагона");
  if (data.shippingDate)  known.push(`дата отправки: ${data.shippingDate}`); else missing.push("дата отправки");
  if (data.documentsHelp) known.push(`документы: ${data.documentsHelp}`);   else missing.push("нужна ли помощь с документами");
  if (data.clientName)    known.push(`имя: ${data.clientName}`);             else missing.push("имя клиента");
  if (data.company)       known.push(`компания: ${data.company}`);           else missing.push("компания");

  return {
    knownText:   known.length   ? known.join("; ")   : "пока нет данных",
    missingText: missing.length ? missing.join(", ") : "все основные данные собраны",
  };
}

// ============================================================
// Определение языка
// ============================================================

function detectLanguage(text) {
  const lower = text.toLowerCase();
  if (
    /[әіңғүұқөһ]/.test(lower) ||
    /\b(сәлем|рахмет|қайда|жүк|вагон|қанша|жіберу|баға|мерзім|керек|бидай|арпа|қазақ|тасымал|жөнелту)\b/.test(lower)
  ) return "kz";
  if (
    /[ʻʼ]/.test(text) ||
    /\b(salom|rahmat|qayerda|narx|yuk|vagon|jo'natish|xizmat|kerak)\b/.test(lower)
  ) return "uz";
  return "ru";
}

// ============================================================
// Просьба позвонить / человека
// ============================================================

function wantsHumanAgent(text) {
  return /\b(оператор|человек|живой|хочу позвонить|соедини|перезвони|мне нужен человек|не с ботом|не бот|свяжитесь|позвоните|адам|тірі|қоңырау)\b/i.test(text);
}

// ============================================================
// Определение темы — документы или перевозка
// ============================================================

function isDocumentationRequest(session, userText = "") {
  const lower = userText.toLowerCase();
  const lastMessages = session.messages.slice(-6).map((m) => m.content.toLowerCase()).join(" ");
  const docKeywords = /\b(документ|ст-1|ст1|фито|фитосанитар|сертификат|деклараци|инвойс|тн\s*вэд|разрешени|лицензи|таможн|оформлени|бумаг|накладн|акт|договор|контракт|счёт|счет\s+факт)\b/;
  return docKeywords.test(lower) || docKeywords.test(lastMessages) || session.leadData?.documentsHelp === "нужна помощь с документами";
}

// ============================================================
// Уведомление менеджера в WhatsApp
// ============================================================

async function notifyManager(phone, session, reason = "hot_lead", userText = "") {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return;

  const data = session.leadData || {};
  const name = data.clientName || session.whatsappName || "не указано";

  const isDoc       = isDocumentationRequest(session, userText);
  const targetPhone = isDoc ? MANAGER_PHONE_DOCS : MANAGER_PHONE_CARGO;
  const topicLabel  = isDoc ? "📋 Вопрос по документам" : "🚂 Грузоперевозка";

  const lines = [
    `🔔 Новая заявка (${reason})`,
    `${topicLabel}`,
    ``,
    `👤 Клиент:  ${name}`,
    data.company   ? `🏢 Компания:  ${data.company}` : null,
    `📞 Телефон: +${phone}`,
    `🌐 Язык:    ${session.lang || "ru"}`,
    ``,
    `📦 Груз:       ${data.cargo         || "—"}`,
    `📍 Откуда:     ${data.origin        || "—"}`,
    `📍 Куда:       ${data.destination   || "—"}`,
    `⚖️  Вес:        ${data.weight        || "—"}`,
    `🚃 Вагон:      ${data.wagonType     || "—"}`,
    `📅 Дата:       ${data.shippingDate  || "—"}`,
    `📄 Документы:  ${data.documentsHelp || "—"}`,
    ``,
    `🏆 Score: ${session.leadScore || 0}`,
  ].filter((l) => l !== null).join("\n");

  await sendWhatsAppMessage(targetPhone, lines);
  console.log(`[MANAGER_NOTIFY] Тема: ${topicLabel} → отправлено на ${targetPhone}`);
}

// ============================================================
// Оценка лида
// ============================================================

function updateLeadScore(phone, userText) {
  const session = conversationStore.get(phone);
  if (!session) return;
  const lower = userText.toLowerCase();
  let added = 0;
  if (/\b(цена|стоимость|сколько стоит|тариф|расчет|расчёт|посчитай|баға|қанша)\b/.test(lower))  added++;
  if (/\b(маршрут|откуда|куда|направление|станция|по казахстану|шымкент|алматы|астана|туркестан|ташкент|душанбе|афганистан)\b/.test(lower))  added++;
  if (/\b(вагон|контейнер|хоппер|крытый|платформа|зерновоз)\b/.test(lower))  added++;
  if (/\b(контракт|договор|заявка|оформить|отправить|перевезти|жіберу|тасымалдау)\b/.test(lower)) added++;
  if (/\b(срочно|срочная|быстро|сегодня|завтра|дата отправки|шұғыл)\b/.test(lower))               added++;
  if (/\b(тонн|тонна|кг|кило|объем|объём|вес|тонна|тонналық)\b/.test(lower))                     added++;
  session.leadScore += added;
  console.log(`[LEAD] phone=${phone} added=${added} score=${session.leadScore}`);
}

function markLeadHot(phone) {
  const session = conversationStore.get(phone);
  if (session) session.leadScore = 10;
}

// ============================================================
// Системный промпт
// ============================================================

function getSystemPrompt(session = {}) {
  const lang = session.lang || "ru";

  const langInstruction = {
    ru: "Отвечай ТОЛЬКО на русском языке. Пиши так, как говорят в Казахстане — по-простому, живо, не официально.",
    kz: "Жауапты ТЕК қазақ тілінде бер. Табиғи, ауызекі тілмен жаз — іскерлік болсын, бірақ достық та болсын.",
    uz: "Faqat O'zbek tilida javob ber. Oddiy va do'stona uslubda yoz.",
  }[lang] || "Отвечай ТОЛЬКО на русском языке.";

  const profileName = session.whatsappName || "";
  const phone       = session.whatsappPhone || session.phone || "";
  const leadMemory  = buildLeadDataSummary(session);

  return `
Ты — Арман, менеджер по грузоперевозкам компании из Шымкента. Занимаешься железнодорожными перевозками по Казахстану и на экспорт.

ЯЗЫК: ${langInstruction}

Данные клиента из WhatsApp:
- Номер уже определён: ${phone || "из webhook"}
- Имя из профиля: ${profileName || "не указано"}
- Номер телефона повторно НЕ спрашивай.
- Имя без нужды в ответе не упоминай.

Память по заявке:
- Уже есть: ${leadMemory.knownText}
- Ещё не хватает: ${leadMemory.missingText}

Критические правила:
- Никогда не задавай повторно вопросы по тому, что уже есть в блоке "Уже есть".
- Если данных достаточно для расчёта — не тяни, фиксируй заявку.
- Максимум 1–2 вопроса за раз.
- Не говори "передам менеджеру", "менеджер свяжется" — ты сам и есть менеджер.
- Не упоминай, что ты бот, AI или языковая модель.
- Если клиент напрямую спросит "вы человек?" или "это бот?" — скажи:
  "Я виртуальный помощник компании, принимаю заявки и готовлю расчёты. Всё что напишете — попадёт к нам сразу."
- Не используй Markdown, звёздочки, решётки и т.п.

Стиль общения:
- Пиши как живой человек — без канцелярщины.
- Можно использовать: "понял", "ок", "давайте так", "смотри", "вот в чём дело", "без проблем".
- Не начинай каждый ответ одинаково — варьируй.
- Сначала коротко подтверди, что понял — потом уточняй.
- Не пиши "чем могу помочь" если клиент уже описал задачу.
- Отвечай по существу, без воды.

Компания работает в Шымкенте и занимается:
- жд перевозками по всему Казахстану (между городами, станциями, элеваторами);
- экспортом в Узбекистан, Таджикистан, Афганистан;
- перевозкой зерна (пшеница, ячмень, кукуруза), масла, сахара, прочих грузов;
- подбором вагонов: крытый, хоппер/зерновоз, платформа, контейнер;
- расчётом тарифа по маршруту, весу, типу груза и дате;
- оформлением заявок, договоров, счетов и сопроводительных документов;
- отслеживанием вагонов через систему КТЖ.

Маршруты и сроки (справочно):
- Внутри Казахстана: зависит от маршрута, точно скажем после проверки.
- Казахстан → Узбекистан: 3–5 суток.
- Казахстан → Таджикистан: 5–8 суток.
- Казахстан → Афганистан: 10–18 суток.

Вагоны (справочно):
- Крытый вагон: 60–68 т (зерно в мешках, сахар, масло, паллеты).
- Хоппер / зерновоз: 60–75 т (пшеница, ячмень, кукуруза насыпью).
- Платформа: оборудование, техника, нестандартные грузы.
- Контейнер: тарные и сборные грузы.

По маршруту:
- Если маршрут внутри Казахстана — не называй перевозку экспортной.
- Для внутренних маршрутов СТ-1, декларация и ТН ВЭД не нужны — не спрашивай про них.
- Документы по экспорту (СТ-1, фито, декларация) — только для международных направлений.

Данные для заявки (собирай по ходу разговора):
1. Что перевозим (груз)
2. Откуда (город / станция)
3. Куда (город / страна)
4. Вес в тоннах
5. Тип вагона (если знает)
6. Дата отправки
7. Нужна ли помощь с документами
8. Имя и компания (если ещё нет)
9. Телефон НЕ спрашивай — он уже есть из WhatsApp.

Примеры живых фраз:
- "Понял, пшеница из Шымкента в Ташкент. Сколько тонн планируете?"
- "Ок, смотрю по этому маршруту. Дата отправки примерно когда?"
- "Зафиксировал, сейчас проверю тариф и наличие вагонов."
- "Без проблем, оформляю заявку."
- "По этим данным уже можно посчитать, уточню тариф и напишу."

Если не хватает имени / компании:
"Основные данные есть. Напишите имя и компанию — зафиксирую и подготовлю расчёт."

Если всё есть:
"Отлично, заявку зафиксировал. Проверю тариф и наличие вагона, скоро напишу."

Если клиент просит договор:
"Хорошо, оформляю. Проверю тариф, наличие вагона — данные подготовлю для договора."

Рабочее время: 09:00–18:00, Шымкент (UTC+5).
`.trim();
}

// ============================================================
// Отправка сообщения в WhatsApp
// ============================================================

async function sendWhatsAppMessage(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error("WHATSAPP_TOKEN или PHONE_NUMBER_ID отсутствуют");
    return;
  }
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
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
          text: { preview_url: false, body },
        }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) { console.error("WhatsApp send error:", JSON.stringify(data)); return; }
    console.log(`[OUT] to=${to} len=${body.length}`);
  } catch (err) { console.error("sendWhatsAppMessage failed:", err); }
}

// ============================================================
// Ответы без AI
// ============================================================

function getUnsupportedTypeReply(lang = "ru") {
  return {
    ru: "Это получил, но пока текст обрабатываю лучше всего. Напиши — какой груз и по какому маршруту?",
    kz: "Алдым, бірақ мәтіндік хабарларды жақсы өңдеймін. Жазып жіберіңіз — қандай жүк, қай бағыт?",
    uz: "Oldim, lekin matnni yaxshiroq tushunaman. Yozing — qanday yuk va qaysi yo'nalish?",
  }[lang] || "Это получил, но напиши лучше текстом — что за груз и откуда-куда?";
}

function getHandoffReply(lang = "ru") {
  return {
    ru: "Понял, беру в работу. Ваш номер уже сохранён. Напишите имя и компанию — зафиксирую заявку и подготовлю данные.",
    kz: "Түсіндім, жұмысқа алдым. Нөміріңіз сақталды. Атыңыз бен компанияңызды жазыңыз — өтінімді тіркеймін.",
    uz: "Tushundim, ishga oldim. Raqamingiz saqlandi. Ism va kompaniyangizni yozing — arizani qayd qilaman.",
  }[lang] || "Понял, беру в работу. Напишите имя и компанию.";
}

function fallbackReply(lang = "ru") {
  return {
    ru: "Получил, зафиксирую заявку. Напишите:\n1. Что везём?\n2. Откуда и куда?\n3. Вес в тоннах?\n4. Когда отправка?\n5. Ваше имя и компания.\n\nТелефон уже есть — повторно писать не нужно.",
    kz: "Алдым, өтінімді тіркеймін. Жазыңыз:\n1. Не тасымалдаймыз?\n2. Қайдан және қайда?\n3. Салмағы?\n4. Жөнелту күні?\n5. Атыңыз бен компанияңыз.\n\nНөмір бар — қайта жазпаңыз.",
    uz: "Oldim, arizani qayd qilaman. Yozing:\n1. Nima tashiymiz?\n2. Qayerdan va qayerga?\n3. Og'irlik?\n4. Jo'natish sanasi?\n5. Ism va kompaniya.\n\nRaqam bor — qayta yozish shart emas.",
  }[lang] || "Получил, зафиксирую заявку. Напишите: груз, маршрут, вес, дату отправки, имя и компанию.";
}

function getAudioAckReply(lang = "ru") {
  return { ru: "Голосовое получил, сейчас прослушаю и отвечу.", kz: "Дауыстық хабарды алдым, тыңдап жатырмын.", uz: "Ovozli xabarni oldim, tinglayapman." }[lang] || "Голосовое получил, сейчас обработаю.";
}

function getAudioErrorReply(lang = "ru") {
  return { ru: "Что-то пошло не так с аудио. Напиши, пожалуйста, текстом — так быстрее разберёмся.", kz: "Аудиомен бірдеңе болды. Мәтін арқылы жазыңызшы — тезірек шешеміз.", uz: "Audio bilan muammo chiqdi. Matn orqali yozing — tezroq hal qilamiz." }[lang] || "Не смог обработать аудио. Напишите текстом.";
}

function getAudioTranscribeErrorReply(lang = "ru") {
  return { ru: "Голосовое не разобрал — может, качество связи. Напиши текстом, что нужно — отвечу быстро.", kz: "Дауыстықты анықтай алмадым — байланыс сапасы болар. Мәтін арқылы жазыңыз.", uz: "Ovozni tushuna olmadim — aloqa sifati sabab bo'lishi mumkin. Matn orqali yozing." }[lang] || "Не удалось распознать аудио. Напишите текстом.";
}

function getTranscriptNoticeReply(lang = "ru", transcript) {
  const short = transcript.length > 120 ? transcript.substring(0, 120) + "..." : transcript;
  return { ru: `Понял вас: "${short}"`, kz: `Сізді түсіндім: "${short}"`, uz: `Tushundim: "${short}"` }[lang] || `Понял: "${short}"`;
}

function cleanReply(text) {
  return text.replace(/\*\*/g, "").replace(/#{1,6}\s/g, "").replace(/\|/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function limitWhatsAppText(text) {
  const MAX = 1400;
  if (text.length <= MAX) return text;
  const truncated       = text.substring(0, MAX);
  const lastSentenceEnd = Math.max(truncated.lastIndexOf("."), truncated.lastIndexOf("!"), truncated.lastIndexOf("?"));
  if (lastSentenceEnd > MAX * 0.7) return truncated.substring(0, lastSentenceEnd + 1);
  return truncated + "...";
}
