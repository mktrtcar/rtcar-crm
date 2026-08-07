/* Gera nota de voz da Eloá a partir de texto, com duas APIs possíveis —
   escolha em ELOA_VOZ_PROVEDOR ('cartesia' ou 'gemini'). NÃO TESTADO DE
   PONTA A PONTA ainda: falta chave de qualquer uma das duas APIs pra
   confirmar que a conversão de áudio e o envio como nota de voz no
   WhatsApp funcionam como esperado. Testar com cuidado antes de confiar
   nisso em produção. */
const { execFile } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const CARTESIA_MODEL_ID = 'sonic-3.5';
const CARTESIA_VERSION = '2026-03-01';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_VOZ = 'Kore';

async function gerarAudioCartesia(texto) {
  const apiKey = process.env.CARTESIA_API_KEY;
  const voiceId = process.env.CARTESIA_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error('CARTESIA_API_KEY ou CARTESIA_VOICE_ID não configuradas');

  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL_ID,
      transcript: texto,
      voice: { mode: 'id', id: voiceId },
      language: 'pt',
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
    }),
  });
  if (!r.ok) throw new Error(`Cartesia respondeu ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

async function gerarAudioGemini(texto) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY não configurada');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: texto }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOZ } } },
    },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Gemini TTS respondeu ${r.status}: ${await r.text()}`);

  const json = await r.json();
  const parte = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!parte?.data) throw new Error('Gemini TTS não retornou áudio: ' + JSON.stringify(json));

  const pcm = Buffer.from(parte.data, 'base64');
  // Gemini retorna PCM 16-bit mono a 24kHz sem cabeçalho WAV — monta o cabeçalho manualmente.
  return montarWavDePCM(pcm, 24000);
}

function montarWavDePCM(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/* WhatsApp só reconhece como "nota de voz" (bolha de áudio com forma de
   onda) um arquivo ogg/opus. Converte o WAV recebido das APIs de voz pra
   esse formato usando o ffmpeg embutido (@ffmpeg-installer/ffmpeg). */
function converterParaOggOpus(bufferWav) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpIn = path.join(os.tmpdir(), `eloa-voz-in-${Date.now()}.wav`);
    const tmpOut = path.join(os.tmpdir(), `eloa-voz-out-${Date.now()}.ogg`);
    fs.writeFileSync(tmpIn, bufferWav);
    execFile(ffmpegPath, ['-y', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '32k', tmpOut], (err) => {
      fs.unlink(tmpIn, () => {});
      if (err) { fs.unlink(tmpOut, () => {}); return reject(err); }
      fs.readFile(tmpOut, (err2, data) => {
        fs.unlink(tmpOut, () => {});
        if (err2) return reject(err2);
        resolve(data);
      });
    });
  });
}

async function gerarNotaDeVoz(texto) {
  const provedor = (process.env.ELOA_VOZ_PROVEDOR || '').toLowerCase();
  let wav;
  if (provedor === 'cartesia') wav = await gerarAudioCartesia(texto);
  else if (provedor === 'gemini') wav = await gerarAudioGemini(texto);
  else throw new Error(`ELOA_VOZ_PROVEDOR inválido ou não definido ("${provedor}") — use "cartesia" ou "gemini"`);
  return converterParaOggOpus(wav);
}

module.exports = { gerarNotaDeVoz };
