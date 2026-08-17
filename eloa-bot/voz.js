/* Gera nota de voz da Eloá a partir de texto, com quatro APIs possíveis —
   escolha em ELOA_VOZ_PROVEDOR ('cartesia', 'gemini', 'fish' ou 'pocket').
   Geração de áudio (Gemini/Kore) e conversão pra ogg/opus testadas e
   confirmadas em 2026-08-08 (tom aprovado pelo Rubens) — ainda falta testar
   o envio real como nota de voz pelo WhatsApp (só geração de arquivo até
   agora). Fish Audio adicionado em 2026-08-13, nunca testado com chave real
   (sem crédito na conta). Pocket TTS (Kyutai) adicionado/validado em
   2026-08-14 — único 100% grátis e sem chave de API, roda local via
   `pocket-tts serve --host 0.0.0.0 --port 8000 --language portuguese`
   (precisa desse servidor rodando — não é subido automaticamente por este
   código, ver eloa-bot/pocket-tts/README.md). Benchmark real comparando
   'portuguese' vs 'portuguese_24l' (3 gerações cada, mesma frase/voz):
   'portuguese' venceu em velocidade sem perda de qualidade comprovada
   ('portuguese' ~37-58s frio / ~12-17s com servidor já quente;
   'portuguese_24l' ~61-95s frio — mais lento, sem ganho demonstrado) — por
   isso 'portuguese' é o padrão. Mesmo quente, ~12-17s por frase curta:
   longe de "baixa latência" real, mas o único provedor 100% grátis e
   funcional em português. Voz "rafael" testada e aprovada (Rubens ouviu). */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const CARTESIA_MODEL_ID = 'sonic-3.5';
const CARTESIA_VERSION = '2026-03-01';
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_VOZ = 'Kore';
const FISH_MODEL = 's2.1-pro';
const POCKET_TTS_URL = process.env.POCKET_TTS_BASE_URL ? `${process.env.POCKET_TTS_BASE_URL.replace(/\/$/, '')}/tts` : (process.env.POCKET_TTS_URL || 'http://localhost:8000/tts');
const POCKET_VOZ = process.env.POCKET_VOZ || 'rafael';

/* Troca grafia por pronúncia fonética SÓ pra fala — nunca no texto do
   WhatsApp, historico ou CRM, que continuam com a grafia oficial. Edite
   pronuncias.json pra adicionar mais marcas/modelos. */
function aplicarPronuncias(texto) {
  let dicionario;
  try { dicionario = JSON.parse(fs.readFileSync(path.join(__dirname, 'pronuncias.json'), 'utf8')); } catch { return texto; }
  let resultado = texto;
  for (const [escrito, pronuncia] of Object.entries(dicionario)) {
    resultado = resultado.replace(new RegExp(`\\b${escrito}\\b`, 'gi'), pronuncia);
  }
  return resultado;
}

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
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Cartesia respondeu ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

async function gerarAudioFish(texto) {
  const apiKey = process.env.FISH_API_KEY;
  const referenceId = process.env.FISH_VOICE_ID;
  if (!apiKey) throw new Error('FISH_API_KEY não configurada');

  const r = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify({
      text: texto,
      format: 'wav',
      ...(referenceId ? { reference_id: referenceId } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Fish Audio respondeu ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

/* Servidor local do Pocket TTS (Python, `pip install pocket-tts`, roda com
   `pocket-tts serve --language portuguese_24l`) — sem chave de API, 100%
   grátis, mas depende desse servidor estar de pé. */
async function gerarAudioPocket(texto) {
  const form = new FormData();
  form.append('text', texto);
  form.append('voice_url', POCKET_VOZ);

  let r;
  try {
    // Timeout mais alto que os outros provedores — medido em 2026-08-14: ~12-17s por frase curta com o servidor já quente (sem GPU nesta máquina). 45s dá margem sem deixar travar pra sempre.
    r = await fetch(POCKET_TTS_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new Error(`Pocket TTS inacessível em ${POCKET_TTS_URL} — o servidor local está rodando? (pocket-tts serve --language portuguese_24l): ${e.message}`);
  }
  if (!r.ok) throw new Error(`Pocket TTS respondeu ${r.status}: ${await r.text()}`);
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
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
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

/* Converte o WAV recebido das APIs de voz pro formato pedido, usando o
   ffmpeg embutido (@ffmpeg-installer/ffmpeg) — sem precisar instalar nada
   no sistema. 'ogg'/libopus é o formato real usado em produção (WhatsApp só
   reconhece como "nota de voz" nesse formato); 'mp3' é só pra ouvir fora do
   WhatsApp mais fácil (testes). */
function converterAudio(bufferWav, extensao) {
  const codec = extensao === 'mp3' ? 'libmp3lame' : 'libopus';
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpIn = path.join(os.tmpdir(), `eloa-voz-in-${Date.now()}.wav`);
    const tmpOut = path.join(os.tmpdir(), `eloa-voz-out-${Date.now()}.${extensao}`);
    fs.writeFileSync(tmpIn, bufferWav);
    execFile(ffmpegPath, ['-y', '-i', tmpIn, '-c:a', codec, '-b:a', '32k', tmpOut], (err) => {
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

async function gerarAudioBruto(texto) {
  const textoFalado = aplicarPronuncias(texto);
  const provedor = (process.env.ELOA_VOZ_PROVEDOR || '').toLowerCase();
  if (provedor === 'cartesia') return gerarAudioCartesia(textoFalado);
  if (provedor === 'gemini') return gerarAudioGemini(textoFalado);
  if (provedor === 'fish') return gerarAudioFish(textoFalado);
  if (provedor === 'pocket') return gerarAudioPocket(textoFalado);
  throw new Error(`ELOA_VOZ_PROVEDOR inválido ou não definido ("${provedor}") — use "cartesia", "gemini", "fish" ou "pocket"`);
}

/* Usada em produção — sempre ogg/opus, o único formato que o WhatsApp
   mostra como nota de voz (bolha com forma de onda). */
async function gerarNotaDeVoz(texto) {
  return converterAudio(await gerarAudioBruto(texto), 'ogg');
}

/* Só pra teste/audição fora do WhatsApp — mesma voz, formato mp3 (toca em
   qualquer player sem precisar de programa especial). Nunca usar isso pra
   mandar mensagem de verdade — produção sempre usa gerarNotaDeVoz (ogg). */
async function gerarAudioMp3ParaTeste(texto) {
  return converterAudio(await gerarAudioBruto(texto), 'mp3');
}

module.exports = { gerarNotaDeVoz, gerarAudioMp3ParaTeste };
