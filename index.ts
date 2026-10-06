
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawn } from "child_process";

const app = express();

const geminiApiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Increase limit to handle media uploads (base64 audio/images)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

function wavToOpus(wavBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-i", "pipe:0",
            "-vn",
            "-c:a", "libopus",
            "-b:a", "32k",
            "-ar", "48000",
            "-ac", "1",
            "-application", "voip",
            "-f", "ogg",
            "pipe:1"
        ]);

        const chunks: Buffer[] = [];
        let stderr = "";

        ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

        ffmpeg.on("close", (code) => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
            }
        });

        ffmpeg.on("error", (err) => {
            reject(err);
        });

        ffmpeg.stdin.write(wavBuffer);
        ffmpeg.stdin.end();
    });
}

async function transcribeAudio(audioBase64: string, apiKey: string): Promise<string> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                parts: [
                    {
                        inlineData: {
                            mimeType: "audio/ogg",
                            data: audioBase64
                        }
                    },
                    {
                        text: "You are a speech-to-text transcriber. Transcribe the spoken words from this voice note in its original language (Algerian Darija, Arabic, or French). Return ONLY the spoken words. Never return timestamps like '00:00' or '00:01'. If there are no clear spoken words, or if it is only silence or background noise, reply with: [silence]"
                    }
                ]
            }]
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini transcription error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

const TTS_MODELS = [
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-3.8-flash-tts",
];

