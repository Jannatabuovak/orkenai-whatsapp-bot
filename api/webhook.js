// ============================================================
// WhatsApp AI Agent — Мультиномерной режим
// Поддерживает несколько номеров через один webhook
// ИИ: Claude → Gemini → fallback
// CRM: AmoCRM API v4
// ============================================================

// ============================================================
// КОНФИГИ ДЛЯ КАЖДОГО НОМЕРА
// Добавьте новый номер — просто добавьте блок ниже
// ============================================================

const PHONE_CONFIGS = {

  // ── Номер 1: Грузоперевозки (старый номер) ────────────────
  [process.env.PHONE_NUMBER_ID_CARGO]: {
    label:          "CARGO",
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN_CARGO,
    PHONE_NUMBER_ID:process.env.PHONE_NUMBER_ID_CARGO,
    AMO_DOMAIN:     process.env.AMO_DOMAIN_CARGO,
    AMO_TOKEN:      process.env.AMO_TOKEN_CARGO,
    AMO_PIPELINE_ID:process.env.AMO_PIPELINE_ID_CARGO,
    EXCEL_WEBHOOK_URL: process.env.EXCEL_WEBHOOK_URL_CARGO || process.env.EXCEL_WEBHOOK_URL,
    EXCEL_SECRET:   process.env.EXCEL_SECRET_CARGO || process.env.EXCEL_SECRET || "",
    MANAGER_PHONE_DOCS:  process.env.MANAGER_PHONE_DOCS  || "87714041276",
    MANAGER_PHONE_CARGO: process.env.MANAGER_PHONE_CARGO || "87777266948",
    PROMPT_KEY:     "cargo",
  },

  // ── Номер 2: Анара (603822019473868) ──────────────────────
  [process.env.PHONE_NUMBER_ID_ANARA]: {
    label:          "ANARA",
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN_ANARA,
    PHONE_NUMBER_ID:process.env.PHONE_NUMBER_ID_ANARA,
    AMO_DOMAIN:     process.env.AMO_DOMAIN_ANARA,
    AMO_TOKEN:      process.env.AMO_TOKEN_ANARA,
    AMO_PIPELINE_ID:process.env.AMO_PIPELINE_ID_ANARA,
    EXCEL_WEBHOOK_URL: process.env.EXCEL_WEBHOOK_URL_ANARA || process.env.EXCEL_WEBHOOK_URL,
    EXCEL_SECRET:   process.env.EXCEL_SECRET_ANARA || process.env.EXCEL_SECRET || "",
    MANAGER_PHONE_DOCS:  process.env.MANAGER_PHONE_ANARA || "",
    MANAGER_PHONE_CARGO: process.env.MANAGER_PHONE_ANARA || "",
    PROMPT_KEY:     "anara",
  },

};

// ── Общие ключи (одни для всех номеров) ───────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL      || "claude-sonnet-4-20250514";
const GEMINI_MODEL      = process.env.GEMINI_MODEL      || "gemini-2.5-flash-lite";

// ============================================================
// Диагностика при запуске
// ============================================================

console.log("[INIT] Проверка переменных окружения:");
console.log(`  VERIFY_TOKEN:           ${VERIFY_TOKEN      ? "✅" : "❌"}`);
console.log(`  ANTHROPIC_API_KEY:      ${ANTHROPIC_API_KEY ? "✅" : "❌"}`);
console.log(`  GEMINI_API_KEY:         ${GEMINI_API_KEY    ? "✅" : "❌"}`);
console.log(`  PHONE_NUMBER_ID_CARGO:  ${process.env.PHONE_NUMBER_ID_CARGO  ? "✅ " + process.env.PHONE_NUMBER_ID_CARGO  : "❌"}`);
console.log(`  WHATSAPP_TOKEN_CARGO:   ${process.env.WHATSAPP_TOKEN_CARGO   ? "✅" : "❌"}`);
console.log(`  PHONE_NUMBER_ID_ANARA:  ${process.env.PHONE_NUMBER_ID_ANARA  ? "✅ " + process.env.PHONE_NUMBER_ID_ANARA  : "❌"}`);
console.log(`  WHATSAPP_TOKEN_ANARA:   ${process.env.WHATSAPP_TOKEN_ANARA   ? "✅" : "❌"}`);

// ============================================================
// Память диалогов
// ============================================================

const conversationStore = new Map();   // ключ: `${phoneNumberId}:${from}`
const processedMessages = new Set();

const HISTORY_TTL_MS    = 30 * 60 * 1000;
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
        console.log("[WEBHOOK] Verified ✅");
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
    console.error("[WEBHOOK] Handler error:", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}

// ============================================================
// Определение конфига по входящему phone_number_id
// ============================================================

function getConfigByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const config = PHONE_CONFIGS[phoneNumberId];
  if (!config) {
    console.warn(`[ROUTING] ⚠️ Неизвестный phone_number_id: ${phoneNumberId}`);
    return null;
  }
  console.log(`[ROUTING] ✅ Номер определён: ${config.label} (${phoneNumberId})`);
  return config;
}

// ============================================================
// Основная обработка входящего сообщения
// ============================================================

async function handleIncomingWebhook(req) {
  try {
    const body  = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) { console.log("[WEBHOOK] No value"); return; }
    if (value.statuses) { console.log("[WEBHOOK] Status event ignored"); return; }

    // ── Определяем какой номер получил сообщение ─────────
    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    const config = getConfigByPhoneNumberId(incomingPhoneNumberId);
    if (!config) return;

    const messages = value.messages;
    if (!messages || messages.length === 0) { console.log("[WEBHOOK] No messages"); return; }

    const message     = messages[0];
    const messageId   = message.id;
    const from        = message.from;
    if (!from) return;

    const contactName = value.contacts?.[0]?.profile?.name || "";
    console.log(`[${config.label}] from=${from} name="${contactName}"`);

    if (messageId && processedMessages.has(messageId)) {
      console.log(`[WEBHOOK] Duplicate ignored: ${messageId}`);
      return;
    }
    if (messageId) {
      processedMessages.add(messageId);
      if (processedMessages.size > 500) {
        processedMessages.delete(processedMessages.values().next().value);
      }
    }

    // Ключ сессии включает phoneNumberId — чтобы один человек мог
    // писать на разные номера и иметь независимые сессии
    const sessionKey = `${incomingPhoneNumberId}:${from}`;
    const session    = getOrCreateSession(sessionKey, from);
    session.whatsappPhone = from;
    session.whatsappName  = contactName || session.whatsappName || "";

    if (message.type === "audio" || message.type === "voice") {
      await handleAudioMessage(from, message, session, config);
      return;
    }

    if (message.type !== "text") {
      const reply = getUnsupportedTypeReply(session.lang);
      appendToHistory(sessionKey, "assistant", reply);
      await saveToExcel(from, session, "bot_reply", { aiReply: reply, reason: "unsupported_type" }, config);
      await sendWhatsAppMessage(from, reply, config);
      return;
    }

    const userText = message.text?.body?.trim();
    if (!userText) return;

    console.log(`[${config.label}] IN from=${from} text="${userText}"`);

    if (session.messages.length === 0) {
      session.lang = detectLanguage(userText);
    }

    await processUserText(sessionKey, from, session, userText, config);

  } catch (error) {
    console.error("[WEBHOOK] Processing error:", error);
  }
}

// ============================================================
// Обработка аудио/голосового сообщения
// ============================================================

async function handleAudioMessage(from, message, session, config) {
  const mediaId = message.audio?.id || message.voice?.id;
  const sessionKey = `${config.PHONE_NUMBER_ID}:${from}`;

  if (!mediaId) {
    await sendWhatsAppMessage(from, getAudioErrorReply(session.lang), config);
    return;
  }

  console.log(`[${config.label}] AUDIO from=${from} mediaId=${mediaId}`);
  await sendWhatsAppMessage(from, getAudioAckReply(session.lang), config);

  try {
    const mediaUrl    = await getWhatsAppMediaUrl(mediaId, config);
    if (!mediaUrl)    { await sendWhatsAppMessage(from, getAudioErrorReply(session.lang), config); return; }

    const audioBuffer = await downloadWhatsAppMedia(mediaUrl, config);
    if (!audioBuffer) { await sendWhatsAppMessage(from, getAudioErrorReply(session.lang), config); return; }

    let transcript = null;
    if (OPENAI_API_KEY)  transcript = await transcribeWithWhisper(audioBuffer, session.lang);
    if (!transcript && GEMINI_API_KEY) transcript = await transcribeWithGemini(audioBuffer, session.lang);

    if (!transcript) { await sendWhatsAppMessage(from, getAudioTranscribeErrorReply(session.lang), config); return; }

    console.log(`[${config.label}] AUDIO_TRANSCRIPT from=${from} text="${transcript}"`);
    await sendWhatsAppMessage(from, getTranscriptNoticeReply(session.lang, transcript), config);

    if (session.messages.length === 0) session.lang = detectLanguage(transcript);
    await processUserText(sessionKey, from, session, transcript, config);

  } catch (error) {
    console.error(`[${config.label}] Audio handling error:`, error);
    await sendWhatsAppMessage(from, getAudioErrorReply(session.lang), config);
  }
}

async function getWhatsAppMediaUrl(mediaId, config) {
  if (!config.WHATSAPP_TOKEN) return null;
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` },
    });
    if (!resp.ok) { console.error(`getWhatsAppMediaUrl error: ${resp.status}`); return null; }
    return (await resp.json()).url || null;
  } catch (err) { console.error("getWhatsAppMediaUrl failed:", err); return null; }
}

async function downloadWhatsAppMedia(mediaUrl, config) {
  if (!config.WHATSAPP_TOKEN) return null;
  try {
    const resp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` } });
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
// Обработка текста
// ============================================================

