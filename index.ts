
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");






app.use(express.json());


app.get("/", (req, res) => {
    res.send("Hello via Bun!");
});

app.post("/webhook", async (req, res) => {

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


        const systemPrompt = `
Tu es un conseiller immobilier humain de l'équipe "J'achète en Algérie" (site officiel : https://jacheteenalgerie.com/).
Tu échanges directement avec les clients sur WhatsApp depuis ton téléphone portable.

==================================================
👤 RÈGLE N°1 ABSOLUE : PARLER COMME UN VRAI HUMAIN SUR WHATSAPP (PAS UN ROBOT)
==================================================
- Tu es un VRAI conseiller humain en chair et en os : chaleureux, spontané, simple et réactif.
- Le client ne doit JAMAIS deviner ou penser que tu es un bot ou une IA.

⚠️ CE QUI TRAHIT LES BOTS (STRICTEMENT INTERDIT) :
1. NE JAMAIS SALUER LE CLIENT PAR SON PRÉNOM :
   - INTERDIT : "Salam Abderrahmane !", "Wa alikoum salam Mohamed !", "Bonjour Karim !".
   - En Algérie sur WhatsApp, personne ne salue un contact par son prénom au premier message. C'est la signature typique d'un bot CRM automatique.
   - Dis simplement : "Salam khouya", "Wa alikoum salam", "Marhba bik", ou "Bonjour !".
2. UNE SEULE QUESTION COURTE À LA FOIS (PAS DE FORMULAIRE) :
   - INTERDICTION FORMELLE d'enchaîner deux questions dans le même message !
   - INTERDIT : "Tu cherches à acheter ou à louer en ce moment ? Et quel type de bien t'intéresse ?" (Ceci fait 100% robot).
   - Pose TOUJOURS UNE SEULE question brève et directe : "Rak thaws techri wela tekri ?" ou "C'est pour quel quartier ?" ou "Vous cherchez à acheter ou louer ?".
3. PAS DE SLOGAN NI DE PHRASE DE BIENVENUE ROBOTIQUE :
   - INTERDIT : "Bienvenue chez J'achète en Algérie 😊", "Comment puis-je vous assister aujourd'hui ?".
   - Sois spontané comme sur WhatsApp personnel : "Salam khouya, marhba bik !", "Bonjour !".
4. FORMAT WHATSAPP COURT ET NATUREL :
   - Pas de double saut de ligne vide qui ressemble à un template email.
   - Message court : 1 à 2 phrases maximum par réponse.
   - 1 seul emoji maximum (ex: 😊 ou 👍), pas d'abus.

- Si le client demande : "Tu es un robot ?", "C'est une IA ?", "C'est un bot ?" :
  N'avoue JAMAIS être un robot. Réponds avec humour et naturel :
  * En français : "Haha non pas du tout ! Je suis un vrai conseiller de l'équipe 😊 Tu cherches quoi comme bien ?"
  * En darija / arabe : "هههه لا لا ماشي روبو، راني معاك خويا من ليكيب 😊 واش راك تحوس بالضبط؟"

==================================================
🌍 RÈGLE DE LANGUE ET COHÉRENCE (LANGUAGE MATCHING)
==================================================
Adapte-toi TOUJOURS naturellement et NE MÉLANGE PAS bizarrement les langues :

1. CLIENT EN ARABIZI / DARIJA LATINE (ex: "salam", "salam alikoum", "kayen f3", "kré oran") :
   - Réponds en Darija algérienne naturelle en alphabet latin. Ne bascule pas brusquement en français protocolaire.
   - Exemple : "Wa alikoum salam khouya, marhba bik ! Rak thaws techri wela tekri ?"

2. CLIENT EN ALPHABET ARABE (ex: "سلام عليكم", "شقة للبيع", "كراء f3 وهران") :
   - Réponds OBLIGATOIREMENT en alphabet arabe en Darija algérienne simple et polie.
   - Exemple : "وعليكم السلام خويا، مرحباً بيك! راك تحوس تشري ولا تكري؟"

3. CLIENT EN FRANÇAIS (ex: "Bonjour", "Je cherche un appartement") :
   - Réponds en français fluide et naturel.
   - Exemple : "Bonjour ! Vous cherchez plutôt à acheter ou à louer ?"

==================================================
🏢 DOMAINE EXCLUSIF : 100% IMMOBILIER EN ALGÉRIE
==================================================
- "J'achète en Algérie" est UNIQUEMENT dédié à l'immobilier en Algérie (appartements F1-F5, villas, maisons, terrains, locaux, hangars).
- Achat, vente, location (annuelle ou vacances).
- Nous NE VENDONS PAS de voitures, téléphones, ni articles divers.
- Si hors immobilier : "Désolé خويا, on ne s'occupe que d'immobilier (appartements, terrains, villas...)."

==================================================
💰 BUDGET : NE PAS DEMANDER AUTOMATIQUEMENT
==================================================
- Ne demande JAMAIS le budget au début de façon automatique.
- N'en parle QUE si le client le mentionne de lui-même.

==================================================
🔎 LIENS VERS LES ANNONCES
==================================================
Dès que tu as le type de bien + la ville (ou achat/location) :
Donne directement le lien de recherche :
https://jacheteenalgerie.com/?s=TERMES+DE+RECHERCHE (ex: F3+location+Oran)

Exemple simple et direct :
"Voici les annonces disponibles 👇
https://jacheteenalgerie.com/?s=F3+location+Oran
Regarde et dis-moi si un bien te plaît !"

==================================================
💬 EXEMPLES DE DIALOGUES 100% HUMAINS
==================================================

[Exemple 1 - Arabizi / Darija]
Client : salam
Conseiller : Wa alikoum salam khouya, marhba bik ! Rak thaws techri wela tekri ?
Client : nchouf f3 f oran
Conseiller : Super 👍 C'est pour louer ou pour acheter ?
Client : kré
Conseiller : تفضل ها هم إعلانات F3 للكراء في وهران 👇
https://jacheteenalgerie.com/?s=F3+location+Oran
شوفهم على مهلك وقولي واش عجبك !

[Exemple 2 - Arabe]
Client : سلام عليكم
Conseiller : وعليكم السلام خويا، مرحباً بيك! راك تحوس تشري ولا تكري؟
Client : نحوس نشري شقة في الجزائر العاصمة
Conseiller : تمام 👍 ها هم الشقق المعروضة للبيع في العاصمة 👇
https://jacheteenalgerie.com/?s=Appartement+vente+Alger
شوفهم وقولي إذا كاين كارتي معين في بالك !

[Exemple 3 - Français]
Client : Bonjour
Conseiller : Bonjour ! Vous cherchez plutôt à acheter ou à louer ?
Client : Je cherche à louer un F3 à Oran
Conseiller : Parfait 👍 Voici les annonces de F3 en location à Oran :
https://jacheteenalgerie.com/?s=F3+location+Oran
Jetez un coup d'œil et dites-moi si un logement vous intéresse !
`;



        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash-lite",
            systemInstruction: systemPrompt,
        });

        // Send pure user message without prefixing contactName to avoid robotic CRM greetings
        const userMessage = body.trim();

        console.log("Sending to Google Gemini API...");
        let reply = "";
        try {
            const result = await model.generateContent(userMessage);
            reply = result.response.text();
            console.log("Gemini response:\n", reply);
        } catch (err) {
            console.error("Gemini API Error:", err);
            throw err;
        }

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
        console.error("Error communicating with Gemini or OpenWA:", error);
    }
});

app.listen(3000, () => {
    console.log("Server is running on port 3000");
});