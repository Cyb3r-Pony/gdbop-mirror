// Minimal RFC 5322 / MIME builder for a single UTF-8 plain-text message.
// Every header value comes from Worker configuration or server-generated
// data; nothing from the request reaches a header, which rules out header
// injection by construction. The assertion below is a second line of defence.
const assertHeaderSafe = (name, value) => {
  if (/[\r\n\u0000]/.test(value) || /[^\x20-\x7E]/.test(value)) {
    throw new Error(`unsafe header value for ${name}`);
  }
  return value;
};

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, '$&\r\n').trimEnd();
};

export const buildMime = ({ from, fromName, to, subject, text, messageId, date = new Date() }) => {
  const headers = [
    ['From', `"${assertHeaderSafe('From name', fromName).replace(/["\\]/g, '')}" <${assertHeaderSafe('From', from)}>`],
    ['To', assertHeaderSafe('To', to)],
    ['Subject', assertHeaderSafe('Subject', subject)],
    ['Date', date.toUTCString().replace('GMT', '+0000')],
    ['Message-ID', `<${assertHeaderSafe('Message-ID', messageId)}@${from.split('@')[1]}>`],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
    ['X-Auto-Response-Suppress', 'All'],
  ];
  return `${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${toBase64(text)}\r\n`;
};
