'use strict';

/**
 * Voice Translation Agent - Production Server
 * Stack: Deepgram Nova-3 (STT) + Claude Sonnet (translation) + ElevenLabs Turbo v2.5 (TTS)
 * Optimized for South America: Latin American Spanish, Brazilian Portuguese, English
 */

require('dotenv').config();
const express       = require('express');
const http          = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Anthropic     = require('@anthropic-ai/sdk');
const fetch         = require('node-fetch');
const path          = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Validate env ────────────────────────────────────────────────────────────
const REQUIRED_ENV = ['DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY'];
REQUIRED_ENV.forEach(k => {
  if (!process.env[k]) {
    console.error(`[boot] Missing required env var: ${k}`);
    process.exit(1);
  }
});

// ─── Clients ─────────────────────────────────────────────────────────────────
const deepgram  = createClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ElevenLabs voice IDs tuned for LATAM
// Replace with your own cloned/licensed voices if needed
const ELEVENLABS_VOICES = {
  'es-419': process.env.EL_VOICE_ES || 'cgSgspJ2msm6clMkjHaF', // Latin American Spanish (Jessica)
  'pt-BR':  process.env.EL_VOICE_PT || 'FGY2WhTYpPnrIDTdsKH5', // Brazilian Portuguese (Laura)
  'en-US':  process.env.EL_VOICE_EN || 'EXAVITQu4vr4xnSDxMaL', // English (Sarah)
};

// Deepgram language codes for LATAM
const DEEPGRAM_LANG = {
  'es-419': 'es-419',  // Latin American Spanish
  'pt-BR':  'pt-BR',   // Brazilian Portuguese
  'en-US':  'en-US',
  'es-AR':  'es-419',  // Argentina -> LATAM model
  'es-CO':  'es-419',  // Colombia
  'es-CL':  'es-419',  // Chile
  'es-PE':  'es-419',  // Peru
  'es-MX':  'es-419',  // Mexico
};

// ─── Express + HTTP server ────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, '../client')));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

app.get('/voices', (_req, res) => res.json(ELEVENLABS_VOICES));

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// Active sessions map: sessionId -> { deepgramConn, speakerLang, targetLang, history }
const sessions = new Map();

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  console.log(`[ws] New session: ${sessionId}`);

  const session = {
    id: sessionId,
    ws,
    deepgramConn: null,
    speakerLang: 'es-419',
    targetLang:  'en-US',
    history: [],          // conversation history for Claude context
    isStreaming: false,
    utteranceBuffer: '',
  };
  sessions.set(sessionId, session);

  // Send session ID to client
  send(ws, { type: 'session', sessionId });

  ws.on('message', async (data) => {
    try {
      // Binary = raw audio PCM from mic
      if (data instanceof Buffer || data instanceof ArrayBuffer) {
        if (session.deepgramConn && session.deepgramConn.getReadyState() === 1) {
          session.deepgramConn.send(data);
        }
        return;
      }

      // Text = control messages (JSON)
      const msg = JSON.parse(data.toString());

      switch (msg.type) {

        case 'config':
          // Client sends language pair before starting
          session.speakerLang = msg.speakerLang || 'es-419';
          session.targetLang  = msg.targetLang  || 'en-US';
          console.log(`[session:${sessionId}] config → ${session.speakerLang} ➔ ${session.targetLang}`);
          await startDeepgramStream(session);
          send(ws, { type: 'ready', message: 'Deepgram stream open. Listening...' });
          break;

        case 'swap':
          // Swap speaker and target languages mid-session
          [session.speakerLang, session.targetLang] = [session.targetLang, session.speakerLang];
          await restartDeepgramStream(session);
          send(ws, { type: 'swapped', speakerLang: session.speakerLang, targetLang: session.targetLang });
          break;

        case 'stop':
          teardownSession(session);
          break;

        case 'clear_history':
          session.history = [];
          send(ws, { type: 'history_cleared' });
          break;

        default:
          console.warn(`[session:${sessionId}] Unknown message type: ${msg.type}`);
      }

    } catch (err) {
      console.error(`[session:${sessionId}] Message error:`, err.message);
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    console.log(`[ws] Session closed: ${sessionId}`);
    teardownSession(session);
    sessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    console.error(`[ws:${sessionId}] Error:`, err.message);
  });
});

