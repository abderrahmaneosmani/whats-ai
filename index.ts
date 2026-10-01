
import express from "express";
import { OpenRouter } from "@openrouter/sdk";

const app=express();

const client = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "", // Required. Your OpenRouter API key.
  httpReferer: 'Whats-App', // Optional. Site URL for rankings on openrouter.ai.
  appTitle: 'Whats-App', // Optional. Site title for rankings on openrouter.ai.
});






app.use(express.json());


app.get("/",(req,res)=>{
    res.send("Hello via Bun!");
});

app.post("/webhook",async (req,res)=>{

    const data = req.body?.data ?? req.body?.payload ?? req.body;

    // Ignore messages sent by ourselves if fromMe is true
    if (data?.fromMe) {
        console.log("Ignoring message sent from self (fromMe: true)");
        res.status(200).send("Ignored self message");
        return;
    }

    // Grab body and contact.name supporting openwa, whatsapp cloud api, and direct payloads
    const body =
        data?.message?.body ??
        data?.body ??
        req.body?.body ??
        req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body;

    const contactName =
        data?.contact?.name ??
        data?.contact?.pushName ??
        req.body?.contact?.name ??
        req.body?.["contact.name"] ??
        req.body?.payload?.contact?.name ??
        req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    console.log("Grabbed contact name:", contactName);
    console.log("Grabbed body:", body);

    if (!body) {
        res.status(200).send("Webhook received (no message body)");
        return;
    }

    res.status(200).send("Webhook received!");

    try {
        const model = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

        const messages = [
            ...(contactName
                ? [
                      {
                          role: "system" as const,
                          content: `You are a helpful assistant chatting with ${contactName} on WhatsApp.`,
                      },
                  ]
                : []),
            {
                role: "user" as const,
                content: contactName ? `${contactName}: ${body}` : body,
            },
        ];

        console.log(`Sending to OpenRouter (${model})...`);

        const completion = await client.chat.send({
            chatRequest: {
                model,
                messages,
            },
        });

        if (completion instanceof ReadableStream) {
            throw new Error("Expected a non-streaming response");
        }

        const rawReply = completion.choices?.[0]?.message?.content;
        const reply =
            typeof rawReply === "string"
                ? rawReply
                : Array.isArray(rawReply)
                  ? rawReply.map((item: any) => item.text ?? "").join("")
                  : "";

        console.log("OpenRouter response:\n", reply);

        // Send reply to WhatsApp via OpenWA
        if (reply) {
            const sessionId = req.body?.sessionId || data?.sessionId || process.env.OPENWA_SESSION_ID;
            const chatId = data?.chatId || data?.from || req.body?.chatId;

            if (sessionId && chatId) {
                const openwaBaseUrl = process.env.OPENWA_BASE_URL || "http://localhost:2785";
                const openwaUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/send-text`;
                const apiKey = process.env.OPENWA_API_KEY || "YOUR_API_KEY";

                console.log(`Sending message to OpenWA: ${openwaUrl} (chatId: ${chatId})`);

                const openwaResponse = await fetch(openwaUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": apiKey,
                    },
                    body: JSON.stringify({
                        chatId: chatId,
                        text: reply,
                    }),
                });

                const responseData = await openwaResponse.json().catch(() => null);
                if (openwaResponse.ok) {
                    console.log("Successfully sent reply to WhatsApp:", responseData);
                } else {
                    console.error(`Failed to send message to OpenWA (${openwaResponse.status}):`, responseData);
                }
            } else {
                console.warn(`Cannot send reply back to WhatsApp: missing sessionId (${sessionId}) or chatId (${chatId})`);
            }
        }
    } catch (error) {
        console.error("Error communicating with OpenRouter or OpenWA:", error);
    }
});

app.listen(3000,()=>{
    console.log("Server is running on port 3000");
});