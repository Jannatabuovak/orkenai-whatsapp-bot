const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const body = req.body;

      const message =
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      if (message && message.type === "text") {
        const from = message.from;
        const text = message.text.body;

        await sendMessage(
          from,
          `Здравствуйте! Я AI-помощник OrkenAI.kz. Вы написали: ${text}\n\nЧто вас интересует?\n1. Сайт\n2. WhatsApp-бот\n3. Автоматизация\n4. Узнать стоимость`
        );
      }

      return res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
      console.error("Webhook error:", error);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}

async function sendMessage(to, body) {
  const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
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
        body
      }
    })
  });

  const data = await response.json();
  console.log("WhatsApp response:", data);
}