// ─── Deepgram streaming ────────────────────────────────────────────────────────
async function startDeepgramStream(session) {
  // Close any existing connection
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
  }

  const dgLang = DEEPGRAM_LANG[session.speakerLang] || session.speakerLang;

  const conn = deepgram.listen.live({
    model:               'nova-3',
    language:            dgLang,
    smart_format:        true,
    punctuate:           true,
    utterance_end_ms:    1200,        // VAD: fire UtteranceEnd after 1.2s silence
    vad_events:          true,
    interim_results:     true,
    encoding:            'linear16',
    sample_rate:         16000,
    channels:            1,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[deepgram:${session.id}] Stream open (${dgLang})`);
  });

  // Interim transcript — send to client for live caption display
  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    if (data.is_final) {
      session.utteranceBuffer += ' ' + alt.transcript;
      send(session.ws, {
        type:    'interim',
        text:    alt.transcript,
        isFinal: true,
        lang:    session.speakerLang,
      });
    } else {
      send(session.ws, {
        type:    'interim',
        text:    alt.transcript,
        isFinal: false,
        lang:    session.speakerLang,
      });
    }
  });

  // UtteranceEnd = person stopped speaking → trigger translation pipeline
  conn.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
    const text = session.utteranceBuffer.trim();
    session.utteranceBuffer = '';

    if (!text || text.length < 2) return;

    console.log(`[utterance:${session.id}] "${text}" (${session.speakerLang} → ${session.targetLang})`);

    send(session.ws, {
      type:       'utterance_complete',
      text,
      speakerLang: session.speakerLang,
    });

    await translateAndSpeak(session, text);
  });

  conn.on(LiveTranscriptionEvents.SpeechStarted, () => {
    send(session.ws, { type: 'speech_started' });
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[deepgram:${session.id}] Error:`, err);
    send(session.ws, { type: 'error', message: 'STT error: ' + JSON.stringify(err) });
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[deepgram:${session.id}] Stream closed`);
  });

  session.deepgramConn = conn;
}

async function restartDeepgramStream(session) {
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
  }
  await startDeepgramStream(session);
}

// ─── Translation + TTS pipeline ───────────────────────────────────────────────
async function translateAndSpeak(session, text) {
  if (session.isStreaming) return; // prevent overlap
  session.isStreaming = true;

  send(session.ws, { type: 'translating' });

  try {
    // Build Claude context from conversation history (last 6 turns)
    const historyMessages = session.history.slice(-6).map(h => ({
      role:    h.role,
      content: h.content,
    }));

    const speakerName = LANG_DISPLAY[session.speakerLang] || session.speakerLang;
    const targetName  = LANG_DISPLAY[session.targetLang]  || session.targetLang;

    const userPrompt = `Translate the following from ${speakerName} to ${targetName}. Return ONLY valid JSON, no markdown.

Source (${speakerName}): "${text}"

JSON format:
{
  "translation": "natural translation in ${targetName}",
  "back_translation": "literal back-translation to ${speakerName} for verification",
  "register": "formal|informal|technical|emotional",
  "cultural_note": "optional brief note if idiom/cultural context changes meaning, else empty string"
}`;

    const claudeMessages = [
      ...historyMessages,
      { role: 'user', content: userPrompt },
    ];

    const claudeResp = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 512,
      system:     buildSystemPrompt(session.speakerLang, session.targetLang),
      messages:   claudeMessages,
    });

    const rawJson = claudeResp.content[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(rawJson.replace(/```json|```/g, '').trim());
    } catch (_) {
      parsed = { translation: rawJson, register: 'neutral', cultural_note: '', back_translation: '' };
    }

    const translation  = parsed.translation   || '';
    const culturalNote = parsed.cultural_note || '';

    // Update conversation history
    session.history.push({ role: 'user',      content: userPrompt });
    session.history.push({ role: 'assistant', content: rawJson });

    // Send translation text to client immediately
    send(session.ws, {
      type:         'translation',
      original:     text,
      translation,
      register:     parsed.register,
      culturalNote,
      speakerLang:  session.speakerLang,
      targetLang:   session.targetLang,
    });

    // Stream TTS audio from ElevenLabs
    await streamTTS(session, translation, session.targetLang);

  } catch (err) {
    console.error(`[translate:${session.id}]`, err.message);
    send(session.ws, { type: 'error', message: 'Translation error: ' + err.message });
  } finally {
    session.isStreaming = false;
  }
}

// ─── ElevenLabs TTS streaming ─────────────────────────────────────────────────
async function streamTTS(session, text, lang) {
  const voiceId = ELEVENLABS_VOICES[lang] || ELEVENLABS_VOICES['en-US'];

  send(session.ws, { type: 'tts_start' });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key':    process.env.ELEVENLABS_API_KEY,
      'Content-Type':  'application/json',
      'Accept':        'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id:        'eleven_turbo_v2_5',
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.8,
        style:            0.2,
        use_speaker_boost: true,
      },
      output_format: 'mp3_44100_128',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
  }

  // Stream audio chunks to client as base64
  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(chunk);
    // Send in real-time as they arrive
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type:  'tts_chunk',
        audio: chunk.toString('base64'),
      }));
    }
  }

  send(session.ws, { type: 'tts_end' });
  console.log(`[tts:${session.id}] Streamed ${chunks.length} chunks for "${text.slice(0, 40)}..."`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function teardownSession(session) {
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
    session.deepgramConn = null;
  }
}

const LANG_DISPLAY = {
  'es-419': 'Latin American Spanish',
  'es-AR':  'Argentine Spanish',
  'es-CO':  'Colombian Spanish',
  'es-CL':  'Chilean Spanish',
  'es-PE':  'Peruvian Spanish',
  'es-MX':  'Mexican Spanish',
  'pt-BR':  'Brazilian Portuguese',
  'en-US':  'English',
};

function buildSystemPrompt(speakerLang, targetLang) {
  const speaker = LANG_DISPLAY[speakerLang] || speakerLang;
  const target  = LANG_DISPLAY[targetLang]  || targetLang;

  return `You are a real-time bilingual interpreter specialized in South American Spanish and Brazilian Portuguese.

Current session: translating from ${speaker} to ${target}.

Core rules:
- Preserve the speaker's register (formal, informal, emotional) exactly
- Handle LATAM idioms, slang, and code-switching (Spanglish/Portuñol) naturally
- For business or customer support contexts, maintain professionalism
- Translate meaning and cultural intent, not just words
- Flag idioms or cultural references that don't translate directly
- Never add unsolicited commentary outside the JSON structure
- Respond ONLY with valid JSON, no preamble, no markdown fences`;
}

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[boot] Voice Agent server running on http://localhost:${PORT}`);
  console.log(`[boot] WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