async function processUserText(sessionKey, from, session, userText, config) {
  console.log(`\n╔══════════════════════════════════════════`);
  console.log(`║ [${config.label}] 📱 from=${from}`);
  console.log(`║ Текст: "${userText.substring(0, 60)}"`);
  console.log(`╚══════════════════════════════════════════\n`);

  appendToHistory(sessionKey, "user", userText);
  updateLeadDataFromText(session, userText);
  console.log("[LEAD_DATA]", JSON.stringify(session.leadData));

  await saveToExcel(from, session, "incoming_message", { userText, reason: "incoming_message" }, config);
  await syncMessageToAmoCRM(from, session, userText, "incoming_message", config);

  // Ручной тест AmoCRM
  if (/^тест\s*crm$/i.test(userText) || /^test\s*crm$/i.test(userText)) {
    const ok = await syncToAmoCRM(from, session, "manual_crm_test", config);
    const reply = ok
      ? "Тест AmoCRM выполнен: контакт и лид созданы."
      : "Тест не прошёл. Проверьте AMO_DOMAIN и AMO_TOKEN.";
    appendToHistory(sessionKey, "assistant", reply);
    await sendWhatsAppMessage(from, reply, config);
    return;
  }

  // Ручной тест Excel
  if (/^тест\s*(excel|эксель|sheet|sheets|таблица)$/i.test(userText)) {
    const saved = await saveToExcel(from, session, "manual_excel_test", { userText, reason: "manual_excel_test" }, config);
    const reply = saved
      ? "Тест Excel выполнен: данные сохранены."
      : "Тест не прошёл. Проверьте EXCEL_WEBHOOK_URL.";
    appendToHistory(sessionKey, "assistant", reply);
    await sendWhatsAppMessage(from, reply, config);
    return;
  }

  // Просьба о человеке
  if (wantsHumanAgent(userText)) {
    const reply = getHandoffReply(session.lang);
    appendToHistory(sessionKey, "assistant", reply);
    markLeadHot(sessionKey);
    await saveToExcel(from, session, "lead", { userText, aiReply: reply, reason: "human_callback_request" }, config);
    await syncToAmoCRM(from, session, "human_callback_request", config);
    session.crmNotified = true;
    await notifyManager(from, session, "human_callback_request", userText, config);
    await sendWhatsAppMessage(from, reply, config);
    return;
  }

  // AI-ответ
  const aiReply = await askAI(session, config);
  appendToHistory(sessionKey, "assistant", aiReply);

  await saveToExcel(from, session, "bot_reply", { userText, aiReply, reason: "bot_reply" }, config);

  updateLeadScore(sessionKey, userText);

  const aiSaysLeadReady = /заявк.*зафикс|оформляю.*заявк|беру.*в\s+работ|подготов.*расч[её]т|провер.*тариф|наличие.*вагон/i.test(aiReply);

  if ((session.leadScore >= 3 || aiSaysLeadReady) && !session.leadSaved) {
    const savedLead = await saveToExcel(from, session, "lead", { userText, aiReply, reason: "hot_lead" }, config);
    if (savedLead) session.leadSaved = true;

    const sentToCrm = await syncToAmoCRM(from, session, "hot_lead", config);
    if (sentToCrm) session.crmNotified = true;

    await notifyManager(from, session, "hot_lead", userText, config);
  }

  await sendWhatsAppMessage(from, aiReply, config);
}

// ============================================================
// ИИ: Claude → Gemini → fallback
// ============================================================

async function askAI(session, config) {
  if (ANTHROPIC_API_KEY) {
    const reply = await askClaude(session, config);
    if (reply) { console.log("[AI] Claude"); return reply; }
    console.warn("[AI] Claude недоступен, пробую Gemini...");
  }
  const geminiReply = await askGemini(session, config);
  if (geminiReply) { console.log("[AI] Gemini"); return geminiReply; }
  console.warn("[AI] Fallback");
  return fallbackReply(session.lang);
}

async function askClaude(session, config) {
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
        system: getSystemPrompt(session, config),
        messages: buildClaudeMessages(session),
      }),
    });
    const data = await response.json();
    if (!response.ok) { console.error("Claude API error:", JSON.stringify(data)); return null; }
    const reply = data.content?.[0]?.text?.trim();
    return reply ? limitWhatsAppText(cleanReply(reply)) : null;
  } catch (err) { console.error("Claude request failed:", err); return null; }
}

async function askGemini(session, config) {
  if (!GEMINI_API_KEY) return null;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: getSystemPrompt(session, config) }] },
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

