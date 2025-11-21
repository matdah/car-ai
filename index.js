const express = require('express');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
require('dotenv').config();

// Konfigurera OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Läs in samtliga bildfiler i "images"-mappen
const imagesDir = path.join(__dirname, 'images');
let imageFiles = fs.readdirSync(imagesDir).filter(file => {
    return ['.png', '.jpg', '.jpeg', '.gif'].includes(path.extname(file).toLowerCase());
});

processImages();

// Hjälpfunktion för att vänta
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Generera information om bilarna
async function processImages() {
    console.log(`Processing ${imageFiles.length} images...`);
    const carInfo = await generateAltTexts(imageFiles);

    // Skriv till en JSON-fil
    const outputPath = path.join(__dirname, 'carinfo.json');
    fs.writeFileSync(outputPath, JSON.stringify(carInfo, null, 2));

    console.log(`Car information written to ${outputPath}`);
    console.log(`Successfully processed: ${carInfo.filter(c => c.data !== null).length}/${imageFiles.length}`);
    process.exit(0);
}

// Rensa JSON från markdown-formatering
function cleanJsonResponse(raw) {
    // Ta bort ```json och ``` om de finns
    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/i, '');
    }
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '');
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.replace(/\s*```$/, '');
    }
    return cleaned.trim();
}

// Skicka bildfilerna till OpenAI med batchning
async function generateAltTexts(imageArr) {
    const results = [];
    const BATCH_SIZE = 3; // Processar 3 bilder åt gången

    // Dela upp i batchar
    for (let i = 0; i < imageArr.length; i += BATCH_SIZE) {
        const batch = imageArr.slice(i, i + BATCH_SIZE);
        console.log(`\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(imageArr.length / BATCH_SIZE)}`);

        // Processar batchen
        const batchPromises = batch.map(async (file, index) => {
            const fileNum = i + index + 1;
            console.log(`  [${fileNum}/${imageArr.length}] Processing ${file}...`);

            const filePath = path.join(imagesDir, file);
            const fileData = fs.readFileSync(filePath);
            const base64Image = fileData.toString('base64');

            const ext = path.extname(file).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

            try {
                const response = await openai.chat.completions.create({
                    model: "gpt-4o",
                    temperature: 0,
                    response_format: { type: "json_object" }, // VIKTIG: Tvingar JSON-svar
                    messages: [
                        {
                            role: "system",
                            content: `Du är en fordonsexpert. Svara ENDAST med ett giltigt JSON-objekt enligt formatet:
{
  "make": "...",
  "model": "...",
  "type": "...",
  "year": "...",
  "color": "...",
  "condition": "...",
  "estimated_value": "...",
  "description": "..."
}
Om något inte kan avgöras från bilden, använd värdet "okänt".
Svara BARA med JSON, inga andra ord eller formatering.`
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `Identifiera följande tre värden från bilden:
- Märke (make)
- Modell (model)
- Typ (type) (t.ex. "Sedan", "Kombi", "SUV", "Cabriolet")
- Årsmodell (year) (ungefärlig är okej, plus minus några år)
- Färg
- Skick (condition) (t.ex. "ny", "bra", "använd", "dåligt skick")
- Uppskattat värde (estimated_value) i svenska kronor (ungefärligt är okej)
- En kort beskrivning (description) av bilens utseende och eventuella unika egenskaper. Om bilen har skador, skriv en kort beskrivning över ungefär hur mycket det skulle kosta att reparera dem.

Kom ihåg: enbart JSON, inga andra ord.`
                                },
                                {
                                    type: "image_url",
                                    image_url: { url: `data:${mimeType};base64,${base64Image}` }
                                }
                            ]
                        }
                    ],
                    max_tokens: 500
                });

                const raw = response.choices[0].message.content;
                console.log(`  [${fileNum}/${imageArr.length}] Raw response:`, raw.substring(0, 100) + '...');

                // Rensa och parse JSON
                const cleaned = cleanJsonResponse(raw);
                let parsed = null;

                try {
                    parsed = JSON.parse(cleaned);
                    console.log(`  ✓ [${fileNum}/${imageArr.length}] Successfully parsed ${file}`);
                } catch (e) {
                    console.error(`  ✗ [${fileNum}/${imageArr.length}] Could not parse JSON from ${file}`);
                    console.error(`  Raw response: ${raw}`);
                    console.error(`  Parse error: ${e.message}`);
                }

                return {
                    filename: file,
                    data: parsed,
                };

            } catch (error) {
                console.error(`  ✗ [${fileNum}/${imageArr.length}] Error processing ${file}:`, error.message);

                // Kolla om det är rate limiting
                if (error.status === 429) {
                    console.log(`  Rate limited! Waiting 10 seconds before retry...`);
                    await sleep(10000);
                    // Försök igen
                    return await generateAltTexts([file]).then(r => r[0]);
                }

                return {
                    filename: file,
                    data: null,
                    error: error.message
                };
            }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Vänta mellan batchar för att undvika rate limiting
        if (i + BATCH_SIZE < imageArr.length) {
            console.log('  Waiting 2 seconds before next batch...');
            await sleep(2000);
        }
    }

    return results;
}