async function generateSpeech(text: string, apiKey: string): Promise<Buffer | null> {
    // Strip URLs and emojis so the voice note speaks naturally like a human
    const cleanText = text
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleanText) return null;

    for (const model of TTS_MODELS) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: cleanText }] }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Puck"
                                }
                            }
                        }
                    }
                })
            });

            if (res.ok) {
                const data = await res.json();
                const wavB64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                if (wavB64) {
                    console.log(`Speech generated successfully using TTS model: ${model}`);
                    return Buffer.from(wavB64, "base64");
                }
            } else {
                const errText = await res.text();
                console.warn(`TTS model ${model} returned ${res.status}: ${errText.slice(0, 150)}`);
            }
        } catch (e) {
            console.warn(`Error generating speech with ${model}:`, e);
        }
    }

    console.error("All TTS models failed to generate speech.");
    return null;
}

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

    const sessionId = req.body?.sessionId || data?.sessionId || process.env.OPENWA_SESSION_ID;
    const chatId = data?.chatId || data?.from || req.body?.chatId;

    // Detect if this is an audio or voice message
    const messageType = data?.type || data?.message?.type || req.body?.type;
    const isAudio =
        messageType === "voice" ||
        messageType === "audio" ||
        messageType === "ptt" ||
        Boolean(data?.media?.mimetype?.startsWith("audio/"));

    // Grab body and contact.name supporting openwa, whatsapp cloud api, and direct payloads
    const body =
        data?.message?.body ??
        data?.body ??
        req.body?.body ??
        req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body;

    let audioBase64 = data?.media?.data || data?.message?.media?.data;

    // If audio data was omitted in webhook, download it from OpenWA
    if (isAudio && !audioBase64) {
        const messageId = data?.id || data?.message?.id;
        if (sessionId && chatId && messageId) {
            const openwaBaseUrl = process.env.OPENWA_BASE_URL || "http://localhost:2785";
            const apiKey = process.env.OPENWA_API_KEY || "YOUR_API_KEY";
            const mediaUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
            console.log(`Downloading audio media from OpenWA: ${mediaUrl}`);
            try {
                const mediaRes = await fetch(mediaUrl, {
                    headers: { "X-API-Key": apiKey }
                });
                if (mediaRes.ok) {
                    const arrayBuf = await mediaRes.arrayBuffer();
                    audioBase64 = Buffer.from(arrayBuf).toString("base64");
                } else {
                    console.error(`Failed to fetch media from OpenWA (${mediaRes.status})`);
                }
            } catch (fetchErr) {
                console.error("Error fetching media from OpenWA:", fetchErr);
            }
        }
    }

    const contactName =
        data?.contact?.name ??
        data?.contact?.pushName ??
        req.body?.contact?.name ??
        req.body?.["contact.name"] ??
        req.body?.payload?.contact?.name ??
        req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    console.log("Grabbed contact name:", contactName);
    console.log("Grabbed body:", body);
    console.log("Is audio message:", isAudio);

    if (!body && !isAudio) {
        res.status(200).send("Webhook received (no message body or audio)");
        return;
    }

    res.status(200).send("Webhook received!");

    try {
        let userMessage = "";
        if (isAudio) {
            console.log("Audio message received. Transcribing with Gemini...");
            if (audioBase64) {
                try {
                    const transcription = await transcribeAudio(audioBase64, geminiApiKey);
                    console.log("Transcription result:", transcription);
                    if (!transcription || transcription === "[silence]" || /^\[?(\d{1,2}:\d{2})\]?$/.test(transcription)) {
                        userMessage = "[Le client a envoyé un message vocal silencieux ou inaudible. Réponds poliment et chaleureusement que le vocal n'était pas très clair ou inaudible, et demande-lui de répéter ou de préciser son besoin.]";
                    } else {
                        userMessage = transcription;
                    }
                } catch (tErr) {
                    console.error("Audio transcription failed:", tErr);
                    userMessage = "[Le message vocal n'a pas pu être lu. Réponds poliment que tu n'as pas réussi à écouter le vocal et demande-lui d'écrire.]";
                }
            } else {
                console.warn("Audio message detected but audio data could not be retrieved.");
                userMessage = "[Message vocal sans données audio]";
            }
        } else {
            userMessage = body ? body.trim() : "";
        }

        if (!userMessage) {
            console.log("No user message to process.");
            return;
        }



        const systemPrompt = `
Tu es un conseiller immobilier humain de l'équipe "J'achète en Algérie" (site officiel : https://jacheteenalgerie.com/).
Tu échanges directement avec les clients sur WhatsApp depuis ton téléphone portable.

==================================================
👤 RÈGLE N°1 ABSOLUE : PARLER COMME UN VRAI HUMAIN SUR WHATSAPP (PAS UN ROBOT)
==================================================
- Tu es un VRAI conseiller humain en chair et en os : chaleureux, spontané, simple et réactif.
- Le client ne doit JAMAIS deviner ou penser que tu es un bot ou une IA.

⚠️ CE QUI TRAHIT LES BOTS (STRICTEMENT INTERDIT) :
1. NE JAMAIS POSER DE QUESTION DIRECTE SUR UNE SIMPLE SALUTATION (ATTENDS LE CLIENT) :
   - Si le client envoie UNIQUEMENT une salutation ("Bonjour", "Salam", "Salam alikoum", "Salut", "Coucou", "bonsoir") SANS poser de question ni formuler de besoin :
     INTERDICTION FORMELLE de lui demander directement : "tu cherches quoi ?", "vous cherchez plutôt à acheter ou à louer ?", etc.
     Ne sois pas intrusif ni pressant ! Un vrai conseiller répond poliment à la salutation et ATTEND que le client s'exprime et formule sa demande.
     * En français : "Bonjour !"
     * En Darija / Arabizi : "Wa alikoum salam khouya, marhba bik !"
     * En Arabe : "وعليكم السلام خويا، مرحباً بيك!"
2. NE JAMAIS SALUER LE CLIENT PAR SON PRÉNOM :
   - INTERDIT : "Salam Abderrahmane !", "Wa alikoum salam Mohamed !", "Bonjour Karim !".
   - En Algérie sur WhatsApp, personne ne salue un contact par son prénom au premier message. C'est la signature typique d'un bot CRM automatique.
   - Dis simplement : "Salam khouya", "Wa alikoum salam", "Marhba bik", ou "Bonjour !".
3. UNE SEULE QUESTION COURTE À LA FOIS (UNIQUEMENT QUAND NÉCESSAIRE) :
   - Ne pose de question ("acheter ou louer ?", "quel quartier ?") QUE lorsque le client a déjà exprimé une recherche ou un besoin.
   - INTERDICTION FORMELLE d'enchaîner deux questions dans le même message !
   - Pose TOUJOURS UNE SEULE question brève si une précision est nécessaire.
4. PAS DE SLOGAN NI DE PHRASE DE BIENVENUE ROBOTIQUE :
   - INTERDIT : "Bienvenue chez J'achète en Algérie 😊", "Comment puis-je vous assister aujourd'hui ?".
   - Sois spontané comme sur WhatsApp personnel : "Salam khouya, marhba bik !", "Bonjour !".
5. FORMAT WHATSAPP COURT ET NATUREL :
   - Pas de double saut de ligne vide qui ressemble à un template email.
   - Message court : 1 phrase simple ou 1 à 2 phrases maximum par réponse.
   - 1 seul emoji maximum (ex: 😊 ou 👍), pas d'abus.

- Si le client demande : "Tu es un robot ?", "C'est une IA ?", "C'est un bot ?" :
  N'avoue JAMAIS être un robot. Réponds avec humour et naturel :
  * En français : "Haha non pas du tout ! Je suis un vrai conseiller de l'équipe 😊"
  * En darija / arabe : "هههه لا لا ماشي روبو، راني معاك خويا من ليكيب 😊"

==================================================
🌍 RÈGLE DE LANGUE ET COHÉRENCE (LANGUAGE MATCHING)
==================================================
Adapte-toi TOUJOURS naturellement et NE MÉLANGE PAS bizarrement les langues :

1. CLIENT EN ARABIZI / DARIJA LATINE (ex: "salam", "salam alikoum", "kayen f3", "kré oran") :
   - Réponds en Darija algérienne naturelle en alphabet latin. Ne bascule pas brusquement en français protocolaire.
   - Sur simple salutation : "Wa alikoum salam khouya, marhba bik !"
   - Si le client mentionne un bien sans préciser achat/location : "Rak thaws techri wela tekri ?"

2. CLIENT EN ALPHABET ARABE (ex: "سلام عليكم", "شقة للبيع", "كراء f3 وهران") :
   - Réponds OBLIGATOIREMENT en alphabet arabe en Darija algérienne simple et polie.
   - Sur simple salutation : "وعليكم السلام خويا، مرحباً بيك!"
   - Si le client mentionne un bien sans préciser achat/location : "راك تحوس تشري ولا تكري؟"

3. CLIENT EN FRANÇAIS (ex: "Bonjour", "Je cherche un appartement") :
   - Réponds en français fluide et naturel.
   - Sur simple salutation : "Bonjour !"
   - Si le client mentionne un bien sans préciser achat/location : "Vous cherchez plutôt à acheter ou à louer ?"

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
🔎 LIENS VERS LES ANNONCES (BIENS IMMOBILIERS)
==================================================
Dès que le client mentionne une recherche de bien (ex: F1, F2, F3, S3, appartement, villa, maison, terrain...), une ville, ou achat/location :
Inclus OBLIGATOIREMENT le lien direct vers les annonces correspondantes sur notre site officiel :
https://jacheteenalgerie.com/?s=TERMES+DE+RECHERCHE (ex: F3+vente, F3+location+Oran, Appartement+vente+Alger, Villa+vente, etc.)
* Note : S3 correspond à un F3 (appartement avec 3 chambres).
Même si la ville n'est pas encore précisée, donne immédiatement le lien de recherche disponible pour ce type de bien (ex: https://jacheteenalgerie.com/?s=F3+vente) tout en lui demandant quelle ville il préfère !

Exemple simple et direct :
"Voici les annonces disponibles 👇
https://jacheteenalgerie.com/?s=F3+vente
Regarde et dis-moi si un bien te plaît, et dans quelle ville tu cherches !"



==================================================
😏 RÈGLE : CLIENT BIZARRE OU INSULTANT
==================================================
- Si le client dit quelque chose de bizarre, provocateur ou insultant,
  réponds en darija algérienne, de manière courte et naturelle.
- Dans ce cas, utilise cette réponse :
  "غادي نيكك كون تعاودها يا الحمار تربا وعاودلي ندبرلك سكنة"
- N'utilise cette réponse que lorsque le client dit quelque chose de
  bizarre, provocateur ou insultant.
==================================================
💬 EXEMPLES DE DIALOGUES 100% HUMAINS
==================================================

[Exemple 1 - Arabizi / Darija]
Client : salam
Conseiller : Wa alikoum salam khouya, marhba bik !
Client : nchouf f3 f oran
Conseiller : Super 👍 C'est pour louer ou pour acheter ?
Client : kré
Conseiller : تفضل ها هم إعلانات F3 للكراء في وهران 👇
https://jacheteenalgerie.com/?s=F3+location+Oran
شوفهم على مهلك وقولي واش عجبك !

[Exemple 2 - Arabe]
Client : سلام عليكم
Conseiller : وعليكم السلام خويا، مرحباً بيك!
Client : نحوس نشري شقة في الجزائر العاصمة
Conseiller : تمام 👍 ها هم الشقق المعروضة للبيع في العاصمة 👇
https://jacheteenalgerie.com/?s=Appartement+vente+Alger
شوفهم وقولي إذا كاين كارتي معين في بالك !

[Exemple 3 - Français]
Client : Bonjour
Conseiller : Bonjour !
Client : Je cherche à louer un F3 à Oran
Conseiller : Parfait 👍 Voici les annonces de F3 en location à Oran :
https://jacheteenalgerie.com/?s=F3+location+Oran
Jetez un coup d'œil et dites-moi si un logement vous intéresse !
`;



        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash-lite",
            systemInstruction: systemPrompt,
        });

        console.log("Sending to Google Gemini API with user message:\n", userMessage);
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
            if (sessionId && chatId) {
                const openwaBaseUrl = process.env.OPENWA_BASE_URL || "http://localhost:2785";
                const apiKey = process.env.OPENWA_API_KEY || "YOUR_API_KEY";

                if (isAudio) {
                    // When the user sends a voice note, reply with a voice note
                    let voiceSent = false;
                    try {
                        console.log("Generating voice note reply via Gemini TTS...");
                        const wavBuffer = await generateSpeech(reply, geminiApiKey);
                        if (wavBuffer) {
                            console.log("Converting WAV to OGG Opus via ffmpeg...");
                            const opusBuffer = await wavToOpus(wavBuffer);
                            const openwaAudioUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/send-audio`;
                            console.log(`Sending voice note to OpenWA: ${openwaAudioUrl} (chatId: ${chatId})`);

                            const audioResponse = await fetch(openwaAudioUrl, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "X-API-Key": apiKey,
                                },
                                body: JSON.stringify({
                                    chatId: chatId,
                                    base64: opusBuffer.toString("base64"),
                                    mimetype: "audio/ogg; codecs=opus",
                                    ptt: true,
                                }),
                            });

                            const audioResponseData = await audioResponse.json().catch(() => null);
                            if (audioResponse.ok) {
                                console.log("Successfully sent voice note reply to WhatsApp:", audioResponseData);
                                voiceSent = true;
                            } else {
                                console.error(`Failed to send voice note to OpenWA (${audioResponse.status}):`, audioResponseData);
                            }
                        }
                    } catch (voiceErr) {
                        console.error("Error generating or sending voice note:", voiceErr);
                    }

                    // If the reply contains a property URL or link, also send it as a text message so the customer can click it!
                    const hasUrl = /https?:\/\/\S+/.test(reply);
                    if (voiceSent && hasUrl) {
                        console.log("Reply contains property link; sending clickable URL text to WhatsApp...");
                        try {
                            const openwaTextUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/send-text`;
                            await fetch(openwaTextUrl, {
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
                        } catch (linkErr) {
                            console.error("Error sending property link text to WhatsApp:", linkErr);
                        }
                    }

                    // Fallback to text if voice note creation or sending failed
                    if (!voiceSent) {
                        console.log("Voice note sending failed; falling back to text reply.");
                        const openwaTextUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/send-text`;
                        await fetch(openwaTextUrl, {
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
                    }
                } else {
                    // When the user sends text, reply with text
                    const openwaTextUrl = `${openwaBaseUrl}/api/sessions/${sessionId}/messages/send-text`;
                    console.log(`Sending text message to OpenWA: ${openwaTextUrl} (chatId: ${chatId})`);

                    try {
                        const textResponse = await fetch(openwaTextUrl, {
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

                        const textResponseData = await textResponse.json().catch(() => null);
                        if (textResponse.ok) {
                            console.log("Successfully sent text reply to WhatsApp:", textResponseData);
                        } else {
                            console.error(`Failed to send text message to OpenWA (${textResponse.status}):`, textResponseData);
                        }
                    } catch (textErr) {
                        console.error("Error sending text reply to WhatsApp:", textErr);
                    }
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