async function amoFetch(path, method = "GET", body = null, config) {
  if (!config.AMO_DOMAIN || !config.AMO_TOKEN) {
    console.warn(`[AMO][${config.label}] ⚠️ AMO_DOMAIN или AMO_TOKEN не установлены`);
    return null;
  }
  try {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${config.AMO_TOKEN}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const fullUrl = `https://${config.AMO_DOMAIN}/api/v4${path}`;
    const resp = await fetch(fullUrl, opts);
    if (resp.status === 204) return true;
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[AMO][${config.label}] ❌ ${method} ${path} → ${resp.status}: ${errText.substring(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`[AMO][${config.label}] ❌ Запрос упал: ${path}`, err.message);
    return null;
  }
}

async function amoFindContact(phone, config) {
  const cleaned = phone.replace(/\D/g, "");
  const data = await amoFetch(`/contacts?query=${cleaned}&with=leads&limit=1`, "GET", null, config);
  return data?._embedded?.contacts?.[0] ?? null;
}

async function amoCreateContact({ name, phone, company }, config) {
  const cfv = [{ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] }];
  if (company) cfv.push({ field_code: "COMPANY", values: [{ value: company }] });
  const data = await amoFetch("/contacts", "POST", [{ name: name || phone, custom_fields_values: cfv }], config);
  return data?._embedded?.contacts?.[0] ?? null;
}

async function amoCreateLead({ title, contactId, leadData }, config) {
  const body = [{
    name: title,
    tags_to_add: [{ name: "WhatsApp" }],
    _embedded: { contacts: [{ id: contactId }] },
    ...(config.AMO_PIPELINE_ID ? { pipeline_id: Number(config.AMO_PIPELINE_ID) } : {}),
  }];
  const data = await amoFetch("/leads", "POST", body, config);
  return data?._embedded?.leads?.[0] ?? null;
}

async function amoAddNote(leadId, text, config) {
  const data = await amoFetch(`/leads/${leadId}/notes`, "POST", [{
    entity_id: leadId,
    note_type: "common",
    params: { text },
  }], config);
  return data?._embedded?.notes?.[0] ?? null;
}

async function amoFindLeadByContact(contactId, config) {
  const data = await amoFetch(`/contacts/${contactId}?with=leads`, "GET", null, config);
  const leads = data?._embedded?.leads;
  if (!leads?.length) return null;
  return leads[leads.length - 1];
}

async function syncMessageToAmoCRM(phone, session, userText, reason, config) {
  try {
    if (!config.AMO_DOMAIN || !config.AMO_TOKEN) return;
    const contact = await amoFindContact(phone, config);
    if (!contact) return;
    const lead = await amoFindLeadByContact(contact.id, config);
    if (!lead) return;
    const noteText = `[${new Date().toLocaleString("ru-RU")}] Клиент: ${userText}`;
    await amoAddNote(lead.id, noteText, config);
  } catch (err) {
    console.error(`[AMO][${config.label}] syncMessageToAmoCRM error:`, err);
  }
}

async function syncToAmoCRM(phone, session, reason = "lead", config) {
  try {
    if (!config.AMO_DOMAIN || !config.AMO_TOKEN) {
      console.error(`[AMO][${config.label}] ❌ AMO_DOMAIN или AMO_TOKEN не установлены`);
      return false;
    }

    const leadData   = session.leadData || {};
    const clientName = leadData.clientName || session.whatsappName || phone;
    const company    = leadData.company || "";

    let contact = await amoFindContact(phone, config);
    if (!contact) contact = await amoCreateContact({ name: clientName, phone, company }, config);
    if (!contact) { console.error(`[AMO][${config.label}] ❌ Не удалось создать контакт`); return false; }

    let lead = await amoFindLeadByContact(contact.id, config);
    if (!lead) lead = await amoCreateLead({ title: buildLeadTitle(leadData, clientName), contactId: contact.id, leadData }, config);
    if (!lead) { console.error(`[AMO][${config.label}] ❌ Не удалось создать лид`); return false; }

    const noteText = buildAmoNote(session, reason, leadData);
    await amoAddNote(lead.id, noteText, config);

    console.log(`[AMO][${config.label}] ✅ Контакт #${contact.id}, лид #${lead.id}`);
    return true;
  } catch (err) {
    console.error(`[AMO][${config.label}] syncToAmoCRM error:`, err.message);
    return false;
  }
}

// ============================================================
// Excel / Google Sheets
// ============================================================

