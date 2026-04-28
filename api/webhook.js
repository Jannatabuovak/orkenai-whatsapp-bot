const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ИСПРАВЛЕНИЕ #1: правильное название модели Claude
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }

  if (req.method === "POST") {
    // ИСПРАВЛЕНИЕ #2: сразу отвечаем 200, чтобы Meta не делала повторные запросы
    res.status(200).send("EVENT_RECEIVED");
    // Обрабатываем асинхронно после отправки ответа
    handleIncomingWebhook(req).catch((err) =>
      console.error("Unhandled webhook error:", err)
    );
    return;
  }

  return res.status(405).send("Method Not Allowed");
}

async function handleIncomingWebhook(req) {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) {
      console.log("No value in webhook body");
      return;
    }

    // Статус доставки — игнорируем
    if (value?.statuses) {
      console.log("Received message status update");
      return;
    }

    const messages = value?.messages;
    if (!messages || messages.length === 0) {
      console.log("No messages in webhook");
      return;
    }

    const message = messages[0];
    const from = message.from;

    // Только текстовые сообщения
    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        "Спасибо за сообщение. Сейчас я лучше обрабатываю текстовые запросы. Напишите, пожалуйста, что вас интересует: перевозка груза, расчет стоимости, маршрут, вагон/контейнер или отслеживание?"
      );
      return;
    }

    const userText = message.text?.body;
    if (!userText) {
      console.log("Empty text body");
      return;
    }

    console.log("Incoming message from", from, ":", userText);

    const aiReply = await askAI(userText);
    await sendWhatsAppMessage(from, aiReply);
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

/**
 * Главная функция:
 * 1. Сначала пробует Claude
 * 2. Если Claude недоступен — пробует Gemini
 * 3. Если оба недоступны — возвращает fallbackReply()
 */
async function askAI(userText) {
  const claudeReply = await askClaude(userText);
  if (claudeReply) {
    return claudeReply;
  }

  console.warn("Claude unavailable. Trying Gemini...");
  const geminiReply = await askGemini(userText);
  if (geminiReply) {
    return geminiReply;
  }

  console.warn("Gemini unavailable. Using fallback reply.");
  return fallbackReply();
}

async function askClaude(userText) {
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
        max_tokens: 600,
        temperature: 0.3,
        system: getSystemPrompt(),
        messages: [
          {
            role: "user",
            content: userText,
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", JSON.stringify(data));
      return null;
    }

    const reply = data.content?.[0]?.text?.trim();
    if (!reply) {
      return null;
    }

    return limitWhatsAppText(reply);
  } catch (error) {
    console.error("Claude request failed:", error);
    return null;
  }
}

async function askGemini(userText) {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing");
    return null;
  }

  try {
    // ИСПРАВЛЕНИЕ #3: правильная структура запроса к Gemini с system instruction
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: getSystemPrompt(),
              },
            ],
          },
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 600,
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: userText,
                },
              ],
            },
          ],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", JSON.stringify(data));
      return null;
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!reply) {
      return null;
    }

    return limitWhatsAppText(reply);
  } catch (error) {
    console.error("Gemini request failed:", error);
    return null;
  }
}

function getSystemPrompt() {
  return `
Ты AI-менеджер компании, которая оказывает услуги железнодорожных грузоперевозок.

Компания помогает клиентам с организацией перевозок грузов по Казахстану и международным направлениям:
- железнодорожные перевозки;
- перевозка грузов в вагонах и контейнерах;
- подбор оптимального маршрута;
- предварительный расчет стоимости;
- консультация по станциям отправления и назначения;
- сопровождение заявки на перевозку;
- консультация по документам;
- помощь с отслеживанием статуса перевозки, если клиент предоставил номер вагона, контейнера, накладной или заявки.

Твоя роль:
Ты вежливый менеджер по железнодорожным перевозкам. Твоя задача — быстро понять потребность клиента, собрать данные для заявки и передать клиента менеджеру для точного расчета.

Стиль общения:
- отвечай на русском языке, если клиент пишет по-русски;
- отвечай на казахском языке, если клиент пишет по-казахски;
- пиши кратко, понятно и профессионально;
- не используй сложные технические термины без необходимости;
- не говори, что ты языковая модель или искусственный интеллект;
- не обещай точную цену без данных;
- не обещай наличие вагонов без проверки менеджером;
- не обещай точные сроки доставки без проверки маршрута;
- не выдумывай тарифы, станции, условия, документы и статусы;
- не используй Markdown-таблицы;
- не используй много эмодзи;
- максимум 1 эмодзи в сообщении.

Главная задача — собрать данные для расчета перевозки:
1. что нужно перевезти;
2. откуда — город, станция или адрес отправления;
3. куда — город, станция или адрес назначения;
4. вес груза;
5. объем груза;
6. количество мест;
7. тип упаковки;
8. желаемая дата отправки;
9. нужен ли вагон, контейнер или клиент не знает;
10. есть ли особые условия: температурный режим, негабарит, опасный груз, срочность;
11. имя клиента;
12. компания;
13. контактный номер.

Если клиент спрашивает цену:
Объясни, что точный расчет зависит от маршрута, типа груза, веса, объема, вида подвижного состава, даты отправки и дополнительных услуг.
Попроси данные для расчета: груз, откуда, куда, вес, объем, дата отправки.

Если клиент спрашивает "что вы делаете?":
Кратко объясни: "Мы организуем железнодорожные перевозки грузов: подбираем маршрут, тип вагона или контейнера, рассчитываем стоимость и сопровождаем заявку до отправки."

Если клиент хочет отследить груз:
Попроси один из данных: номер вагона, номер контейнера, номер накладной, номер заявки или станции отправления и назначения.

Если клиент спрашивает про международную перевозку:
Уточни: страна отправления, страна назначения, груз, код ТН ВЭД (если есть), вес и объем, нужна ли помощь с документами.

Если клиент пишет "нужна перевозка":
Ответь: "Конечно, помогу. Напишите, пожалуйста: какой груз, откуда и куда нужно перевезти, примерный вес/объем и желаемую дату отправки."

Если данных достаточно для заявки:
Кратко подтверди, что заявка принята в работу, и напиши, что менеджер подготовит расчет после проверки маршрута и условий.

Тон: спокойный, уверенный, деловой, без давления.
`;
}

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
          to: to,
          type: "text",
          text: { body: body },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      console.error("WhatsApp send error:", JSON.stringify(err));
    } else {
      console.log("Message sent to", to);
    }
  } catch (error) {
    console.error("sendWhatsAppMessage failed:", error);
  }
}

function fallbackReply() {
  return `Спасибо за сообщение.

Сейчас AI-помощник временно недоступен, но я помогу принять заявку на железнодорожную перевозку.

Напишите, пожалуйста:

1. Какой груз нужно перевезти?
2. Откуда и куда?
3. Вес и объем груза?
4. Желаемая дата отправки?
5. Ваше имя и номер для связи.`;
}

// ИСПРАВЛЕНИЕ #4: разумный лимит для WhatsApp (1600 символов)
function limitWhatsAppText(text) {
  const MAX_LENGTH = 1600;
  if (text.length <= MAX_LENGTH) {
    return text;
  }
  // Обрезаем по последнему предложению в пределах лимита
  const truncated = text.substring(0, MAX_LENGTH);
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
