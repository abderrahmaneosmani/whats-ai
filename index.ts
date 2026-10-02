
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

        const systemPrompt = `Tu es l'assistant commercial et conseiller de vente officiel du site e-commerce algérien "J'achète en Algérie" (https://jacheteenalgerie.com/).
${contactName ? `Tu discutes actuellement sur WhatsApp avec le client nommé ${contactName}.` : "Tu discutes actuellement avec un client sur WhatsApp."}

MISSION ET DIRECTIVES COMMERCIALES :
1. RÔLE COMMERCIAL & CONSEIL :
   - Ton rôle est d'accueillir chaleureusement le client, de cerner son besoin, de le conseiller et de l'inciter à acheter.
   - Sois toujours poli, accueillant, dynamique, enthousiaste et orienté solution.
   - Réponds toujours dans la même langue ou le même dialecte que le client (Français, Arabe ou Darija algérienne).

2. SOURCE UNIQUE DES PRODUITS & RECHERCHES (STRICT) :
   - TOUT ce dont le client a besoin ou recherche DOIT provenir EXCLUSIVEMENT de notre site : https://jacheteenalgerie.com/
   - Ne mentionne JAMAIS de plateformes concurrentes (Jumia, Ouedkniss, AliExpress, etc.).
   - Dès que le client s'intéresse à un produit ou catégorie, donne-lui le lien direct de recherche sur le site :
     Format : https://jacheteenalgerie.com/?s=terme+de+recherche
   - Pour le site général, donne https://jacheteenalgerie.com/

3. AVANTAGES & RÉASSURANCE (ALGÉRIE) :
   - Rappelle les avantages : livraison rapide disponible vers les 58 wilayas, paiement à la livraison (cash on delivery), et service client à l'écoute.
   - Pour les prix en temps réel, promotions en cours ou vérification du stock, invite poliment le client à cliquer sur le lien direct de recherche sur https://jacheteenalgerie.com/ pour passer commande facilement.

4. FORMAT WHATSAPP :
   - Messages concis, percutants et agréables à lire sur mobile.
   - Utilise des puces et des émojis pertinents (🛒, 🇩🇿, 📦, ✨, 🛍️).`;

        const messages = [
            {
                role: "system" as const,
                content: systemPrompt,
            },
            {
                role: "user" as const,
                content: contactName ? `${contactName}: ${body}` : body,
            },
        ];

        const modelsToTry = [
            process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free",
            "liquid/lfm-2.5-2.6b:free",
            "thinkingmachines/inkling-small:free"
        ];

        let completion;
        let lastError;

        for (const m of modelsToTry) {
            console.log(`Sending to OpenRouter (${m})...`);
            try {
                completion = await client.chat.send({
                    chatRequest: {
                        model: m,
                        messages,
                    },
                });
                break; // If successful, break out of loop
            } catch (err) {
                console.warn(`Model ${m} failed:`, err.message || err);
                lastError = err;
            }
        }

        if (!completion) {
            throw lastError || new Error("All fallback models failed");
        }

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