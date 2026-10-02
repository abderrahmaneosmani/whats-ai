const fs = require('fs');

let content = fs.readFileSync('index.ts', 'utf8');

// Replace imports
content = content.replace(
    'import { OpenRouter } from "@openrouter/sdk";',
    'import { GoogleGenerativeAI } from "@google/generative-ai";'
);

// Replace client init
content = content.replace(
    /const client = new OpenRouter\(\{[\s\S]*?\}\);/,
    'const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");'
);

// Remove const model = process.env.OPENROUTER_MODEL ...
content = content.replace(
    /const model = process\.env\.OPENROUTER_MODEL \|\| "nvidia\/nemotron-3-ultra-550b-a55b:free";/,
    ''
);

// Replace LLM calling code
const oldCallingCodeRegex = /const messages = \[[\s\S]*?console\.log\("OpenRouter response:\\n", reply\);/m;

const newCallingCode = `const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemPrompt,
        });

        const userMessage = contactName ? \`\${contactName}: \${body}\` : body;

        console.log("Sending to Google Gemini API...");
        let reply = "";
        try {
            const result = await model.generateContent(userMessage);
            reply = result.response.text();
            console.log("Gemini response:\\n", reply);
        } catch (err) {
            console.error("Gemini API Error:", err);
            throw err;
        }`;

content = content.replace(oldCallingCodeRegex, newCallingCode);
content = content.replace('Error communicating with OpenRouter or OpenWA', 'Error communicating with Gemini or OpenWA');

fs.writeFileSync('index.ts', content);
console.log("Done");