async function saveToExcel(phone, session, eventType, options = {}, config) {
  if (!config.EXCEL_WEBHOOK_URL) return false;

  const dialogText = session.messages.map((m) => {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("ru-RU") : "--:--:--";
    return `[${time}] ${m.role === "assistant" ? "Бот" : "Клиент"}: ${m.content}`;
  }).join("\n");

  const payload = {
    secret:         config.EXCEL_SECRET,
    eventType,
    timestamp:      new Date().toISOString(),
    phone,
    whatsapp_phone: session.whatsappPhone || phone,
    whatsapp_name:  session.whatsappName  || "",
    lang:           session.lang,
    leadScore:      session.leadScore || 0,
    leadData:       session.leadData  || {},
    userText:       options.userText  || "",
    aiReply:        options.aiReply   || "",
    reason:         options.reason    || "",
    messages:       session.messages.filter((m) => m.role === "user").map((m) => m.content).join(" | "),
    dialogText,
    number_label:   config.label,
  };

  try {
    const resp = await fetch(config.EXCEL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) { console.error(`[EXCEL][${config.label}] ❌ ${resp.status}`); return false; }
    console.log(`[EXCEL][${config.label}] ✅ (${eventType})`);
    return true;
  } catch (err) { console.error(`[EXCEL][${config.label}] ❌`, err.message); return false; }
}

// ============================================================
// Отправка сообщения в WhatsApp
// ============================================================

async function sendWhatsAppMessage(to, body, config) {
  if (!config.WHATSAPP_TOKEN || !config.PHONE_NUMBER_ID) {
    console.error(`[WA][${config.label}] ❌ WHATSAPP_TOKEN или PHONE_NUMBER_ID отсутствуют`);
    return;
  }
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
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
    if (!resp.ok) { console.error(`[WA][${config.label}] ❌ Send error:`, JSON.stringify(data)); return; }
    console.log(`[WA][${config.label}] OUT to=${to} len=${body.length}`);
  } catch (err) { console.error(`[WA][${config.label}] ❌ sendWhatsAppMessage failed:`, err); }
}

// ============================================================
// Уведомление менеджера
// ============================================================

async function notifyManager(phone, session, reason = "hot_lead", userText = "", config) {
  if (!config.WHATSAPP_TOKEN || !config.PHONE_NUMBER_ID) return;

  const data        = session.leadData || {};
  const name        = data.clientName || session.whatsappName || "не указано";
  const isDoc       = isDocumentationRequest(session, userText);
  const targetPhone = isDoc ? config.MANAGER_PHONE_DOCS : config.MANAGER_PHONE_CARGO;
  if (!targetPhone) return;

  const topicLabel = isDoc ? "📋 Вопрос по документам" : "🚂 Новая заявка";

  const lines = [
    `🔔 ${topicLabel} [${config.label}]`,
    ``,
    `👤 Клиент: ${name}`,
    data.company ? `🏢 Компания: ${data.company}` : null,
    `📞 Телефон: +${phone}`,
    ``,
    `📦 Груз:    ${data.cargo        || "—"}`,
    `📍 Откуда:  ${data.origin       || "—"}`,
    `📍 Куда:    ${data.destination  || "—"}`,
    `⚖️ Вес:     ${data.weight       || "—"}`,
    `🚃 Вагон:   ${data.wagonType    || "—"}`,
    `📅 Дата:    ${data.shippingDate || "—"}`,
    `🏆 Score: ${session.leadScore || 0}`,
  ].filter((l) => l !== null).join("\n");

  await sendWhatsAppMessage(targetPhone, lines, config);
}

// ============================================================
// Управление сессией
// ============================================================

function getOrCreateSession(sessionKey, phone) {
  const now     = Date.now();
  let   session = conversationStore.get(sessionKey);

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
    conversationStore.set(sessionKey, session);
  } else {
    session.lastTs = now;
    if (!session.leadData) session.leadData = { routeType: "", cargo: "", origin: "", destination: "", weight: "", wagonType: "", shippingDate: "", documentsHelp: "", clientName: "", company: "" };
    if (typeof session.leadSaved === "undefined") session.leadSaved = false;
  }

  return session;
}

function appendToHistory(sessionKey, role, content) {
  const session = conversationStore.get(sessionKey);
  if (!session) return;
  session.messages.push({ role, content, timestamp: new Date().toISOString() });
  if (session.messages.length > MAX_HISTORY_TURNS * 2 + 2) {
    session.messages = [session.messages[0], ...session.messages.slice(-(MAX_HISTORY_TURNS * 2))];
  }
}

// ============================================================
// Системный промпт — по ключу из конфига
// ============================================================

