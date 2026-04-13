'use strict';

/**
 * Pipeline test — run before deploying to verify all three APIs are live
 * Usage: node server/test-pipeline.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fetch     = require('node-fetch');
const { createClient } = require('@deepgram/sdk');

const PASS = '\x1b[32m PASS\x1b[0m';
const FAIL = '\x1b[31m FAIL\x1b[0m';
const INFO = '\x1b[36m INFO\x1b[0m';

async function testClaude() {
  process.stdout.write('Testing Claude (Anthropic)... ');
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Translate "Hello, how are you?" to Spanish. Reply with just the translation.' }],
    });
    const text = resp.content[0]?.text || '';
    console.log(PASS, `→ "${text.trim()}"`);
    return true;
  } catch (err) {
    console.log(FAIL, err.message);
    return false;
  }
}

async function testDeepgram() {
  process.stdout.write('Testing Deepgram (STT)... ');
  try {
    const dg   = createClient(process.env.DEEPGRAM_API_KEY);
    // Use Deepgram pre-recorded transcription with a short audio URL to test key validity
    const resp = await dg.listen.prerecorded.transcribeUrl(
      { url: 'https://dpgr.am/spacewalk.wav' },
      { model: 'nova-3', language: 'en-US', smart_format: true }
    );
    const text = resp.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    console.log(PASS, `→ "${text.slice(0, 60)}..."`);
    return true;
  } catch (err) {
    console.log(FAIL, err.message);
    return false;
  }
}

async function testElevenLabs() {
  process.stdout.write('Testing ElevenLabs (TTS)... ');
  try {
    // Check voices endpoint — lightweight auth test
    const resp = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const tier = data?.subscription?.tier || 'unknown';
    console.log(PASS, `→ Account tier: ${tier}, character limit: ${data?.subscription?.character_limit?.toLocaleString() || '?'}`);
    return true;
  } catch (err) {
    console.log(FAIL, err.message);
    return false;
  }
}

async function main() {
  console.log('\n\x1b[1mVoice Agent LATAM — API Pipeline Test\x1b[0m');
  console.log('────────────────────────────────────────');

  const results = await Promise.all([
    testClaude(),
    testDeepgram(),
    testElevenLabs(),
  ]);

  const passed = results.filter(Boolean).length;
  console.log('────────────────────────────────────────');
  console.log(`\nResult: ${passed}/3 APIs healthy`);

  if (passed === 3) {
    console.log('\x1b[32mAll systems ready. Run `npm start` to launch.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log('\x1b[31mOne or more APIs failed. Check your .env keys.\x1b[0m\n');
    process.exit(1);
  }
}

main();
