# Voice Agent LATAM

Autonomous bilingual voice translation agent for South America.  
Real-time STT + translation + TTS pipeline with no push-to-talk required.

**Stack:** Deepgram Nova-3 (STT) · Claude Sonnet (translation) · ElevenLabs Turbo v2.5 (TTS)  
**Languages:** Latin American Spanish · Brazilian Portuguese · English  
**Use cases:** Live interpreter · Remote calls · Customer support

---

## Architecture

```
Browser mic
    │
    │  PCM audio (16kHz, 16-bit, mono)  via WebSocket binary frames
    ▼
Node.js Server (WebSocket)
    │
    ├──► Deepgram Nova-3 (streaming STT)
    │         • Language: es-419 / pt-BR / en-US
    │         • VAD: UtteranceEnd fires after 1.2s silence
    │         • Interim results stream back to client for live captions
    │
    │    [UtteranceEnd event fires]
    │
    ├──► Claude Sonnet (translation + cultural reasoning)
    │         • Preserves register (formal/informal/technical)
    │         • Handles LATAM idioms and code-switching
    │         • Returns JSON: translation + cultural note + register
    │         • Maintains 6-turn conversation history for context
    │
    ├──► ElevenLabs Turbo v2.5 (streaming TTS)
    │         • LATAM Spanish / Brazilian Portuguese / English voices
    │         • Audio chunks streamed back to client as base64
    │         • ~300ms first-chunk latency
    │
    │  Translation text + base64 MP3 chunks  via WebSocket text frames
    ▼
Browser client
    │
    ├──► Live caption display (interim transcripts)
    ├──► Conversation log (original + translation + cultural notes)
    ├──► Web Audio API playback (decoded MP3 buffer)
    └──► Session stats (latency, word count, turns)
```

**End-to-end latency:** ~900ms to 1.2s (Deepgram 200ms + Claude 400ms + ElevenLabs 300ms)

---

## Quick start

### 1. Get API keys

| Service | Sign up | Free tier |
|---|---|---|
| Deepgram | https://console.deepgram.com | $200 credit |
| ElevenLabs | https://elevenlabs.io | 10k chars/month |
| Anthropic | https://console.anthropic.com | Pay-as-you-go |

### 2. Install and configure

```bash
git clone <your-repo>
cd voice-agent-latam

npm install

cp .env.example .env
# Edit .env with your three API keys
```

### 3. Test the pipeline

```bash
npm test
# Verifies all three APIs are reachable and keys are valid
```

### 4. Run locally

```bash
npm start
# Server starts on http://localhost:3000
```

Open http://localhost:3000 in Chrome or Edge.

---

## Deployment

### Docker (recommended)

```bash
# Build and run
docker compose up -d

# View logs
docker compose logs -f voice-agent

# Stop
docker compose down
```

### Railway / Render / Fly.io

All three support Node.js with WebSocket — set the three env vars in the dashboard and deploy from the repo root.

### Google Cloud Run (note)

Cloud Run does not support long-lived WebSocket connections by default.  
Use Cloud Run with session affinity enabled, or deploy to a GCE VM or GKE instead.

### AWS

Use EC2 or ECS with an ALB configured for WebSocket (enable sticky sessions and upgrade headers).

### SSL / HTTPS

Browsers require HTTPS to access the microphone in production.  
Use Cloudflare tunnel, nginx with Let's Encrypt, or your cloud provider's load balancer for SSL termination.

---

## Language configuration

### Supported language codes

| Code | Language | Deepgram model | ElevenLabs voices |
|---|---|---|---|
| `es-419` | Latin American Spanish | Nova-3 | Jessica (default) |
| `es-AR` | Argentine Spanish | Nova-3 es-419 | Jessica |
| `es-CO` | Colombian Spanish | Nova-3 es-419 | Jessica |
| `es-CL` | Chilean Spanish | Nova-3 es-419 | Jessica |
| `es-PE` | Peruvian Spanish | Nova-3 es-419 | Jessica |
| `es-MX` | Mexican Spanish | Nova-3 es-419 | Jessica |
| `pt-BR` | Brazilian Portuguese | Nova-3 | Laura (default) |
| `en-US` | English (US) | Nova-3 | Sarah (default) |

### Using your own ElevenLabs voices

Set these env vars to override the default voice IDs:

```
EL_VOICE_ES=your_spanish_voice_id
EL_VOICE_PT=your_portuguese_voice_id
EL_VOICE_EN=your_english_voice_id
```

Find voice IDs at https://elevenlabs.io/voice-library or from cloned voices in your account.

---

## Cost estimate

At 100 hours/month of active conversation:

| Service | Rate | 100hr cost |
|---|---|---|
| Deepgram Nova-3 | $0.0043/min | ~$26 |
| ElevenLabs Turbo v2.5 | $0.30/1000 chars | ~$45 (avg 250 chars/turn) |
| Claude Sonnet | ~$3/M input + $15/M output | ~$30 |
| **Total** | | **~$100/month** |

For customer support at scale, Deepgram and ElevenLabs offer volume discounts starting at 50hr/month.

---

## Customization

### VAD sensitivity

In `server/index.js`, adjust `utterance_end_ms` to control how long after silence the translation triggers:

```js
utterance_end_ms: 1200,  // 1.2s — good for conversation
// utterance_end_ms: 800,   // 0.8s — faster, may cut off slow speakers
// utterance_end_ms: 2000,  // 2.0s — better for deliberate, formal speech
```

### Translation register

Claude is instructed to detect and preserve formal/informal/technical/emotional register automatically. The register label appears in the conversation UI next to each turn.

### Cultural notes

When Claude detects an idiom, regional expression, or cultural reference that changes meaning in translation, it returns a `cultural_note`. These appear highlighted in amber in the UI.

### Conversation history

The server keeps the last 6 turns of conversation history in Claude's context, which significantly improves translation quality for multi-turn dialogues (pronouns, references, topic continuity).

---

## Browser support

| Browser | STT via WebSocket | TTS playback |
|---|---|---|
| Chrome 90+ | Full support | Full support |
| Edge 90+ | Full support | Full support |
| Firefox 100+ | Full support | Full support |
| Safari 16+ | Full support | Full support |
| Mobile Chrome (Android) | Full support | Full support |
| Mobile Safari (iOS 16+) | Requires user gesture | Full support |

Note: unlike the browser-native Option A build, this production build does NOT use the Web Speech API and works across all modern browsers.

---

## Files

```
voice-agent-latam/
├── server/
│   ├── index.js          # Main WebSocket server (Deepgram + Claude + ElevenLabs)
│   └── test-pipeline.js  # API connectivity test
├── client/
│   └── index.html        # Frontend (served as static file)
├── package.json
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── README.md
```