function getSystemPrompt(session, config) {
  const key  = config.PROMPT_KEY || "cargo";
  const lang = session.lang || "ru";

  const langInstruction = {
    ru: "Отвечай ТОЛЬКО на русском языке. Пиши живо, по-простому, как в Казахстане.",
    kz: "Жауапты ТЕК қазақ тілінде бер. Табиғи, ауызекі тілмен жаз.",
    uz: "Faqat O'zbek tilida javob ber. Oddiy va do'stona uslubda yoz.",
  }[lang] || "Отвечай ТОЛЬКО на русском языке.";

  const profileName = session.whatsappName || "";
  const phone       = session.whatsappPhone || session.phone || "";
  const leadMemory  = buildLeadDataSummary(session);

  if (key === "cargo") {
    return `
Ты — Абай, директор логистической компании из Шымкента по грузоперевозкам GRANT CT. Железнодорожные перевозки по Казахстану и на экспорт.

ЯЗЫК: ${langInstruction}

Данные клиента:
- Номер: ${phone || "из webhook"}
- Имя: ${profileName || "не указано"}
- Телефон повторно НЕ спрашивай.

Память по заявке:
- Уже есть: ${leadMemory.knownText}
- Не хватает: ${leadMemory.missingText}

Правила:
- Никогда не задавай повторно вопросы по тому, что уже есть.
- Максимум 1–2 вопроса за раз.
- Не говори что ты бот или AI.
- Без Markdown, звёздочек, решёток.

Компания (Шымкент):
- ЖД перевозки по Казахстану и экспорт (Узбекистан, Таджикистан, Афганистан).
- Зерно, масло, сахар и другие грузы.
- Вагоны: крытый, хоппер/зерновоз, платформа, контейнер.

Данные для заявки: груз, откуда, куда, вес, тип вагона, дата отправки, документы, имя и компания.

Рабочее время: 09:00–18:00, Шымкент (UTC+5).
    `.trim();
  }

  if (key === "anara") {
    // ================================================================
    // ✏️ НАСТРОЙТЕ ЭТОТ ПРОМПТ ПОД БИЗНЕС АНАРЫ
    // ================================================================
    return `
Ты — виртуальный помощник компании OrkenAI. Твоё имя — Анара.

ЯЗЫК: ${langInstruction}

Данные клиента:
- Номер: ${phone || "из webhook"}
- Имя: ${profileName || "не указано"}
- Телефон повторно НЕ спрашивай.

Память по заявке:
- Уже есть: ${leadMemory.knownText}
- Не хватает: ${leadMemory.missingText}

Правила:
- Никогда не задавай повторно вопросы по тому, что уже есть.
- Максимум 1–2 вопроса за раз.
- Не говори что ты бот или AI.
- Без Markdown, звёздочек, решёток.
- Отвечай по существу, кратко и дружелюбно.

Рабочее время: 09:00–18:00, Алматы (UTC+6).
    `.trim();
  }

  // Дефолтный промпт если ключ не найден
  return `Ты — вежливый помощник. ЯЗЫК: ${langInstruction}. Отвечай кратко и по существу.`;
}

// ============================================================
// Вспомогательные функции (без изменений)
// ============================================================

function buildLeadTitle(leadData, clientName) {
  const parts = [];
  if (leadData.cargo)       parts.push(leadData.cargo);
  if (leadData.origin)      parts.push(leadData.origin);
  if (leadData.destination) parts.push("→ " + leadData.destination);
  return parts.length ? parts.join(" ") : `WhatsApp: ${clientName}`;
}

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
  lines.push("─── Переписка ───");
  for (const m of session.messages) {
    const who  = m.role === "assistant" ? "Бот" : "Клиент";
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("ru-RU") : "--:--:--";
    lines.push(`[${time}] ${who}: ${m.content}`);
  }
  return lines.join("\n");
}

