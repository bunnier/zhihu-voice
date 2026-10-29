/* Tencent Cloud TC3 signing and TextToVoice request. No credentials or text are logged. */
(() => {
  const encoder = new TextEncoder();
  const hex = data => Array.from(new Uint8Array(data), n => n.toString(16).padStart(2, '0')).join('');
  async function sha256(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
  async function hmac(key, value) {
    const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', imported, encoder.encode(value));
  }
  async function signedRequest(secretId, secretKey, body, timestamp) {
    const host = 'tts.tencentcloudapi.com', service = 'tts', date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify(body);
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${await sha256(payload)}`;
    const scope = `${date}/${service}/tc3_request`;
    const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonical)}`;
    const dateKey = await hmac(`TC3${secretKey}`, date);
    const serviceKey = await hmac(dateKey, service);
    const signingKey = await hmac(serviceKey, 'tc3_request');
    const signature = hex(await hmac(signingKey, toSign));
    return { payload, headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
      'X-TC-Action': 'TextToVoice', 'X-TC-Version': '2019-08-23', 'X-TC-Timestamp': String(timestamp)
    } };
  }
  globalThis.ZhihuVoiceTencent = { signedRequest };
})();