function updateLeadDataFromText(session, text) {
  if (!session.leadData) session.leadData = { routeType: "", cargo: "", origin: "", destination: "", weight: "", wagonType: "", shippingDate: "", documentsHelp: "", clientName: "", company: "" };

  const lower = text.toLowerCase();

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк|қазақстан\s+бойынша/.test(lower))
    session.leadData.routeType = "внутренняя перевозка по Казахстану";

  const cargoMatch = lower.match(/(пшениц[ауы]?|ячмен[ья]?|кукуруз[ауы]?|рис|сахар|масл[оа]|зерно|мук[ауы]?|цемент|уголь|металл|груз|бидай|арпа|жүгері)/);
  if (cargoMatch) session.leadData.cargo = cargoMatch[0];

  const weightMatch = lower.match(/(\d+[.,]?\d*)\s*(тонн|тонна|тонны|т\b|кг|килограмм)/);
  if (weightMatch) session.leadData.weight = `${weightMatch[1]} ${weightMatch[2]}`;

  if (/хоппер|зерновоз/.test(lower))             session.leadData.wagonType = "хоппер / зерновоз";
  else if (/крыт/.test(lower))                    session.leadData.wagonType = "крытый вагон";
  else if (/платформ/.test(lower))               session.leadData.wagonType = "платформа";
  else if (/контейнер/.test(lower))              session.leadData.wagonType = "контейнер";

  if (/послезавтра/.test(lower))                  session.leadData.shippingDate = "послезавтра";
  else if (/завтра/.test(lower))                  session.leadData.shippingDate = "завтра";
  else if (/сегодня/.test(lower))                 session.leadData.shippingDate = "сегодня";
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

  const lastAssistant = getLastAssistantMessage(session);
  const assistantAskedDocs = /документ|ст-1|фито|сертификат|деклараци/i.test(lastAssistant);
  if (assistantAskedDocs && /^(нет|не нужно|не надо|без документов|жоқ)$/i.test(text.trim()))
    session.leadData.documentsHelp = "не нужна помощь с документами";
  else if (/нужн[аоы]?\s+.*документ|ст-1|фито|сертификат/.test(lower))
    session.leadData.documentsHelp = "нужна помощь с документами";

  const nameMatch = text.match(/(?:меня зовут|я\s+|имя\s+)([А-ЯЁA-ZӘІҢҒҮҰҚӨҺ][а-яёa-zәіңғүұқөһ]{2,20})/i);
  if (nameMatch) session.leadData.clientName = nameMatch[1];
  else if (!session.leadData.clientName && session.whatsappName)
    session.leadData.clientName = session.whatsappName;

  const companyMatch = text.match(/(?:компания|тоо|ип|ТОО|ИП|ЖШС)\s+([А-ЯЁA-Z0-9а-яёa-zәіңғүұқөһ\s"«»._-]{2,60})/i);
  if (companyMatch) session.leadData.company = companyMatch[0].trim();
}

function fillKnownCityRoute(session, lower) {
  const cityMap = [
    ["алматы","Алматы"],["астана","Астана"],["нур-султан","Астана"],["шымкент","Шымкент"],
    ["туркестан","Туркестан"],["кызылорда","Кызылорда"],["тараз","Тараз"],["актобе","Актобе"],
    ["атырау","Атырау"],["актау","Актау"],["костанай","Костанай"],["павлодар","Павлодар"],
    ["семей","Семей"],["усть-каменогорск","Усть-Каменогорск"],["уральск","Уральск"],
    ["ташкент","Ташкент"],["душанбе","Душанбе"],["афганистан","Афганистан"],
    ["узбекистан","Узбекистан"],["таджикистан","Таджикистан"],["термез","Термез"],
  ];
  for (const [raw, nice] of cityMap) {
    const fromRe = new RegExp(`(?:из|от)\\s+${escapeRegExp(raw)}\\b`, "i");
    const toRe   = new RegExp(`(?:в|до|на)\\s+${escapeRegExp(raw)}\\b`, "i");
    if (!session.leadData.origin      && fromRe.test(lower)) session.leadData.origin      = nice;
    if (!session.leadData.destination && toRe.test(lower))   session.leadData.destination = nice;
  }
}

function detectRouteType(session, lower = "") {
  const kzCities    = ["алматы","астана","шымкент","туркестан","кызылорда","тараз","актобе","атырау","актау","костанай","павлодар","семей","уральск"];
  const exportPlaces= ["ташкент","узбекистан","душанбе","таджикистан","афганистан","термез"];
  const origin      = normalizeForCompare(session.leadData.origin);
  const destination = normalizeForCompare(session.leadData.destination);

  if (/по\s+казахстану|внутри\s+казахстана|по\s+рк/.test(lower)) { session.leadData.routeType = "внутренняя перевозка по Казахстану"; return; }
  if (exportPlaces.some((p) => destination.includes(p)))           { session.leadData.routeType = "экспортная / международная перевозка"; return; }
  if (kzCities.some((c) => origin.includes(c)) && kzCities.some((c) => destination.includes(c))) { session.leadData.routeType = "внутренняя перевозка по Казахстану"; }
}

function buildLeadDataSummary(session) {
  const data = session.leadData || {};
  const known = [], missing = [];
  if (data.cargo)         known.push(`груз: ${data.cargo}`);         else missing.push("груз");
  if (data.origin)        known.push(`откуда: ${data.origin}`);      else missing.push("откуда");
  if (data.destination)   known.push(`куда: ${data.destination}`);   else missing.push("куда");
  if (data.weight)        known.push(`вес: ${data.weight}`);         else missing.push("вес");
  if (data.wagonType)     known.push(`вагон: ${data.wagonType}`);    else missing.push("тип вагона");
  if (data.shippingDate)  known.push(`дата: ${data.shippingDate}`);  else missing.push("дата отправки");
  if (data.clientName)    known.push(`имя: ${data.clientName}`);     else missing.push("имя");
  if (data.company)       known.push(`компания: ${data.company}`);   else missing.push("компания");
  return {
    knownText:   known.length   ? known.join("; ")   : "пока нет данных",
    missingText: missing.length ? missing.join(", ") : "все данные собраны",
  };
}

function updateLeadScore(sessionKey, userText) {
  const session = conversationStore.get(sessionKey);
  if (!session) return;
  const lower = userText.toLowerCase();
  let added = 0;
  if (/цена|стоимость|тариф|расчет|посчитай|баға/.test(lower))   added++;
  if (/маршрут|откуда|куда|шымкент|алматы|астана|ташкент/.test(lower)) added++;
  if (/вагон|контейнер|хоппер|крытый/.test(lower))               added++;
  if (/договор|заявка|оформить|отправить/.test(lower))            added++;
  if (/срочно|сегодня|завтра|дата/.test(lower))                   added++;
  if (/тонн|тонна|кг|вес/.test(lower))                           added++;
  session.leadScore += added;
}

function markLeadHot(sessionKey) {
  const session = conversationStore.get(sessionKey);
  if (session) session.leadScore = 10;
}

function getLastAssistantMessage(session) {
  const msgs = session.messages.filter((m) => m.role === "assistant");
  return msgs.length ? msgs[msgs.length - 1].content || "" : "";
}

function isDocumentationRequest(session, userText = "") {
  const lower = userText.toLowerCase();
  const docKeywords = /документ|ст-1|фито|сертификат|деклараци|инвойс|тн\s*вэд|таможн|накладн|договор|счёт/;
  return docKeywords.test(lower) || session.leadData?.documentsHelp === "нужна помощь с документами";
}

function detectLanguage(text) {
  const lower = text.toLowerCase();
  if (/[әіңғүұқөһ]/.test(lower) || /\b(сәлем|рахмет|қайда|жүк|вагон|бидай|арпа)\b/.test(lower)) return "kz";
  if (/[ʻʼ]/.test(text) || /\b(salom|rahmat|narx|yuk|vagon)\b/.test(lower)) return "uz";
  return "ru";
}

function wantsHumanAgent(text) {
  return /\b(оператор|человек|живой|перезвони|мне нужен человек|не бот|позвоните|адам|тірі)\b/i.test(text);
}

function cleanPlaceName(value) {
  return String(value || "").replace(/[.,!?;:]+$/g, "").replace(/\b(вес|нужен|тонн|вагон|стоимость|цена|расчёт).*$/i, "").replace(/\s+/g, " ").trim();
}

function normalizeForCompare(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function getUnsupportedTypeReply(lang = "ru") {
  return { ru: "Это получил, но пока текст обрабатываю лучше. Напиши текстом.", kz: "Алдым, мәтіндік хабарларды жақсы өңдеймін. Жазып жіберіңіз.", uz: "Oldim, lekin matnni yaxshiroq tushunaman. Yozing." }[lang] || "Напиши текстом.";
}

function getHandoffReply(lang = "ru") {
  return { ru: "Понял, беру в работу. Ваш номер уже сохранён. Напишите имя и компанию — зафиксирую заявку.", kz: "Түсіндім, жұмысқа алдым. Атыңыз бен компанияңызды жазыңыз.", uz: "Tushundim, ishga oldim. Ism va kompaniyangizni yozing." }[lang] || "Понял, беру в работу.";
}

function fallbackReply(lang = "ru") {
  return { ru: "Получил, зафиксирую заявку. Напишите: груз, маршрут, вес, дату отправки, имя и компанию.", kz: "Алдым, өтінімді тіркеймін. Жазыңыз: жүк, бағыт, салмақ, күн, атыңыз.", uz: "Oldim, arizani qayd qilaman. Yozing: yuk, yo'nalish, og'irlik, sana, ism." }[lang] || "Напишите: груз, маршрут, вес, дату, имя.";
}

function getAudioAckReply(lang = "ru") {
  return { ru: "Голосовое получил, сейчас прослушаю и отвечу.", kz: "Дауыстық хабарды алдым, тыңдап жатырмын.", uz: "Ovozli xabarni oldim, tinglayapman." }[lang] || "Голосовое получил.";
}

function getAudioErrorReply(lang = "ru") {
  return { ru: "Что-то пошло не так с аудио. Напиши текстом.", kz: "Аудиомен бірдеңе болды. Мәтін арқылы жазыңыз.", uz: "Audio bilan muammo. Matn orqali yozing." }[lang] || "Напишите текстом.";
}

function getAudioTranscribeErrorReply(lang = "ru") {
  return { ru: "Голосовое не разобрал. Напиши текстом.", kz: "Дауыстықты анықтай алмадым. Мәтін арқылы жазыңыз.", uz: "Ovozni tushuna olmadim. Matn orqali yozing." }[lang] || "Напишите текстом.";
}

function getTranscriptNoticeReply(lang = "ru", transcript) {
  const short = transcript.length > 120 ? transcript.substring(0, 120) + "..." : transcript;
  return { ru: `Понял: "${short}"`, kz: `Түсіндім: "${short}"`, uz: `Tushundim: "${short}"` }[lang] || `Понял: "${short}"`;
}
